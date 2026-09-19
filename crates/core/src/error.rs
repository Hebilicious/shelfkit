use std::path::PathBuf;

/// Errors carry the file they came from, because a shelf that half-loads
/// produces an agent that half-knows the conventions.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("{path}: invalid JSON: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },

    #[error("{path}: {message}")]
    Invalid { path: PathBuf, message: String },

    #[error("item `{id}` references unknown item `{missing}`")]
    UnknownReference { id: String, missing: String },

    #[error("profile `{0}` extends itself, directly or through another profile")]
    ExtendsCycle(String),

    #[error("revision mismatch for `{id}`: expected {expected}, computed {actual}")]
    RevisionMismatch {
        id: String,
        expected: String,
        actual: String,
    },
}

pub type Result<T> = std::result::Result<T, Error>;
