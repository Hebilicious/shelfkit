#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

//! Compiles a resolved shelf profile into APM's format.
//!
//! The compiler's contract is narrow and testable: given a profile and the
//! items it selects, produce a valid `apm.yml` and a set of files to vendor.
//! It never writes a lockfile, never materializes skills into harness
//! directories, and never invokes APM. See `docs/PRD.md` sections 3.1 and 7.1.

pub mod manifest;

pub use manifest::{CompiledManifest, VendorFile, compile};
