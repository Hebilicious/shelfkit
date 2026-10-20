#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

//! The OpenAPM Registry HTTP API, as ShelfKit serves it.
//!
//! Three endpoints, relative to a registry's base URL (`docs/PRD.md` section
//! 7.1, and the API's reference for server implementers):
//!
//! - `GET /v1/packages/{owner}/{repo}/versions`
//! - `GET /v1/packages/{owner}/{repo}/versions/{version}/download`
//! - `PUT /v1/packages/{owner}/{repo}/versions/{version}`
//!
//! The library does no I/O, so both hosts run the same decisions:
//! `shelfkit serve` through [`host::Registry`] over memory, and the Worker
//! through the WASM engine over a Durable Object and R2.
//!
//! - [`identity`]: `{owner}/{repo}`, percent-encoded for non-GitHub origins,
//!   and the routes.
//! - [`auth`]: Bearer and Basic credentials, the four scopes, and the
//!   `401`/`403` decision.
//! - [`protocol`]: statuses, headers, snake_case bodies, RFC 7807 problems,
//!   immutability, and publish validation.
//! - [`archive`]: deterministic `tar.gz` packing and defensive reading.
//! - [`host`]: the protocol over a synchronous store and key set.
//! - [`conformance`]: the suite in `conformance/cases.json`, and its runner.

pub mod archive;
pub mod auth;
pub mod base64;
pub mod conformance;
pub mod host;
pub mod identity;
pub mod protocol;

pub use auth::{Access, Credential, Scope};
pub use identity::{PackageId, Route};
pub use protocol::{Body, Context, Outcome, Prepared, Response, ShelfInfo, VersionRecord, digest};
