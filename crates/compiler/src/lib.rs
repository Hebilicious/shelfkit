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
//! - [`package`] packs a profile into a registry archive, for `serve` and
//!   the Worker.
//! - [`merge`] fits a compiled manifest into a repository's existing
//!   `apm.yml`, honouring `onConflict`.
//! - [`output`] works out what `compile` writes into and removes from a
//!   repository, from the CLI's view of the disk or a host's snapshot.
//! - `schema` (native builds) validates manifests against the vendored
//!   OpenAPM v0.1 JSON Schema.
//! - `cli` (the `cli` feature) is the `shelfkit` command line.
//!
//! The default features are the native binary's. The WASM engine builds with
//! none of them, which leaves no dependency that touches the network, the
//! filesystem, or a process.

pub mod coordinate;
pub mod docs;
pub mod engine;
pub mod manifest;
pub mod merge;
pub mod output;
pub mod package;
pub mod recommend;
#[cfg(feature = "schema")]
pub mod schema;
pub mod vendor;
pub mod yaml;

#[cfg(feature = "cli")]
pub mod cli;

pub use manifest::{CompiledManifest, Encoding, Note, NoteCode, VendorFile, compile};
/// Standard base64, shared with the registry.
pub use shelfkit_registry::base64;
