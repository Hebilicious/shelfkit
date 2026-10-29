//! Commit bodies: encoding the commits ShelfKit makes.

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
}
