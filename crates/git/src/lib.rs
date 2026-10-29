#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

//! Git objects, packfiles, and a client's side of smart HTTP, as a pure
//! library: no I/O.
//!
//! A hosted shelf keeps its source files in a Cloudflare Artifacts repository,
//! a Git smart-HTTP remote with SHA-1 object ids, and each published profile
//! keeps its versions in one too. The Worker reads a repository through its
//! binding, but the only way to write is `git push`: a receive-pack request
//! over HTTP, protocol v1. This crate builds that request, and reads what
//! comes back, so the Worker only sends bytes. Artifacts, deployed or as
//! Miniflare's local simulator, is the server; nothing here serves Git.
//!
//! - [`plan_commit`]: a shelf's complete new file list, on top of its parent
//!   commit's, to the commit and the receive-pack request that pushes it.
//! - [`object`]: object ids, kinds, and file modes.
//! - [`tree`]: building every tree of a file list.
//! - [`commit`]: encoding commit bodies.
//! - [`pack`]: writing a pack of whole objects.
//! - [`pktline`]: the framing of every exchange.
//! - [`receive_pack`]: the push request, and the server's report.
//! - [`advertisement`]: the references a server advertises, read from `GET
//!   info/refs`.

pub mod advertisement;
pub mod commit;
pub mod object;
pub mod pack;
pub mod pktline;
mod plan;
pub mod receive_pack;
pub mod tree;

pub use advertisement::{AdvertisedRef, Advertisement, parse_advertisement};
pub use commit::{Commit, Signature};
pub use object::{Kind, Mode, ObjectId, object_id};
pub use plan::{CommitInput, CommitPlan, NewFile, Push, Source, plan_commit};
pub use tree::FileEntry;

use std::fmt;

/// What went wrong, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Input that cannot become a commit: a file path, a reference name, or
    /// a signature. `path` names it.
    Invalid { path: String, reason: String },
    /// Bytes that are not what they claim to be, or cannot become a pack: a
    /// pkt-line stream, a report, an advertisement, or a pack's objects.
    /// `what` says which, and where in it.
    Malformed { what: String, reason: String },
    /// The server ended the exchange with a fatal error of its own.
    Remote { message: String },
}

impl Error {
    pub(crate) fn invalid(path: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Invalid {
            path: path.into(),
            reason: reason.into(),
        }
    }

    pub(crate) fn malformed(what: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Malformed {
            what: what.into(),
            reason: reason.into(),
        }
    }

    /// What the error is about: the path, the reference, or the bytes read.
    pub fn path(&self) -> &str {
        match self {
            Self::Invalid { path, .. } => path,
            Self::Malformed { what, .. } => what,
            Self::Remote { .. } => "<remote>",
        }
    }

    /// The error without its path.
    pub fn reason(&self) -> &str {
        match self {
            Self::Invalid { reason, .. } | Self::Malformed { reason, .. } => reason,
            Self::Remote { message } => message,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Remote { message } => write!(formatter, "the server failed: {message}"),
            _ => write!(formatter, "{}: {}", self.path(), self.reason()),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T, E = Error> = std::result::Result<T, E>;
