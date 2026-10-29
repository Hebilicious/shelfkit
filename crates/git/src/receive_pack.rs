//! The receive-pack exchange of `git push` over smart HTTP, protocol v1: the
//! body of the `POST /git-receive-pack` request, and the report the server
//! answers with.
//!
//! The request is one pkt-line per reference update, the first carrying the
//! client's capabilities after a NUL, a flush, then the pack. ShelfKit asks
//! for `report-status` and no side-band, so the answer is plain pkt-lines:
//! `unpack ok`, then `ok <ref>` or `ng <ref> <reason>` for each update.

use crate::object::ObjectId;
use crate::pktline::{self, Packet, Reader};
use crate::{Error, Result};

/// What the client says it is.
pub const AGENT: &str = concat!("agent=shelfkit/", env!("CARGO_PKG_VERSION"));

/// The capabilities a request asks for.
const CAPABILITIES: &str = "report-status";

/// One reference update: from `old` (the zero id to create it) to `new`
/// (the zero id to delete it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub old: ObjectId,
    pub new: ObjectId,
    pub name: String,
}

/// The body of a `git-receive-pack` POST: the updates, then `pack`, which is
/// left out when empty (a request that only deletes sends no pack).
pub fn request(updates: &[Update], pack: &[u8]) -> Result<Vec<u8>> {
    if updates.is_empty() {
        return Err(Error::invalid(
            "<request>",
            "a push updates at least one reference",
        ));
    }
    let mut body = Vec::new();
    for (index, update) in updates.iter().enumerate() {
        check_reference(&update.name)?;
        let mut line = format!("{} {} {}", update.old, update.new, update.name);
        if index == 0 {
            line.push('\0');
            line.push_str(CAPABILITIES);
            line.push(' ');
            line.push_str(AGENT);
        }
        line.push('\n');
        pktline::write(&mut body, line.as_bytes())?;
    }
    body.extend_from_slice(pktline::FLUSH);
    body.extend_from_slice(pack);
    Ok(body)
}

/// Check a full reference name (`refs/heads/main`) as `git check-ref-format`
/// does.
pub fn check_reference(name: &str) -> Result<()> {
    let refuse = |reason: &str| Err(Error::invalid(name, reason));
    if !name.starts_with("refs/") {
        return refuse("a reference name starts with `refs/`");
    }
    if name.ends_with('/') || name.ends_with('.') || name.ends_with(".lock") {
        return refuse("a reference name cannot end with `/`, `.`, or `.lock`");
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return refuse("a reference name cannot contain `..`, `@{`, or `//`");
    }
    if name.chars().any(|c| {
        c.is_ascii_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    }) {
        return refuse(
            "a reference name cannot contain a control character, a space, or any of `~^:?*[\\`",
        );
    }
    if name
        .split('/')
        .any(|component| component.starts_with('.') || component.ends_with(".lock"))
    {
        return refuse("a reference name's components cannot start with `.` or end with `.lock`");
    }
    Ok(())
}

/// What the server did with a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    /// Whether it unpacked the pack, or why not.
    pub unpack: Result<(), String>,
    /// Each reference update, in the order reported.
    pub refs: Vec<RefStatus>,
}

impl Report {
    /// Whether the pack was unpacked and every update applied.
    pub fn is_ok(&self) -> bool {
        self.unpack.is_ok() && self.refs.iter().all(|reference| reference.result.is_ok())
    }
}

/// One reference update's outcome: applied, or refused and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefStatus {
    pub name: String,
    pub result: Result<(), String>,
}

