use crate::Result;
use sha2::{Digest, Sha256};
use std::fmt;

/// A content-addressed snapshot of one item.
///
/// The digest is `sha256` over a canonical serialization of the item
/// directory: files sorted by path, LF line endings, and timestamps,
/// permissions, and ownership excluded. Two clones of the same shelf
/// therefore produce identical revisions.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Revision(String);

impl Revision {
    /// Compute a revision from a set of `(relative path, bytes)` pairs.
    ///
    /// Callers are responsible for supplying paths relative to the item root
    /// with `/` separators. Sorting happens here so callers cannot get it
    /// wrong.
    pub fn compute<'a, I>(files: I) -> Self
    where
        I: IntoIterator<Item = (&'a str, &'a [u8])>,
    {
        let mut entries: Vec<(&str, &[u8])> = files.into_iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));

        let mut hasher = Sha256::new();
        for (path, bytes) in entries {
            let content = strip_cr(bytes);
            // Length-prefixed framing so a path cannot be confused with content.
            // Both lengths describe the normalized content, not the input.
            hasher.update((path.len() as u64).to_le_bytes());
            hasher.update(path.as_bytes());
            hasher.update((content.len() as u64).to_le_bytes());
            hasher.update(&content);
        }

        Self(format!("sha256-{}", hex(&hasher.finalize())))
    }

    pub fn parse(value: &str) -> Result<Self> {
        let hex_part = value
            .strip_prefix("sha256-")
            .ok_or_else(|| crate::Error::Invalid {
                path: "<revision>".into(),
                message: format!("revision must start with `sha256-`, got `{value}`"),
            })?;

        if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(crate::Error::Invalid {
                path: "<revision>".into(),
                message: format!("revision digest must be 64 hex characters, got `{hex_part}`"),
            });
        }

        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Normalize CRLF to LF so a Windows checkout hashes the same as a Linux one.
fn strip_cr(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_does_not_matter() {
        let a = Revision::compute([("b.md", b"two".as_slice()), ("a.md", b"one".as_slice())]);
        let b = Revision::compute([("a.md", b"one".as_slice()), ("b.md", b"two".as_slice())]);
        assert_eq!(a, b);
    }

    #[test]
    fn content_changes_the_digest() {
        let a = Revision::compute([("a.md", b"one".as_slice())]);
        let b = Revision::compute([("a.md", b"two".as_slice())]);
        assert_ne!(a, b);
    }

    #[test]
    fn path_boundaries_are_framed() {
        // Without length framing these two would collide.
        let a = Revision::compute([("ab", b"c".as_slice())]);
        let b = Revision::compute([("a", b"bc".as_slice())]);
        assert_ne!(a, b);
    }

    #[test]
    fn line_endings_are_normalized() {
        let unix = Revision::compute([("a.md", b"one\ntwo\n".as_slice())]);
        let windows = Revision::compute([("a.md", b"one\r\ntwo\r\n".as_slice())]);
        assert_eq!(unix, windows);
    }

    #[test]
    fn parse_rejects_malformed() {
        assert!(Revision::parse("sha256-abc").is_err());
        assert!(Revision::parse("abc").is_err());
        assert!(Revision::parse(&format!("sha256-{}", "a".repeat(64))).is_ok());
    }
}
