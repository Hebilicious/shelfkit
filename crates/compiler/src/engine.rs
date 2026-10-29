//! Load, resolve, and compile in one call: the entry point the CLI and the
//! WASM engine share, so `compile --dry-run` and the composer preview run the
//! same code over the same bytes.

use crate::coordinate::{self, Upstream};
use crate::manifest::{CompiledManifest, compile};
use crate::package::{PackagedProfile, package};
use crate::recommend::{Recommendation, recommend};
use crate::yaml;
use serde::Serialize;
use shelfkit_core::item::Markers;
use shelfkit_core::{
    Bundle, Error, Errors, FileSource, Item, Listing, Manifest, MemorySource, Notice, Payload, Pin,
    Profile, ResolvedProfile, Revision, Shelf, load,
};

/// What to compile.
#[derive(Debug, Clone, Default)]
pub struct Request {
    /// The profile id. Defaults to the override's `id`, then to
    /// `shelf.json`'s `defaultProfile`.
    pub profile: Option<String>,
    /// A profile document to compile in place of `profiles/<id>.json`, or one
    /// that is not saved yet: the composer previews an edit before it is
    /// written. It is the JSON of a profile file, validated as one.
    pub override_profile: Option<serde_json::Value>,
    /// Replace the profile's `compile.targets` (the CLI's `--targets`).
    pub targets: Option<Vec<String>>,
    /// Opt into CLI-only targets for this compile, on top of the profile's
    /// own `compile.allowNonconformantTargets`.
    pub allow_nonconformant_targets: bool,
}

/// Compile one profile of the shelf `source` holds. The override, when there
/// is one, is loaded with the rest of the shelf exactly as if it were the
/// file `profiles/<id>.json`, so it is validated the same way.
pub fn plan(source: &dyn FileSource, request: &Request) -> Result<CompiledManifest, Errors> {
    let (shelf, resolved) = resolve(source, request)?;
    compile(&shelf, &resolved)
}

/// Package one profile of the shelf `source` holds for a registry: the same
/// load and resolution as [`plan`], then [`crate::package::package`].
pub fn package_profile(
    source: &dyn FileSource,
    request: &Request,
) -> Result<PackagedProfile, Errors> {
    let (shelf, resolved) = resolve(source, request)?;
    package(&shelf, &resolved)
}

/// Resolve one profile of the shelf `source` holds: the same load and
/// resolution as [`plan`], without compiling. The composer's resolution rail
/// reads it, for a saved profile or an unsaved override.
pub fn resolution(source: &dyn FileSource, request: &Request) -> Result<ResolvedProfile, Errors> {
    resolve(source, request).map(|(_, resolved)| resolved)
}

/// Recommend items and profiles for a repository's markers, as `shelfkit
/// recommend` does.
pub fn recommend_markers(
    source: &dyn FileSource,
    markers: &Markers,
) -> Result<Recommendation, Errors> {
    let shelf = load(source)?;
    Ok(recommend(&shelf, markers))
}

/// Everything a host indexes about a shelf that loaded: the manifest, every
/// item with its revision and file paths, every bundle, and every profile
/// with its resolution. The hosted service stores this as metadata; the
/// bytes stay where they are.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub manifest: Manifest,
    /// Sorted by id.
    pub items: Vec<InventoryItem>,
    /// Sorted by id.
    pub bundles: Vec<Bundle>,
    /// Sorted by id.
    pub profiles: Vec<InventoryProfile>,
    /// What `shelfkit check` reports beyond errors.
    pub notices: Vec<Notice>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    /// The item as `item.json` serializes it.
    pub item: Item,
    /// The item directory, relative to the shelf root.
    pub path: String,
    pub revision: Revision,
    /// The item's files, relative to its directory, sorted.
    pub files: Vec<String>,
    /// What the item compiles to in a profile pinned by revision.
    pub coordinate: Coordinate,
}

