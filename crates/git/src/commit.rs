//! Commit bodies: encoding the commits ShelfKit makes, and decoding any.

use crate::object::ObjectId;
use crate::{Error, Result};

/// Who made a change, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Unix seconds.
    pub time: i64,
    /// Minutes east of UTC.
    pub offset: i32,
}

/// The largest offset accepted, in minutes either side of UTC.
const MAX_OFFSET: i32 = 24 * 60 - 1;

impl Signature {
    /// `name <email> <seconds> <+hhmm>`, as a commit's `author` and
    /// `committer` lines carry it. `role` names the signature in errors.
    fn encode(&self, role: &str) -> Result<String> {
        if self.name.is_empty() {
            return Err(Error::invalid(role, "the name cannot be empty"));
        }
        for (field, value) in [("name", &self.name), ("email", &self.email)] {
            if value.contains(['<', '>', '\n', '\0']) {
                return Err(Error::invalid(
                    role,
                    format!("the {field} cannot contain `<`, `>`, a newline, or a NUL"),
                ));
            }
        }
        if self.time < 0 {
            return Err(Error::invalid(role, "the time cannot be before 1970"));
        }
        if !(-MAX_OFFSET..=MAX_OFFSET).contains(&self.offset) {
            return Err(Error::invalid(
                role,
                "the offset must be less than a day either side of UTC",
            ));
        }
        let sign = if self.offset < 0 { '-' } else { '+' };
        let minutes = self.offset.unsigned_abs();
        Ok(format!(
            "{} <{}> {} {sign}{:02}{:02}",
            self.name,
            self.email,
            self.time,
            minutes / 60,
            minutes % 60
        ))
    }

    fn decode(line: &str, what: &str) -> Result<Self> {
        let malformed = || Error::malformed(what, format!("not a signature: `{line}`"));
        let close = line.rfind('>').ok_or_else(malformed)?;
        let open = line[..close].rfind('<').ok_or_else(malformed)?;
        let name = line[..open].trim_end().to_owned();
        let email = line[open + 1..close].to_owned();
        let mut when = line[close + 1..].split_whitespace();
        let time = when
            .next()
            .and_then(|seconds| seconds.parse::<i64>().ok())
            .ok_or_else(malformed)?;
        let offset = when.next().and_then(parse_offset).ok_or_else(malformed)?;
        Ok(Self {
            name,
            email,
            time,
            offset,
        })
    }
}

/// `+hhmm` or `-hhmm` in minutes.
fn parse_offset(text: &str) -> Option<i32> {
    let (sign, digits) = match text.split_at_checked(1)? {
        ("+", digits) => (1, digits),
        ("-", digits) => (-1, digits),
        _ => return None,
    };
    if digits.len() != 4 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let hours: i32 = digits[..2].parse().ok()?;
    let minutes: i32 = digits[2..].parse().ok()?;
    Some(sign * (hours * 60 + minutes))
}

/// A commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub tree: ObjectId,
    pub parents: Vec<ObjectId>,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
}

