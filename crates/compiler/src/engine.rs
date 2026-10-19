//! Load, resolve, and compile in one call: the entry point the CLI and the
//! WASM engine share, so `compile --dry-run` and the composer preview run the
//! same code over the same bytes.

use crate::manifest::{CompiledManifest, compile};
use shelfkit_core::{Error, Errors, FileSource, Listing, MemorySource, load};

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
    compile(&shelf, &resolved)
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
