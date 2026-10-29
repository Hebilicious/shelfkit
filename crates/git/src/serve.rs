//! The server's side of Git's smart HTTP protocol, versions 0 and 1, for a
//! host that stores a repository itself: what it answers to `git clone`,
//! `fetch`, and `push`. A client that asks for protocol v2 falls back to
//! this when the answer does not speak it.
//!
//! The host keeps the objects and the references and decides every update;
//! this module reads the requests and writes the answers:
//!
//! - [`advertise`]: the body of `GET info/refs?service=<service>`.
//! - [`parse_upload_request`] and [`upload_response`]: `POST
//!   git-upload-pack`, a clone or a fetch. The host walks its objects between
//!   the two: the wanted commits, less what the client has, cut at the depth
//!   it asked for.
//! - [`receive_pack::parse_request`](crate::receive_pack::parse_request) and
//!   [`status_report`]: `POST git-receive-pack`, a push.
//!
//! upload-pack offers `shallow` (`--depth`), the `symref` of `HEAD`, and
//! nothing else: without `multi_ack`, `side-band`, `thin-pack`, or
//! `ofs-delta`, negotiation is the basic one and the pack follows the
//! acknowledgements bare, every object whole. receive-pack offers
//! `report-status`, `delete-refs`, `ofs-delta`, and `no-thin`, so a pushed
//! pack holds every object it needs.

use crate::object::ObjectId;
use crate::pktline::{self, Packet, Reader};
use crate::receive_pack::{AGENT, RefStatus};
use crate::{Error, Result};

/// The two services of smart HTTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    /// `git-upload-pack`: clone and fetch.
    UploadPack,
    /// `git-receive-pack`: push.
    ReceivePack,
}

impl Service {
    pub fn name(self) -> &'static str {
        match self {
            Self::UploadPack => "git-upload-pack",
            Self::ReceivePack => "git-receive-pack",
        }
    }

    fn capabilities(self) -> &'static str {
        match self {
            Self::UploadPack => "shallow",
            Self::ReceivePack => "report-status delete-refs ofs-delta no-thin",
        }
    }
}

/// The body of `GET info/refs?service=<service>`: every reference, the first
/// carrying the capabilities. upload-pack lists `HEAD` first when `head`
/// names a reference among `refs`, and says which with `symref`. A
/// repository with no reference advertises its capabilities alone.
pub fn advertise(
    service: Service,
    refs: &[(String, ObjectId)],
    head: Option<&str>,
) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    pktline::write(
        &mut body,
        format!("# service={}\n", service.name()).as_bytes(),
    )?;
    body.extend_from_slice(pktline::FLUSH);

    let mut capabilities = format!("{} {AGENT}", service.capabilities());
    let mut lines: Vec<(String, ObjectId)> = Vec::new();
    if service == Service::UploadPack
        && let Some((name, id)) = head.and_then(|head| refs.iter().find(|(name, _)| name == head))
    {
        capabilities = format!("{capabilities} symref=HEAD:{name}");
        lines.push(("HEAD".to_owned(), *id));
    }
    for (name, id) in refs {
        crate::receive_pack::check_reference(name)?;
        lines.push((name.clone(), *id));
    }
    if lines.is_empty() {
        lines.push(("capabilities^{}".to_owned(), ObjectId::ZERO));
    }
    for (index, (name, id)) in lines.iter().enumerate() {
        let line = if index == 0 {
            format!("{id} {name}\0{capabilities}\n")
        } else {
            format!("{id} {name}\n")
        };
        pktline::write(&mut body, line.as_bytes())?;
    }
    body.extend_from_slice(pktline::FLUSH);
    Ok(body)
}

/// A `git-upload-pack` request, as a server reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRequest {
    /// The commits the client wants.
    pub wants: Vec<ObjectId>,
    /// What the first `want` asked for.
    pub capabilities: Vec<String>,
    /// The commits the client's shallow clone stops at.
    pub shallows: Vec<ObjectId>,
    /// `deepen <depth>`: how many commits deep the client wants its history.
    pub depth: Option<u32>,
    /// The commits the client has, in the order it sent them.
    pub haves: Vec<ObjectId>,
    /// What follows the wants.
    pub negotiation: Negotiation,
}