impl Commit {
    /// The commit's body: its tree, parents, author, committer, a blank
    /// line, and the message, which is given a trailing newline if it lacks
    /// one.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut body = format!("tree {}\n", self.tree);
        for parent in &self.parents {
            body.push_str(&format!("parent {parent}\n"));
        }
        body.push_str(&format!("author {}\n", self.author.encode("author")?));
        body.push_str(&format!(
            "committer {}\n",
            self.committer.encode("committer")?
        ));
        body.push('\n');
        body.push_str(&self.message);
        if !body.ends_with('\n') {
            body.push('\n');
        }
        Ok(body.into_bytes())
    }

    /// Read a commit's body. Headers other than the tree, the parents, the
    /// author, and the committer (a signature, an encoding) are skipped, and
    /// the message is read as UTF-8, any invalid byte replaced.
    pub fn decode(body: &[u8]) -> Result<Self> {
        let what = "commit";
        let (headers, message) = match body.windows(2).position(|pair| pair == b"\n\n") {
            Some(end) => (&body[..end], &body[end + 2..]),
            None => (body.strip_suffix(b"\n").unwrap_or(body), &b""[..]),
        };
        let headers = String::from_utf8_lossy(headers);
        let mut tree = None;
        let mut parents = Vec::new();
        let mut author = None;
        let mut committer = None;
        for line in headers.split('\n') {
            // A continuation line belongs to a multi-line header (`gpgsig`).
            if line.starts_with(' ') {
                continue;
            }
            let (name, value) = line.split_once(' ').unwrap_or((line, ""));
            let id = || {
                value
                    .parse::<ObjectId>()
                    .map_err(|_| Error::malformed(what, format!("`{name}` is not an object id")))
            };
            match name {
                "tree" if tree.is_none() => tree = Some(id()?),
                "parent" => parents.push(id()?),
                "author" if author.is_none() => author = Some(Signature::decode(value, what)?),
                "committer" if committer.is_none() => {
                    committer = Some(Signature::decode(value, what)?);
                }
                "tree" | "author" | "committer" => {
                    return Err(Error::malformed(what, format!("`{name}` is given twice")));
                }
                _ => {}
            }
        }
        let missing = |header: &str| Error::malformed(what, format!("no `{header}` header"));
        Ok(Self {
            tree: tree.ok_or_else(|| missing("tree"))?,
            parents,
            author: author.ok_or_else(|| missing("author"))?,
            committer: committer.ok_or_else(|| missing("committer"))?,
            message: String::from_utf8_lossy(message).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::{Kind, object_id};

    fn signature(offset: i32) -> Signature {
        Signature {
            name: "Ada Lovelace".to_owned(),
            email: "ada@example.com".to_owned(),
            time: 1_700_000_000,
            offset,
        }
    }

    fn commit(message: &str) -> Commit {
        Commit {
            tree: object_id(Kind::Tree, b""),
            parents: vec![object_id(Kind::Blob, b"not really a commit")],
            author: signature(330),
            committer: signature(-480),
            message: message.to_owned(),
        }
    }

    #[test]
    fn encodes_as_git_does() {
        let body = String::from_utf8(commit("Add a file").encode().unwrap()).unwrap();
        let parent = object_id(Kind::Blob, b"not really a commit");
        assert_eq!(
            body,
            format!(
                "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
                 parent {parent}\n\
                 author Ada Lovelace <ada@example.com> 1700000000 +0530\n\
                 committer Ada Lovelace <ada@example.com> 1700000000 -0800\n\
                 \n\
                 Add a file\n"
            )
        );
    }

    #[test]
    fn decodes_what_it_encodes() {
        let original = commit("Subject\n\nBody.\n");
        let decoded = Commit::decode(&original.encode().unwrap()).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn skips_headers_it_does_not_know() {
        let mut body = String::from_utf8(commit("x\n").encode().unwrap()).unwrap();
        body = body.replace(
            "\n\nx\n",
            "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nx\n",
        );
        assert_eq!(Commit::decode(body.as_bytes()).unwrap().message, "x\n");
    }

    #[test]
    fn refuses_signatures_git_would_misread() {
        let mut bad = commit("x");
        bad.author.name = "Eve <evil>".to_owned();
        assert_eq!(bad.encode().unwrap_err().path(), "author");
        let mut bad = commit("x");
        bad.committer.email = "a\nb".to_owned();
        assert_eq!(bad.encode().unwrap_err().path(), "committer");
        let mut bad = commit("x");
        bad.author.offset = 24 * 60;
        assert!(bad.encode().is_err());
        let mut bad = commit("x");
        bad.author.name = String::new();
        assert!(bad.encode().is_err());
    }

    #[test]
    fn refuses_bodies_that_are_not_commits() {
        assert!(Commit::decode(b"tree nope\n\nx").is_err());
        assert!(Commit::decode(b"author A <a> 1 +0000\n\nx").is_err());
        assert_eq!(parse_offset("+0530"), Some(330));
        assert_eq!(parse_offset("-0100"), Some(-60));
        assert_eq!(parse_offset("0100"), None);
        assert_eq!(parse_offset("+1"), None);
    }
}
