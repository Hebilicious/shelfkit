#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

//! Compiles a resolved shelf profile into APM's format, and the `shelfkit`
//! binary.
//!
//! The compiler's contract is narrow and testable: given a profile and the
//! items it selects, produce a valid `apm.yml` and a set of files to vendor.
//! It never writes a lockfile, never materializes skills into harness
//! directories, and never invokes APM. See `docs/PRD.md` sections 3.1 and 4.
//!
//! - [`engine::plan`] loads, resolves, and compiles; the CLI and the WASM
//!   engine both call it.
//! - [`compile`] renders a [`CompiledManifest`] from a resolved profile.
//! - [`merge`] fits a compiled manifest into a repository's existing
//!   `apm.yml`, honouring `onConflict`.
//! - `schema` (native builds) validates manifests against the vendored
//!   OpenAPM v0.1 JSON Schema.
//! - `cli` (the `cli` feature) is the `shelfkit` command line.
//!
//! The default features are the native binary's. The WASM engine builds with
//! none of them, which leaves no dependency that touches the network, the
//! filesystem, or a process.

pub mod base64;
pub mod coordinate;
pub mod engine;
pub mod manifest;
pub mod merge;
pub mod recommend;
#[cfg(feature = "schema")]
pub mod schema;
pub mod vendor;
pub mod yaml;

#[cfg(feature = "cli")]
pub mod cli;

pub use manifest::{CompiledManifest, Encoding, Note, NoteCode, VendorFile, compile};