/// Read a receive-pack answer. A report inside side-band 64k framing is read
/// too: band 1 carries it, band 2 (progress) is skipped, and band 3 is a
/// fatal error, returned as [`Error::Remote`].
pub fn parse_report(body: &[u8]) -> Result<Report> {
    let mut reader = Reader::new(body);
    let side_band = matches!(
        reader.clone().next_packet()?,
        Some(Packet::Data([1..=3, ..]))
    );
    if !side_band {
        return report(reader);
    }
    let mut inner = Vec::new();
    while let Some(packet) = reader.next_packet()? {
        match packet {
            Packet::Flush => break,
            Packet::Data([1, data @ ..]) => inner.extend_from_slice(data),
            Packet::Data([2, ..]) => {}
            Packet::Data([3, message @ ..]) => {
                return Err(Error::Remote {
                    message: String::from_utf8_lossy(message).trim_end().to_owned(),
                });
            }
            _ => {
                return Err(Error::malformed(
                    "report",
                    "a side-band packet names no band",
                ));
            }
        }
    }
    report(Reader::new(&inner))
}

fn report(mut reader: Reader<'_>) -> Result<Report> {
    let mut unpack = None;
    let mut refs = Vec::new();
    while let Some(packet) = reader.next_packet()? {
        let line = match packet {
            Packet::Flush => break,
            Packet::Delim => continue,
            Packet::Data(data) => String::from_utf8_lossy(data),
        };
        let line = line.strip_suffix('\n').unwrap_or(&line);
        if unpack.is_none() {
            let status = line.strip_prefix("unpack ").ok_or_else(|| {
                Error::malformed("report", format!("`{line}` is not an `unpack` status"))
            })?;
            unpack = Some(if status == "ok" {
                Ok(())
            } else {
                Err(status.to_owned())
            });
        } else if let Some(name) = line.strip_prefix("ok ") {
            refs.push(RefStatus {
                name: name.to_owned(),
                result: Ok(()),
            });
        } else if let Some(rest) = line.strip_prefix("ng ") {
            let (name, reason) = rest.split_once(' ').unwrap_or((rest, "refused"));
            refs.push(RefStatus {
                name: name.to_owned(),
                result: Err(reason.to_owned()),
            });
        } else if !line.starts_with("option ") {
            // `option` lines belong to `report-status-v2`, and describe an
            // update already reported.
            return Err(Error::malformed(
                "report",
                format!("`{line}` is not a reference status"),
            ));
        }
    }
    let unpack = unpack.ok_or_else(|| Error::malformed("report", "it is empty"))?;
    Ok(Report { unpack, refs })
}

/// A receive-pack request, as a server reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedRequest {
    pub updates: Vec<Update>,
    pub capabilities: Vec<String>,
    /// The pack, empty when the request sent none.
    pub pack: Vec<u8>,
}

