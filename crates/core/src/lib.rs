//! ShelfKit core: the shelf format.
//!
//! This crate is the product. Everything else in the repository is a client of
//! it, and it has no dependency on Cloudflare, on the network, or on a runtime
//! beyond the standard library. It compiles to a native binary for the CLI and
//! to WASM for the Worker, so the browser preview and the CLI cannot disagree
//! about what a profile compiles to.
//!
//! - [`load`] reads a shelf from a [`FileSource`] and validates all of it.
//! - [`Shelf::resolve`] expands a profile's bundles, `extends`, and `requires`.
//! - [`Revision`] is the content address of an item and of a resolved profile.
//! - [`Shelf::check`] lists what `shelfkit check` reports beyond errors.
//!
//! See `docs/PRD.md` sections 5 and 6.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod error;
pub mod item;
pub mod load;
pub mod profile;
pub mod resolve;
pub mod revision;
pub mod secret;
pub mod shelf;
pub mod source;
pub mod target;

pub use error::{Error, ErrorKind, Errors, Result};
pub use item::{Item, ItemKind, Payload, Source};
pub use load::load;
pub use profile::{Bundle, CompileOptions, ItemRef, Manifest, OnConflict, Pin, Profile};
pub use resolve::{CompileSettings, Origin, ResolvedItem, ResolvedProfile};
pub use revision::Revision;
pub use shelf::{LoadedItem, Notice, NoticeCode, Shelf};
pub use source::{DirSource, FileSource, Listing, MemorySource};
