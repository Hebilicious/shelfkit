//! Load and validation errors.
//!
//! Every error carries the file it came from, because a shelf that half-loads
//! produces an agent that half-knows the conventions. Paths are relative to the
//! shelf root with `/` separators, so the same shelf reports the same paths on
//! every platform and in the Worker.

use std::fmt;

/// One problem, in one file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{path}: {kind}")]
pub struct Error {
    /// The offending file, relative to the shelf root.
    pub path: String,
    pub kind: ErrorKind,
}

impl Error {
    pub fn new(path: impl Into<String>, kind: ErrorKind) -> Self {
        Self {
            path: path.into(),
            kind,
        }
    }

    pub fn invalid(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(path, ErrorKind::Invalid(message.into()))
    }
}

/// What went wrong. The `Display` form is the message after `path: `.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ErrorKind {
    #[error("cannot read: {0}")]
    Read(String),

    #[error("invalid path: {0}")]
    Path(String),

    #[error("missing `{0}`")]
    MissingFile(String),

    #[error("invalid JSON: {0}")]
    Json(String),

    #[error("invalid SKILL.md frontmatter: {0}")]
    Frontmatter(String),

    #[error("{0}")]
    Invalid(String),

    #[error("`{field}` references unknown {what} `{target}`")]
    UnknownReference {
        /// Where the reference is, as `requires`, `items`, `extends`, ...
        field: String,
        /// What it should name: `item`, `profile`, `bundle`, or `source`.
        what: &'static str,
        target: String,
    },

    #[error("`extends` cycle: {}", .0.join(" -> "))]
    ExtendsCycle(Vec<String>),

    #[error("{}", conflict_message(.output, .items))]
    Conflict {
        /// The compiled output both items produce, as `MCP server \`x\``.
        output: String,
        /// The conflicting items, as `(id, item.json path)`.
        items: Vec<(String, String)>,
    },

    #[error(
        "`{field}` holds a literal that looks like a credential ({reason}); \
         use a secret reference such as {{ \"secret\": \"NAME\" }}"
    )]
    Credential { field: String, reason: String },

    #[error("target `{slug}`: {reason}")]
    Target { slug: String, reason: String },

    #[error("revision mismatch for `{id}`: expected {expected}, computed {actual}")]
    RevisionMismatch {
        id: String,
        expected: String,
        actual: String,
    },
}

fn conflict_message(output: &str, items: &[(String, String)]) -> String {
    let listed: Vec<String> = items
        .iter()
        .map(|(id, path)| format!("`{id}` ({path})"))
        .collect();
    format!("items {} all compile to {output}", listed.join(" and "))
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Every problem a load found, sorted by path and then message so the output
/// is stable from run to run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Errors(Vec<Error>);

impl Errors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, error: Error) {
        self.0.push(error);
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn iter(&self) -> std::slice::Iter<'_, Error> {
        self.0.iter()
    }

    /// Sorted by path, then message, with duplicates removed.
    pub fn sorted(mut self) -> Self {
        self.0.sort_by(|a, b| {
            (a.path.as_str(), a.kind.to_string()).cmp(&(b.path.as_str(), b.kind.to_string()))
        });
        self.0.dedup();
        self
    }

    /// `Ok(value)` when nothing was found, otherwise every error, sorted.
    pub fn into_result<T>(self, value: T) -> Result<T, Self> {
        if self.0.is_empty() {
            Ok(value)
        } else {
            Err(self.sorted())
        }
    }
}

impl From<Error> for Errors {
    fn from(error: Error) -> Self {
        Self(vec![error])
    }
}

impl Extend<Error> for Errors {
    fn extend<I: IntoIterator<Item = Error>>(&mut self, iter: I) {
        self.0.extend(iter);
    }
}

impl IntoIterator for Errors {
    type Item = Error;
    type IntoIter = std::vec::IntoIter<Error>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

impl fmt::Display for Errors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, error) in self.0.iter().enumerate() {
            if index > 0 {
                f.write_str("\n")?;
            }
            write!(f, "{error}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Errors {}