/// Read a receive-pack request as a server does: the updates and the first
/// one's capabilities, up to the flush, then the pack: for a host that
/// stores a repository itself ([`serve`](crate::serve)), or a test double.
pub fn parse_request(body: &[u8]) -> Result<ReceivedRequest> {
    let mut reader = Reader::new(body);
    let mut updates = Vec::new();
    let mut capabilities = Vec::new();
    loop {
        let line = match reader.next_packet()? {
            Some(Packet::Data(data)) => data,
            Some(Packet::Flush) => break,
            Some(Packet::Delim) | None => {
                return Err(Error::malformed(
                    "request",
                    "the updates do not end with a flush",
                ));
            }
        };
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = match line.iter().position(|&byte| byte == 0) {
            Some(nul) if updates.is_empty() => {
                capabilities = String::from_utf8_lossy(&line[nul + 1..])
                    .split(' ')
                    .filter(|capability| !capability.is_empty())
                    .map(str::to_owned)
                    .collect();
                &line[..nul]
            }
            _ => line,
        };
        let line = std::str::from_utf8(line)
            .map_err(|_| Error::malformed("request", "an update is not UTF-8"))?;
        let what = || format!("request, update {}", updates.len() + 1);
        let mut fields = line.splitn(3, ' ');
        let mut id = || {
            fields
                .next()
                .and_then(|text| text.parse::<ObjectId>().ok())
                .ok_or_else(|| {
                    Error::malformed(what(), format!("`{line}` is not `<old> <new> <ref>`"))
                })
        };
        let old = id()?;
        let new = id()?;
        let name = fields
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| Error::malformed(what(), "no reference name"))?
            .to_owned();
        updates.push(Update { old, new, name });
    }
    if updates.is_empty() {
        return Err(Error::malformed("request", "it updates no reference"));
    }
    Ok(ReceivedRequest {
        updates,
        capabilities,
        pack: reader.rest().to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::{Kind, object_id};

    fn update() -> Update {
        Update {
            old: ObjectId::ZERO,
            new: object_id(Kind::Blob, b"x"),
            name: "refs/heads/main".to_owned(),
        }
    }

    #[test]
    fn a_request_reads_back() {
        let second = Update {
            old: object_id(Kind::Blob, b"a"),
            new: ObjectId::ZERO,
            name: "refs/heads/old".to_owned(),
        };
        let body = request(&[update(), second.clone()], b"PACK...").unwrap();
        let first = format!(
            "{} {} refs/heads/main\0report-status agent=shelfkit/{}\n",
            ObjectId::ZERO,
            update().new,
            env!("CARGO_PKG_VERSION")
        );
        let expected = format!("{:04x}{first}", first.len() + 4);
        assert!(body.starts_with(expected.as_bytes()), "{body:?}");
        let read = parse_request(&body).unwrap();
        assert_eq!(read.updates, [update(), second]);
        assert_eq!(read.capabilities, ["report-status", AGENT]);
        assert_eq!(read.pack, b"PACK...");
    }

    #[test]
    fn refuses_bad_reference_names() {
        for name in [
            "main",
            "refs/heads/",
            "refs/heads/a..b",
            "refs/heads/a b",
            "refs/heads/.hidden",
            "refs/heads/x.lock",
            "refs/heads/a@{1}",
            "refs/heads//a",
            "refs/heads/a\nb",
        ] {
            assert!(check_reference(name).is_err(), "{name:?}");
        }
        assert!(check_reference("refs/heads/main").is_ok());
        assert!(check_reference("refs/heads/feature/x-1").is_ok());
        assert!(request(&[], b"").is_err());
    }

    fn lines(lines: &[&str]) -> Vec<u8> {
        let mut body = Vec::new();
        for line in lines {
            pktline::write(&mut body, line.as_bytes()).unwrap();
        }
        body.extend_from_slice(pktline::FLUSH);
        body
    }

    #[test]
    fn reads_a_report() {
        let report = parse_report(&lines(&[
            "unpack ok\n",
            "ok refs/heads/main\n",
            "ng refs/heads/other non-fast-forward\n",
        ]))
        .unwrap();
        assert_eq!(report.unpack, Ok(()));
        assert_eq!(report.refs[0].result, Ok(()));
        assert_eq!(report.refs[1].name, "refs/heads/other");
        assert_eq!(report.refs[1].result, Err("non-fast-forward".to_owned()));
        assert!(!report.is_ok());

        let failed = parse_report(&lines(&["unpack index-pack abnormal exit\n"])).unwrap();
        assert_eq!(failed.unpack, Err("index-pack abnormal exit".to_owned()));
        assert!(parse_report(b"").is_err());
        assert!(parse_report(&lines(&["hello\n"])).is_err());
    }

    #[test]
    fn reads_a_report_in_side_band() {
        let inner = lines(&["unpack ok\n", "ok refs/heads/main\n"]);
        let mut body = Vec::new();
        pktline::write(&mut body, b"\x02Resolving deltas\n").unwrap();
        let (first, second) = inner.split_at(7);
        for part in [first, second] {
            let mut packet = vec![1];
            packet.extend_from_slice(part);
            pktline::write(&mut body, &packet).unwrap();
        }
        body.extend_from_slice(pktline::FLUSH);
        let report = parse_report(&body).unwrap();
        assert!(report.is_ok());
        assert_eq!(report.refs[0].name, "refs/heads/main");

        let mut fatal = Vec::new();
        pktline::write(&mut fatal, b"\x03repository is read-only\n").unwrap();
        assert_eq!(
            parse_report(&fatal).unwrap_err(),
            Error::Remote {
                message: "repository is read-only".to_owned()
            }
        );
    }
}