/// What a request carries after its wants, which decides what it is answered
/// with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Negotiation {
    /// Nothing: a client asking for a depth sends its wants alone first, and
    /// reads the shallow section before it says what it has.
    None,
    /// Haves, then a flush: another round follows.
    Round,
    /// `done`: the client waits for the pack.
    Done,
}

impl UploadRequest {
    /// Whether the answer starts with the shallow section: the client asked
    /// for a depth, or its clone is shallow already.
    pub fn deepens(&self) -> bool {
        self.depth.is_some() || !self.shallows.is_empty()
    }
}

/// Read a `git-upload-pack` request: the wants, shallows, and depth up to the
/// first flush, then the haves, up to a flush (another round follows) or
/// `done`; or nothing after the wants ([`Negotiation::None`]).
pub fn parse_upload_request(body: &[u8]) -> Result<UploadRequest> {
    let mut reader = Reader::new(body);
    let mut request = UploadRequest {
        wants: Vec::new(),
        capabilities: Vec::new(),
        shallows: Vec::new(),
        depth: None,
        haves: Vec::new(),
        negotiation: Negotiation::None,
    };
    while let Some(line) = next_line(&mut reader, "upload request")? {
        if let Some(rest) = line.strip_prefix("want ") {
            let (id, capabilities) = rest.split_once(' ').unwrap_or((rest, ""));
            if request.wants.is_empty() {
                request.capabilities = capabilities
                    .split(' ')
                    .filter(|capability| !capability.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            request.wants.push(parse_id(id, &line)?);
        } else if let Some(id) = line.strip_prefix("shallow ") {
            request.shallows.push(parse_id(id, &line)?);
        } else if let Some(depth) = line.strip_prefix("deepen ") {
            let depth = depth
                .parse::<u32>()
                .ok()
                .filter(|depth| *depth > 0)
                .ok_or_else(|| {
                    Error::malformed("upload request", format!("`{line}` is not a depth"))
                })?;
            request.depth = Some(depth);
        } else {
            return Err(Error::malformed(
                "upload request",
                format!("`{line}` is not a want, a shallow, or a depth this server offers"),
            ));
        }
    }
    if request.wants.is_empty() {
        return Err(Error::malformed("upload request", "it wants nothing"));
    }
    loop {
        match reader.next_packet()? {
            Some(Packet::Data(data)) => {
                let line = text(data, "upload request")?;
                if line == "done" {
                    request.negotiation = Negotiation::Done;
                    break;
                }
                let id = line.strip_prefix("have ").ok_or_else(|| {
                    Error::malformed("upload request", format!("`{line}` is not a have"))
                })?;
                request.haves.push(parse_id(id, &line)?);
                request.negotiation = Negotiation::Round;
            }
            Some(Packet::Flush) => {
                request.negotiation = Negotiation::Round;
                break;
            }
            None => break,
            Some(Packet::Delim) => {
                return Err(Error::malformed(
                    "upload request",
                    "a delimiter is protocol v2's",
                ));
            }
        }
    }
    Ok(request)
}

/// The next data line up to a flush, its newline removed; `None` at the
/// flush.
fn next_line(reader: &mut Reader<'_>, what: &str) -> Result<Option<String>> {
    match reader.next_packet()? {
        Some(Packet::Data(data)) => Ok(Some(text(data, what)?)),
        Some(Packet::Flush) => Ok(None),
        Some(Packet::Delim) | None => Err(Error::malformed(
            what,
            "a section does not end with a flush",
        )),
    }
}

fn text(data: &[u8], what: &str) -> Result<String> {
    let line =
        std::str::from_utf8(data).map_err(|_| Error::malformed(what, "a line is not UTF-8"))?;
    Ok(line.strip_suffix('\n').unwrap_or(line).to_owned())
}

fn parse_id(text: &str, line: &str) -> Result<ObjectId> {
    text.parse::<ObjectId>().map_err(|_| {
        Error::malformed(
            "upload request",
            format!("`{line}` does not name an object id"),
        )
    })
}

/// What the host answers a `git-upload-pack` request with, once it has
/// walked its objects.
#[derive(Debug, Clone, Copy)]
pub struct UploadAnswer<'a, B: AsRef<[u8]>> {
    /// Whether the answer starts with the shallow section
    /// ([`UploadRequest::deepens`]).
    pub deepens: bool,
    /// The commits the client's history now stops at.
    pub shallow: &'a [ObjectId],
    /// The client's shallow commits whose parents it now gets.
    pub unshallow: &'a [ObjectId],
    /// What the request carried after its wants.
    pub negotiation: Negotiation,
    /// The client's haves the host has: the first is acknowledged.
    pub common: &'a [ObjectId],
    /// The pack, for a client that is done: every object it lacks, whole.
    pub pack: &'a [(crate::Kind, B)],
}

/// The body of a `git-upload-pack` answer, as `git upload-pack
/// --stateless-rpc` writes it: the shallow section when asked for; then,
/// unless the request stopped after its wants, `ACK` of the first common
/// commit or `NAK` without one; then, when the client is done, the pack.
pub fn upload_response<B: AsRef<[u8]>>(answer: &UploadAnswer<'_, B>) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    if answer.deepens {
        for id in answer.shallow {
            pktline::write(&mut body, format!("shallow {id}\n").as_bytes())?;
        }
        for id in answer.unshallow {
            pktline::write(&mut body, format!("unshallow {id}\n").as_bytes())?;
        }
        body.extend_from_slice(pktline::FLUSH);
    }
    if answer.negotiation == Negotiation::None {
        return Ok(body);
    }
    match answer.common.first() {
        Some(id) => pktline::write(&mut body, format!("ACK {id}\n").as_bytes())?,
        None => pktline::write(&mut body, b"NAK\n")?,
    }
    if answer.negotiation == Negotiation::Done {
        body.extend_from_slice(&crate::pack::write(answer.pack)?);
    }
    Ok(body)
}

