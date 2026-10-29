//! The reference advertisement of Git's smart HTTP protocol, as a client
//! reads it: the body of `GET info/refs?service=<service>`, which says where
//! each branch and tag of a repository is.
//!
//! The body is a `# service=<service>` pkt-line and a flush, then one
//! pkt-line per reference, `<id> <name>`, the first carrying the server's
//! capabilities after a NUL, then a flush. An annotated tag is followed by
//! its peeled line, `<id> <name>^{}`, naming the object the tag points at.
//! A repository with no reference sends `<zero id> capabilities^{}` and its
//! capabilities alone. A server asked for protocol v1 starts the list with
//! `version 1`; protocol v2, which a client gets only by asking for it
//! (`Git-Protocol: version=2`), advertises no references and is refused.

use crate::object::ObjectId;
use crate::pktline::{Packet, Reader};
use crate::{Error, Result};

/// What a server advertised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Advertisement {
    /// Every reference, in the order advertised: `HEAD` first when the
    /// server lists it, then branches and tags by name.
    pub refs: Vec<AdvertisedRef>,
    /// The capabilities the first line carried.
    pub capabilities: Vec<String>,
}

/// One advertised reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdvertisedRef {
    pub name: String,
    pub id: ObjectId,
    /// For an annotated tag, the object it points at, from its `^{}` line.
    pub peeled: Option<ObjectId>,
}

/// The suffix of a peeled line's name.
const PEELED: &str = "^{}";

