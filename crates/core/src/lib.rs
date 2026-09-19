//! ShelfKit core: the shelf format.
//!
//! This crate is the product. Everything else in the repository is a client of
//! it, and it has no dependency on Cloudflare, on the network, or on a runtime
//! beyond the standard library. It compiles to a native binary for the CLI and
//! to WASM for the Worker, so the browser preview and the CLI cannot disagree
//! about what a profile compiles to.
//!
//! See `docs/PRD.md` sections 5 and 6.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod error;
pub mod revision;
pub mod shelf;

pub use error::{Error, Result};
pub use revision::Revision;
pub use shelf::{CompileOptions, Item, ItemKind, OnConflict, Pin, Profile, Shelf};
