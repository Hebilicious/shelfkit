//! Object ids, kinds, and file modes.

use crate::Error;
use sha1::{Digest, Sha1};
use std::fmt;
use std::str::FromStr;

/// A SHA-1 object id, written as 40 lowercase hex digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ObjectId(pub [u8; 20]);

impl ObjectId {
    /// The id Git writes for "no object": the old side of a created
    /// reference, and the new side of a deleted one.
    pub const ZERO: Self = Self([0; 20]);

    pub fn is_zero(&self) -> bool {
        *self == Self::ZERO
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl FromStr for ObjectId {
    type Err = Error;

    /// Exactly 40 hex digits, in either case.
    fn from_str(text: &str) -> Result<Self, Error> {
        let invalid = || Error::invalid(text, "not an object id: 40 hex digits");
        if text.len() != 40 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        let mut id = [0; 20];
        let (pairs, _) = text.as_bytes().as_chunks::<2>();
        for (byte, [high, low]) in id.iter_mut().zip(pairs) {
            *byte = (hex_value(*high) << 4) | hex_value(*low);
        }
        Ok(Self(id))
    }
}

/// The value of one hex digit the caller has already checked.
fn hex_value(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        b'a'..=b'f' => digit - b'a' + 10,
        b'A'..=b'F' => digit - b'A' + 10,
        _ => 0,
    }
}

/// The kind of an object, which its id covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Commit,
    Tree,
    Blob,
    Tag,
}

impl Kind {
    /// The name in an object's header and in `git cat-file -t`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::Tree => "tree",
            Self::Blob => "blob",
            Self::Tag => "tag",
        }
    }

    /// The type number in a pack entry's header.
    pub(crate) fn pack_type(self) -> u8 {
        match self {
            Self::Commit => 1,
            Self::Tree => 2,
            Self::Blob => 3,
            Self::Tag => 4,
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

/// The id of an object of `kind` whose body is `body`: the SHA-1 of
/// `<kind> <length>\0<body>`, as `git hash-object` computes it.
pub fn object_id(kind: Kind, body: &[u8]) -> ObjectId {
    let mut hasher = Sha1::new();
    hasher.update(kind.name().as_bytes());
    hasher.update(b" ");
    hasher.update(body.len().to_string().as_bytes());
    hasher.update([0]);
    hasher.update(body);
    ObjectId(hasher.finalize().into())
}

/// The mode of an entry in a tree that is not a directory. A directory's
/// (`40000`) is the tree's own business.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Mode {
    /// `100644`: a regular file.
    #[default]
    File,
    /// `100755`: an executable file.
    Executable,
    /// `120000`: a symbolic link, whose blob is its target.
    Symlink,
    /// `160000`: a gitlink, a submodule's commit. Its id names a commit of
    /// another repository, which this one need not have.
    Gitlink,
}

impl Mode {
    /// The octal digits a tree entry carries.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "100644",
            Self::Executable => "100755",
            Self::Symlink => "120000",
            Self::Gitlink => "160000",
        }
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Mode {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self, Error> {
        match text {
            "100644" => Ok(Self::File),
            "100755" => Ok(Self::Executable),
            "120000" => Ok(Self::Symlink),
            "160000" => Ok(Self::Gitlink),
            _ => Err(Error::invalid(
                text,
                "not a file mode: 100644, 100755, 120000, or 160000",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_as_git_does() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(
            object_id(Kind::Blob, b"hello\n").to_string(),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
        // The empty tree.
        assert_eq!(
            object_id(Kind::Tree, b"").to_string(),
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        );
    }

    #[test]
    fn reads_and_writes_hex() {
        let text = "CE013625030BA8DBA906F756967F9E9CA394464A";
        let id: ObjectId = text.parse().unwrap();
        assert_eq!(id.to_string(), text.to_lowercase());
        assert!("ce01".parse::<ObjectId>().is_err());
        assert!(
            "zz013625030ba8dba906f756967f9e9ca394464a"
                .parse::<ObjectId>()
                .is_err()
        );
        assert!(
            "+e013625030ba8dba906f756967f9e9ca394464a"
                .parse::<ObjectId>()
                .is_err()
        );
        assert!(ObjectId::ZERO.is_zero());
        assert_eq!(ObjectId::ZERO.to_string(), "0".repeat(40));
    }

    #[test]
    fn modes_round_trip() {
        for mode in [Mode::File, Mode::Executable, Mode::Symlink, Mode::Gitlink] {
            assert_eq!(mode.as_str().parse::<Mode>().unwrap(), mode);
        }
        assert!("40000".parse::<Mode>().is_err());
        assert!("100664".parse::<Mode>().is_err());
    }
}