/// Where an item lands in `apm.yml` when a profile with `pin: revision`
/// compiles it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Coordinate {
    /// A `dependencies.apm` reference to its upstream; `entry` is the entry
    /// as YAML.
    Upstream { entry: String },
    /// The item's content is vendored into the profile's local package.
    Vendored,
    /// A `dependencies.mcp` entry.
    Mcp { name: Option<String> },
    /// A `dependencies.lsp` entry.
    Lsp { name: String },
    /// The item's `source` cannot be referenced; compiling it fails.
    Unresolvable { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryProfile {
    /// The profile as `profiles/<id>.json` holds it.
    pub profile: Profile,
    pub resolution: ResolvedProfile,
}

/// Load the shelf `source` holds and index all of it.
pub fn inventory(source: &dyn FileSource) -> Result<Inventory, Errors> {
    let shelf = load(source)?;
    let mut errors = Errors::new();
    let mut profiles = Vec::new();
    for (id, profile) in &shelf.profiles {
        match shelf.resolve(id) {
            Ok(resolution) => profiles.push(InventoryProfile {
                profile: profile.clone(),
                resolution,
            }),
            Err(failed) => errors.extend(failed),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let items = shelf
        .items
        .values()
        .map(|loaded| InventoryItem {
            item: loaded.item.clone(),
            path: loaded.path.clone(),
            revision: loaded.revision.clone(),
            files: loaded.files.keys().cloned().collect(),
            coordinate: item_coordinate(&shelf, &loaded.item),
        })
        .collect();
    Ok(Inventory {
        notices: shelf.check(),
        manifest: shelf.manifest.clone(),
        items,
        bundles: shelf.bundles.values().cloned().collect(),
        profiles,
    })
}

fn item_coordinate(shelf: &Shelf, item: &Item) -> Coordinate {
    match &item.payload {
        Payload::Mcp(mcp) => Coordinate::Mcp {
            name: mcp.name().map(str::to_owned),
        },
        Payload::Lsp(lsp) => Coordinate::Lsp {
            name: lsp.name.clone(),
        },
        Payload::Hook(_) | Payload::Library(_) | Payload::Stack(_) | Payload::Doc(_) => {
            Coordinate::Vendored
        }
        _ => match item.source.as_ref().map(|source| {
            coordinate::upstream(item.kind(), source, &shelf.manifest.sources, Pin::Revision)
        }) {
            Some(Ok(Some(upstream))) => Coordinate::Upstream {
                entry: upstream_entry(&upstream),
            },
            Some(Err(message)) => Coordinate::Unresolvable { message },
            Some(Ok(None)) | None => Coordinate::Vendored,
        },
    }
}

fn upstream_entry(upstream: &Upstream) -> String {
    yaml::render(&upstream.entry(None))
}

fn resolve(source: &dyn FileSource, request: &Request) -> Result<(Shelf, ResolvedProfile), Errors> {
    let id = match profile_id(source, request)? {
        Some(id) => id,
        None => {
            // Load first: a broken shelf.json is the better error.
            load(source)?;
            return Err(Error::invalid(
                "shelf.json",
                "name a profile to compile: the shelf has no `defaultProfile`",
            )
            .into());
        }
    };
    let path = format!("profiles/{id}.json");

    let mut extra = MemorySource::new();
    let adjusted = request.targets.is_some() || request.allow_nonconformant_targets;
    let document = match &request.override_profile {
        Some(document) => Some(document.clone()),
        None if adjusted => source
            .read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()),
        None => None,
    };
    if let Some(mut document) = document {
        if let Some(object) = document.as_object_mut() {
            let compile = object
                .entry("compile")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(compile) = compile.as_object_mut() {
                if let Some(targets) = &request.targets {
                    compile.insert("targets".to_owned(), serde_json::json!(targets));
                }
                if request.allow_nonconformant_targets {
                    compile.insert(
                        "allowNonconformantTargets".to_owned(),
                        serde_json::json!(true),
                    );
                }
            }
        }
        // Serializing a JSON value cannot fail.
        extra.insert(
            &path,
            serde_json::to_vec_pretty(&document).unwrap_or_default(),
        );
    }

    let overlay = Overlay {
        base: source,
        extra,
    };
    let shelf = load(&overlay)?;
    let resolved = shelf.resolve(&id)?;
    Ok((shelf, resolved))
}

fn profile_id(source: &dyn FileSource, request: &Request) -> Result<Option<String>, Errors> {
    if let Some(document) = &request.override_profile {
        let Some(id) = document.get("id").and_then(serde_json::Value::as_str) else {
            return Err(
                Error::invalid("<override profile>", "the profile has no string `id`").into(),
            );
        };
        if let Some(requested) = request.profile.as_deref().filter(|r| *r != id) {
            return Err(Error::invalid(
                format!("profiles/{requested}.json"),
                format!("the override profile's id is `{id}`, not `{requested}`"),
            )
            .into());
        }
        return Ok(Some(id.to_owned()));
    }
    if let Some(id) = &request.profile {
        return Ok(Some(id.clone()));
    }
    Ok(source
        .read("shelf.json")
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|manifest| manifest.get("defaultProfile")?.as_str().map(str::to_owned)))
}

/// A file source with some files added or replaced.
pub struct Overlay<'a> {
    pub base: &'a dyn FileSource,
    pub extra: MemorySource,
}

impl FileSource for Overlay<'_> {
    fn list(&self, dir: &str) -> Listing {
        let mut listing = self.base.list(dir);
        for path in self.extra.list(dir).paths {
            if !listing.paths.contains(&path) {
                listing.paths.push(path);
            }
        }
        listing
    }

    fn read(&self, path: &str) -> shelfkit_core::Result<Vec<u8>> {
        match self.extra.read(path) {
            Ok(bytes) => Ok(bytes),
            Err(_) => self.base.read(path),
        }
    }
}