/// The body of a `git-receive-pack` answer, for a client that asked for
/// `report-status`: whether the pack unpacked, then each update's outcome.
pub fn status_report(unpack: &Result<(), String>, refs: &[RefStatus]) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let line = match unpack {
        Ok(()) => "unpack ok\n".to_owned(),
        Err(message) => format!("unpack {}\n", one_line(message)),
    };
    pktline::write(&mut body, line.as_bytes())?;
    for status in refs {
        let line = match &status.result {
            Ok(()) => format!("ok {}\n", status.name),
            Err(reason) => format!("ng {} {}\n", status.name, one_line(reason)),
        };
        pktline::write(&mut body, line.as_bytes())?;
    }
    body.extend_from_slice(pktline::FLUSH);
    Ok(body)
}

/// A message on one line, as a report line carries it.
fn one_line(message: &str) -> String {
    message.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::{Kind, object_id};
    use crate::receive_pack::parse_report;

    fn id(text: &[u8]) -> ObjectId {
        object_id(Kind::Commit, text)
    }

    fn lines(body: &[u8]) -> Vec<String> {
        let mut reader = Reader::new(body);
        let mut lines = Vec::new();
        while let Some(packet) = reader.next_packet().unwrap() {
            lines.push(match packet {
                Packet::Data(data) => String::from_utf8_lossy(data).into_owned(),
                Packet::Flush => "0000".to_owned(),
                Packet::Delim => "0001".to_owned(),
            });
        }
        lines
    }

    #[test]
    fn upload_pack_advertises_head_first_with_its_symref() {
        let main = id(b"main");
        let refs = [
            ("refs/heads/main".to_owned(), main),
            ("refs/heads/other".to_owned(), id(b"other")),
        ];
        let body = advertise(Service::UploadPack, &refs, Some("refs/heads/main")).unwrap();
        assert_eq!(
            lines(&body),
            [
                "# service=git-upload-pack\n".to_owned(),
                "0000".to_owned(),
                format!("{main} HEAD\0shallow {AGENT} symref=HEAD:refs/heads/main\n"),
                format!("{main} refs/heads/main\n"),
                format!("{} refs/heads/other\n", id(b"other")),
                "0000".to_owned(),
            ]
        );
    }

    #[test]
    fn an_empty_repository_advertises_its_capabilities_alone() {
        let body = advertise(Service::ReceivePack, &[], Some("refs/heads/main")).unwrap();
        assert_eq!(
            lines(&body)[2],
            format!(
                "{} capabilities^{{}}\0report-status delete-refs ofs-delta no-thin {AGENT}\n",
                ObjectId::ZERO
            )
        );
        assert!(advertise(Service::ReceivePack, &[("main".to_owned(), id(b"x"))], None).is_err());
    }

    fn request(lines: &[&str], end: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        for line in lines {
            if line.is_empty() {
                body.extend_from_slice(pktline::FLUSH);
            } else {
                pktline::write(&mut body, format!("{line}\n").as_bytes()).unwrap();
            }
        }
        body.extend_from_slice(end);
        body
    }

    #[test]
    fn reads_a_clone_and_a_fetch() {
        let (a, b) = (id(b"a"), id(b"b"));
        let clone = parse_upload_request(&request(
            &[
                &format!("want {a} shallow agent=git/2"),
                &format!("want {b}"),
                "deepen 1",
                "",
            ],
            b"0009done\n",
        ))
        .unwrap();
        assert_eq!(clone.wants, [a, b]);
        assert_eq!(clone.capabilities, ["shallow", "agent=git/2"]);
        assert_eq!(clone.depth, Some(1));
        assert!(clone.haves.is_empty() && clone.deepens());
        assert_eq!(clone.negotiation, Negotiation::Done);

        let fetch = parse_upload_request(&request(
            &[&format!("want {a}"), "", &format!("have {b}"), ""],
            b"",
        ))
        .unwrap();
        assert_eq!(fetch.haves, [b]);
        assert_eq!(fetch.negotiation, Negotiation::Round);
        assert!(!fetch.deepens());

        let wants_alone =
            parse_upload_request(&request(&[&format!("want {a}"), "deepen 1", ""], b"")).unwrap();
        assert_eq!(wants_alone.negotiation, Negotiation::None);
    }

    #[test]
    fn refuses_what_it_does_not_offer() {
        let a = id(b"a");
        for lines in [
            vec![
                format!("want {a}"),
                "deepen-since 1".to_owned(),
                String::new(),
            ],
            vec![
                format!("want {a}"),
                "filter blob:none".to_owned(),
                String::new(),
            ],
            vec!["want nope".to_owned(), String::new()],
            vec![String::new()],
            vec![format!("want {a}"), "deepen 0".to_owned(), String::new()],
        ] {
            let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
            assert!(
                parse_upload_request(&request(&lines, b"")).is_err(),
                "{lines:?}"
            );
        }
    }

    #[test]
    fn answers_with_the_shallow_section_then_an_ack_or_a_nak() {
        let (a, b) = (id(b"a"), id(b"b"));
        let negotiating = upload_response::<&[u8]>(&UploadAnswer {
            deepens: true,
            shallow: &[a],
            unshallow: &[b],
            negotiation: Negotiation::Round,
            common: &[],
            pack: &[],
        })
        .unwrap();
        assert_eq!(
            lines(&negotiating),
            [
                format!("shallow {a}\n"),
                format!("unshallow {b}\n"),
                "0000".to_owned(),
                "NAK\n".to_owned()
            ]
        );
        let shallow_alone = upload_response::<&[u8]>(&UploadAnswer {
            deepens: true,
            shallow: &[a],
            unshallow: &[],
            negotiation: Negotiation::None,
            common: &[],
            pack: &[],
        })
        .unwrap();
        assert_eq!(
            lines(&shallow_alone),
            [format!("shallow {a}\n"), "0000".to_owned()]
        );
        let objects = [(Kind::Blob, &b"x"[..])];
        let done = upload_response(&UploadAnswer {
            deepens: false,
            shallow: &[],
            unshallow: &[],
            negotiation: Negotiation::Done,
            common: &[b, a],
            pack: &objects,
        })
        .unwrap();
        let ack = format!("0031ACK {b}\n");
        assert!(done.starts_with(ack.as_bytes()));
        let pack = crate::pack::read(&done[ack.len()..]).unwrap();
        assert_eq!(pack[0].body, b"x");
    }

    #[test]
    fn a_status_report_reads_back() {
        let body = status_report(
            &Ok(()),
            &[
                RefStatus {
                    name: "refs/heads/main".to_owned(),
                    result: Ok(()),
                },
                RefStatus {
                    name: "refs/heads/other".to_owned(),
                    result: Err("the branch\nmoved".to_owned()),
                },
            ],
        )
        .unwrap();
        let report = parse_report(&body).unwrap();
        assert_eq!(report.refs[0].result, Ok(()));
        assert_eq!(report.refs[1].result, Err("the branch moved".to_owned()));
        let failed = parse_report(&status_report(&Err("bad pack".to_owned()), &[]).unwrap());
        assert_eq!(failed.unwrap().unpack, Err("bad pack".to_owned()));
    }
}
