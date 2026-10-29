//! A profile as a registry package: the archive `shelfkit serve` publishes,
//! and that `shelfkit publish` and the Worker publish, byte for byte.
//!
//! # Identity
//!
//! A shelf publishes under its `registry.namespace`, and each profile is a
//! package of its own: `{namespace}/{profile id}`, a GitHub-shaped
//! `{owner}/{repo}` identity, so it needs no percent-encoding.
//!
//! # Version
//!
//! A profile publishes as its `version`, which every profile has: the shelf
//! does not load without it (`docs/PRD.md` section 13, question 1).
//!
//! Versions are immutable, so publishing a version twice fails with `409`
//! even when the bytes are the same: an unchanged profile has nothing new to
//! publish, and a changed profile must bump its `version` before it
//! publishes again. That covers a change outside the profile too, such as a
//! source URL in `shelf.json`: republishing the same version with other
//! bytes is refused rather than overwritten.
//!
//! # Archive layout
//!
//! A `tar.gz` written by [`shelfkit_registry::archive::pack`]: deterministic
//! headers and gzip, files only, in path order.
//!
//! - `apm.yml`: `name` (the profile id, which is the repo), `version`, a
//!   `description` naming the shelf and the revision, and the profile's
//!   `registries` and `dependencies` exactly as `compile` renders them,
//!   except that there is no `targets` (the consumer chooses its own) and no
//!   `./vendor/...` entry.
//! - `.apm/...`: the shelf-authored items, at the package's root, laid out
//!   as `compile` vendors them into `vendor/<profile>/.apm/`.
//!
//! A profile whose items need packages of their own (a plugin, or an item
//! restricted to some targets) cannot be published: APM refuses local-path
//! dependencies inside a registry package, and the error says which item.

use crate::manifest::{Shape, render};
use crate::yaml;
use serde::Serialize;
use shelfkit_core::{Error, Errors, ResolvedProfile, Revision, Shelf};
use shelfkit_registry::archive;
use std::collections::BTreeMap;

/// A profile packaged for a registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagedProfile {
    /// `{owner}/{repo}`.
    pub package: String,
    pub owner: String,
    pub repo: String,
    pub version: String,
    pub profile_revision: Revision,
    /// `sha256:<hex>` over [`Self::archive`].
    pub digest: String,
    pub size_bytes: u64,
    /// The paths in the archive, sorted.
    pub files: Vec<String>,
    /// Whether the shelf serves anonymous reads.
    pub public: bool,
    #[serde(skip)]
    pub archive: Vec<u8>,
}

/// Package one resolved profile of `shelf`.
pub fn package(shelf: &Shelf, resolved: &ResolvedProfile) -> Result<PackagedProfile, Errors> {
    let Some(registry) = &shelf.manifest.registry else {
        return Err(Error::invalid(
            "shelf.json",
            "set `registry.namespace` to publish profiles: it is the `{owner}` of every package the shelf publishes",
        )
        .into());
    };
    let owner = registry.namespace.clone();
    let repo = resolved.id.clone();
    let version = shelf
        .profiles
        .get(&resolved.id)
        .map(|profile| profile.version.clone())
        .ok_or_else(|| {
            Error::invalid(
                resolved.path.clone(),
                format!("no profile `{}`", resolved.id),
            )
        })?;
    let shape = Shape::Package {
        name: repo.clone(),
        version: version.clone(),
        description: format!(
            "Profile {repo} of the {owner} shelf, revision {}, published by ShelfKit.",
            resolved.revision
        ),
    };
    let rendered = render(shelf, resolved, &shape)?;
    let mut files: BTreeMap<String, Vec<u8>> = rendered.files;
    files.insert(
        "apm.yml".to_owned(),
        yaml::render(&rendered.manifest).into_bytes(),
    );
    let bytes = archive::pack(&files).map_err(|error| {
        Errors::from(Error::invalid(
            resolved.path.clone(),
            format!("the profile cannot be packaged: {error}"),
        ))
    })?;
    Ok(PackagedProfile {
        package: format!("{owner}/{repo}"),
        owner,
        repo,
        version,
        profile_revision: resolved.revision.clone(),
        digest: shelfkit_registry::digest(&bytes),
        size_bytes: bytes.len() as u64,
        files: files.into_keys().collect(),
        public: registry.public,
        archive: bytes,
    })
}