/// Read the body of `GET info/refs?service=<service>`, protocol v0 or v1.
/// The `# service=` section is optional, so the output of `git upload-pack
/// --advertise-refs` reads too.
pub fn parse_advertisement(body: &[u8]) -> Result<Advertisement> {
    let mut reader = Reader::new(body);
    let mut lines = Vec::new();
    let mut service = false;
    loop {
        match reader.next_packet()? {
            Some(Packet::Data(data))
                if !service && lines.is_empty() && data.starts_with(b"# service=") =>
            {
                if reader.next_packet()? != Some(Packet::Flush) {
                    return Err(Error::malformed(
                        "advertisement",
                        "the `# service=` line is not followed by a flush",
                    ));
                }
                service = true;
            }
            Some(Packet::Data(data)) => lines.push(data),
            Some(Packet::Flush) => break,
            Some(Packet::Delim) => {
                return Err(Error::malformed(
                    "advertisement",
                    "a delimiter belongs to protocol v2",
                ));
            }
            None => {
                return Err(Error::malformed(
                    "advertisement",
                    "the references do not end with a flush",
                ));
            }
        }
    }
    if !reader.rest().is_empty() {
        return Err(Error::malformed(
            "advertisement",
            "bytes follow the flush that ends the references",
        ));
    }

    let mut advertisement = Advertisement {
        refs: Vec::new(),
        capabilities: Vec::new(),
    };
    let mut first = true;
    for (number, data) in lines.into_iter().enumerate() {
        let what = || format!("advertisement, line {}", number + 1);
        let data = data.strip_suffix(b"\n").unwrap_or(data);
        let line = match data.iter().position(|&byte| byte == 0) {
            Some(nul) if first => {
                advertisement.capabilities = String::from_utf8_lossy(&data[nul + 1..])
                    .split(' ')
                    .filter(|capability| !capability.is_empty())
                    .map(str::to_owned)
                    .collect();
                &data[..nul]
            }
            Some(_) => {
                return Err(Error::malformed(
                    what(),
                    "only the first line has capabilities",
                ));
            }
            None => data,
        };
        let line =
            std::str::from_utf8(line).map_err(|_| Error::malformed(what(), "it is not UTF-8"))?;
        if first && line.starts_with("version ") {
            if line != "version 1" {
                return Err(Error::malformed(
                    what(),
                    format!("`{line}` is not protocol v0 or v1"),
                ));
            }
            continue;
        }
        let was_first = std::mem::replace(&mut first, false);
        // A shallow repository lists the commits its history stops at; a
        // client reading references has no use for them.
        if line.starts_with("shallow ") {
            continue;
        }
        let (id, name) = line
            .split_once(' ')
            .filter(|(_, name)| !name.is_empty())
            .ok_or_else(|| Error::malformed(what(), format!("`{line}` is not `<id> <name>`")))?;
        let id = id
            .parse::<ObjectId>()
            .map_err(|_| Error::malformed(what(), format!("`{id}` is not an object id")))?;
        if was_first && name == "capabilities^{}" && id.is_zero() {
            continue;
        }
        if let Some(tag) = name.strip_suffix(PEELED) {
            let previous = advertisement
                .refs
                .last_mut()
                .filter(|previous| previous.name == tag && previous.peeled.is_none())
                .ok_or_else(|| {
                    Error::malformed(
                        what(),
                        format!("`{name}` does not follow the reference `{tag}`"),
                    )
                })?;
            previous.peeled = Some(id);
            continue;
        }
        advertisement.refs.push(AdvertisedRef {
            name: name.to_owned(),
            id,
            peeled: None,
        });
    }
    Ok(advertisement)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pktline::{self, FLUSH};

    fn body(service: bool, lines: &[&str]) -> Vec<u8> {
        let mut body = Vec::new();
        if service {
            pktline::write(&mut body, b"# service=git-upload-pack\n").unwrap();
            body.extend_from_slice(FLUSH);
        }
        for line in lines {
            pktline::write(&mut body, line.as_bytes()).unwrap();
        }
        body.extend_from_slice(FLUSH);
        body
    }

    fn id(digit: char) -> String {
        digit.to_string().repeat(40)
    }

    fn reference(name: &str, digit: char, peeled: Option<char>) -> AdvertisedRef {
        AdvertisedRef {
            name: name.to_owned(),
            id: id(digit).parse().unwrap(),
            peeled: peeled.map(|digit| id(digit).parse().unwrap()),
        }
    }

    #[test]
    fn reads_references_capabilities_and_peeled_tags() {
        let advertised = parse_advertisement(&body(
            true,
            &[
                &format!(
                    "{} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/2.56.0\n",
                    id('1')
                ),
                &format!("{} refs/heads/main\n", id('1')),
                &format!("{} refs/tags/v1.0.0\n", id('2')),
                &format!("{} refs/tags/v1.0.0^{{}}\n", id('3')),
                &format!("{} refs/tags/v1.1.0\n", id('1')),
            ],
        ))
        .unwrap();
        assert_eq!(
            advertised.refs,
            [
                reference("HEAD", '1', None),
                reference("refs/heads/main", '1', None),
                reference("refs/tags/v1.0.0", '2', Some('3')),
                reference("refs/tags/v1.1.0", '1', None),
            ]
        );
        assert_eq!(
            advertised.capabilities,
            [
                "multi_ack",
                "symref=HEAD:refs/heads/main",
                "agent=git/2.56.0"
            ]
        );
    }

    #[test]
    fn reads_an_empty_repository_protocol_v1_and_no_service_line() {
        let empty = parse_advertisement(&body(
            true,
            &[&format!("{} capabilities^{{}}\0report-status\n", id('0'))],
        ))
        .unwrap();
        assert_eq!(empty.refs, []);
        assert_eq!(empty.capabilities, ["report-status"]);

        let v1 = parse_advertisement(&body(
            true,
            &[
                "version 1\n",
                &format!("{} refs/heads/main\0agent=x\n", id('4')),
            ],
        ))
        .unwrap();
        assert_eq!(v1.refs, [reference("refs/heads/main", '4', None)]);
        assert_eq!(v1.capabilities, ["agent=x"]);

        let bare = parse_advertisement(&body(false, &[&format!("{} refs/heads/main\n", id('5'))]))
            .unwrap();
        assert_eq!(bare.refs, [reference("refs/heads/main", '5', None)]);
        assert_eq!(bare.capabilities, Vec::<String>::new());
        assert_eq!(parse_advertisement(FLUSH).unwrap().refs, []);
    }

    #[test]
    fn refuses_what_is_not_an_advertisement() {
        let main = format!("{} refs/heads/main\n", id('1'));
        let mut cut = body(true, &[&main]);
        cut.truncate(cut.len() - FLUSH.len());
        let mut trailing = body(true, &[&main]);
        trailing.extend_from_slice(b"PACK");
        for (bytes, reason) in [
            (cut, "do not end with a flush"),
            (trailing, "bytes follow"),
            (body(true, &["version 2\n"]), "not protocol v0 or v1"),
            (body(true, &["nonsense\n"]), "is not `<id> <name>`"),
            (body(true, &["xyz refs/heads/main\n"]), "not an object id"),
            (
                body(true, &[&format!("{} refs/tags/v1^{{}}\n", id('1'))]),
                "does not follow",
            ),
            (
                body(true, &[&main, &format!("{} refs/heads/x\0caps\n", id('2'))]),
                "only the first line",
            ),
            (b"000200".to_vec(), "not supported"),
        ] {
            let error = parse_advertisement(&bytes).unwrap_err();
            assert!(error.reason().contains(reason), "{reason}: {error}");
        }
    }
}
