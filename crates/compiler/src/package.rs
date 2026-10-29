//! A profile as a registry package: the archive `shelfkit serve` publishes,
//! and that `shelfkit push` and the Worker will publish, byte for byte.
//!
//! # Identity
//!
//! A shelf publishes under its `registry.namespace`, and each profile is a
//! package of its own: `{namespace}/{profile id}`, a GitHub-shaped
//! `{owner}/{repo}` identity, so it needs no percent-encoding.
//!
//! # Version
//!
//! A profile's identity is its revision, a hash; a version exists only for
//! publishing (`docs/PRD.md` section 13, question 1). A profile with a
//! `version` publishes as exactly that semver. A profile without one
//! publishes as `0.0.0+sha256.<revision hex>.format<N>`: semver build
//! metadata that names the revision and the package [`FORMAT`]. APM's
//! client ranks every build of `0.0.0` the same, and among equals a range
//! picks the one the registry lists last, which is the oldest (the list is
//! newest first). So a consumer pins the exact version, which APM matches
//! by its text before it tries a range: `shelfkit install` writes the newest
//! published one, and running it again moves the pin.
//!
//! The format is part of the version because versions are immutable: when
//! the layout of a package changes (format 2 moved instructions to
//! `.github/instructions/`, `docs/PRD.md` section 4.2), an unchanged profile
//! publishes its new archive as a new version instead of colliding with the
//! old one.
//!
//! Versions are immutable, so publishing a version twice fails with `409`
//! even when the bytes are the same: an unchanged profile without a
//! `version` has nothing new to publish, and a changed profile with an
//! unchanged `version` must bump it. The generated version follows the
//! profile revision, which covers the items and the compile settings but
//! not `shelf.json`; a changed source URL with an unchanged profile keeps
//! the version, and republishing it is refused rather than overwritten.
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

/// The version a profile without one publishes as.
pub fn generated_version(revision: &Revision) -> String {
    let hex = revision
        .as_str()
        .strip_prefix("sha256-")
        .unwrap_or(revision.as_str());
    format!("0.0.0+sha256.{hex}.format{FORMAT}")
}

/// The package layout this compiler writes. Bump it when the files of a package change for the same profile.
///
/// 2: instructions moved to `.github/instructions/`. 3: an instructions body that opens with its own top-level
/// heading is not given the item's title above it. 4: a skill whose `SKILL.md` sets `disable-model-invocation` gets
/// `agents/openai.yaml` for Codex. 5: a skill that links to a doc of the profile carries a copy of it.
pub const FORMAT: u32 = 5;

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
        .and_then(|profile| profile.version.clone())
        .unwrap_or_else(|| generated_version(&resolved.revision));
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
