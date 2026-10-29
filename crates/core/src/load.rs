//! Loading and validating a shelf.
//!
//! [`load`] reads `shelf.json`, `items/<kind>/<id>/`, `bundles/<id>.json`, and
//! `profiles/<id>.json` from a [`FileSource`], validates every file and every
//! reference, resolves every profile, and returns either a complete [`Shelf`]
//! or every error it found, each carrying the file it came from. `items/` is
//! the source of truth: nothing is written back, and there is no index file.

use crate::error::{Error, ErrorKind, Errors};
use crate::item::{self, Item, ItemKind, Mcp, Payload};
use crate::profile::{Bundle, ItemRef, Manifest, Profile};
use crate::revision::Revision;
use crate::secret;
use crate::shelf::{LoadedItem, Shelf};
use crate::source::{FileSource, Listing, check_path};
use crate::target::{self, TargetClass};
use serde::de::DeserializeOwned;
use std::collections::{BTreeMap, BTreeSet};

const SHELF_JSON: &str = "shelf.json";

pub(crate) const NONCONFORMANT: &str = "is outside the OpenAPM v0.1 producer set; \
    set `allowNonconformantTargets` to opt in";

const PROFILE_VERSION_MISSING: &str = "a profile needs a `version`, a semantic version such as \
    `0.1.0`: it is the version the profile publishes as";

/// Files desktop operating systems drop into directories by themselves. They
/// are ignored wherever they appear. Other dotfiles are content: a plugin's
/// `.claude-plugin/` directory is part of the plugin.
const OS_JUNK: &[&str] = &[".DS_Store", "Thumbs.db", "desktop.ini"];
const ITEM_JSON: &str = "item.json";

/// Load a shelf and validate all of it.
pub fn load(source: &dyn FileSource) -> Result<Shelf, Errors> {
    let mut loader = Loader {
        source,
        errors: Errors::new(),
    };

    let manifest = loader.manifest();
    let (items, item_dirs) = loader.items();
    let bundles = loader.documents::<Bundle>("bundles", |bundle| &bundle.id);
    let profiles = loader.documents::<Profile>("profiles", |profile| &profile.id);

    let known_items: BTreeSet<&str> = item_dirs.keys().map(String::as_str).collect();
    loader.check_item_references(&items, &known_items, manifest.as_ref());
    loader.check_bundles(&bundles, &known_items, &items);
    loader.check_profiles(&profiles, &bundles, &known_items, &items);
    if let Some(manifest) = &manifest {
        loader.check_manifest(manifest, &profiles);
    }
    loader.check_cycles(&profiles);

    let Loader { mut errors, .. } = loader;
    let manifest = match manifest {
        Some(manifest) if errors.is_empty() => manifest,
        // A missing or broken shelf.json is itself an error, so the list is
        // never empty here.
        _ => return Err(errors.sorted()),
    };

    let shelf = Shelf {
        manifest,
        items,
        bundles: bundles.into_iter().map(|(id, (_, b))| (id, b)).collect(),
        profiles: profiles.into_iter().map(|(id, (_, p))| (id, p)).collect(),
    };

    // Resolution is part of validation: a conflict between two items a
    // profile selects is a load error, like a cycle.
    for id in shelf.profiles.keys() {
        if let Err(conflicts) = crate::resolve::resolve(&shelf, id) {
            errors.extend(conflicts);
        }
    }
    errors.into_result(shelf)
}

struct Loader<'a> {
    source: &'a dyn FileSource,
    errors: Errors,
}

impl Loader<'_> {
    fn push(&mut self, path: impl Into<String>, kind: ErrorKind) {
        self.errors.push(Error::new(path, kind));
    }

    fn invalid(&mut self, path: impl Into<String>, message: impl Into<String>) {
        self.errors.push(Error::invalid(path, message));
    }

    /// Read a JSON file, refuse credentials anywhere in it, and deserialize.
    fn json<T: DeserializeOwned>(&mut self, path: &str, bytes: &[u8]) -> Option<T> {
        let value = self.json_value(path, bytes)?;
        match serde_json::from_value(value) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                self.invalid(path, error.to_string());
                None
            }
        }
    }

    fn json_value(&mut self, path: &str, bytes: &[u8]) -> Option<serde_json::Value> {
        let value: serde_json::Value = match serde_json::from_slice(bytes) {
            Ok(value) => value,
            Err(error) => {
                self.push(path, ErrorKind::Json(error.to_string()));
                return None;
            }
        };
        for (field, reason) in secret::scan_json(&value) {
            self.push(
                path,
                ErrorKind::Credential {
                    field,
                    reason: reason.to_owned(),
                },
            );
        }
        Some(value)
    }

    fn manifest(&mut self) -> Option<Manifest> {
        let bytes = match self.source.read(SHELF_JSON) {
            Ok(bytes) => bytes,
            Err(_) => {
                self.push(SHELF_JSON, ErrorKind::MissingFile(SHELF_JSON.into()));
                return None;
            }
        };
        self.json(SHELF_JSON, &bytes)
    }

    /// Load every item. Also returns every item directory by id, including
    /// those whose `item.json` failed, so a reference to a broken item is
    /// reported once, at the item, and not again at each reference.
    fn items(&mut self) -> (BTreeMap<String, LoadedItem>, BTreeMap<String, String>) {
        let mut directories: BTreeMap<(String, String), BTreeMap<String, Vec<u8>>> =
            BTreeMap::new();

        for path in self.list("items") {
            let segments: Vec<&str> = path.split('/').collect();
            let (kind_dir, id, rest) = match segments.as_slice() {
                [_, kind_dir, id, rest @ ..] => (*kind_dir, *id, rest),
                [_, name] => (*name, *name, [].as_slice()),
                _ => continue,
            };
            if rest.is_empty() {
                let name = segments.last().copied().unwrap_or_default();
                if !name.starts_with('.') {
                    self.invalid(&path, "unexpected file: items live in items/<kind>/<id>/");
                }
                continue;
            }
            if ItemKind::from_directory(kind_dir).is_none() {
                self.invalid(
                    format!("items/{kind_dir}"),
                    format!(
                        "unknown kind directory `{kind_dir}`; expected one of {}",
                        ItemKind::ALL.map(ItemKind::directory).join(", ")
                    ),
                );
                continue;
            }
            match self.source.read(&path) {
                Ok(bytes) => {
                    directories
                        .entry((kind_dir.to_owned(), id.to_owned()))
                        .or_default()
                        .insert(rest.join("/"), bytes);
                }
                Err(error) => self.errors.push(error),
            }
        }

        let mut items = BTreeMap::new();
        let mut item_dirs: BTreeMap<String, String> = BTreeMap::new();
        for ((kind_dir, id), files) in directories {
            let dir = format!("items/{kind_dir}/{id}");
            if let Some(other) = item_dirs.get(&id) {
                self.invalid(
                    format!("{dir}/{ITEM_JSON}"),
                    format!("id `{id}` is already used by {other}/{ITEM_JSON}"),
                );
                continue;
            }
            item_dirs.insert(id.clone(), dir.clone());
            if let Some(loaded) = self.item(&dir, &kind_dir, &id, files) {
                items.insert(id, loaded);
            }
        }
        (items, item_dirs)
    }

    fn list(&mut self, dir: &str) -> Vec<String> {
        let Listing { mut paths, errors } = self.source.list(dir);
        self.errors.extend(errors);
        paths.sort();
        // Files an operating system writes on its own are not part of the
        // shelf: hashing them would change a revision behind the author's back.
        paths.retain(|path| {
            let name = path.rsplit('/').next().unwrap_or_default();
            !OS_JUNK.contains(&name)
        });
        paths.retain(|path| match check_path(path) {
            Ok(()) => true,
            Err(error) => {
                self.errors.push(error);
                false
            }
        });
        paths
    }

    fn item(
        &mut self,
        dir: &str,
        kind_dir: &str,
        id: &str,
        files: BTreeMap<String, Vec<u8>>,
    ) -> Option<LoadedItem> {
        let path = format!("{dir}/{ITEM_JSON}");
        let Some(bytes) = files.get(ITEM_JSON) else {
            self.push(dir, ErrorKind::MissingFile(ITEM_JSON.into()));
            return None;
        };
        let value = self.json_value(&path, bytes)?;
        let item = match Item::from_value(value) {
            Ok(item) => item,
            Err(kind) => {
                self.push(&path, kind);
                return None;
            }
        };

        if let Err(kind) = item::validate_id(&item.id) {
            self.push(&path, kind);
        } else if item.id != id {
            self.invalid(
                &path,
                format!("`id` is `{}` but the directory is `{id}`", item.id),
            );
        }
        if item.kind().directory() != kind_dir {
            self.invalid(
                &path,
                format!(
                    "`kind` is `{}`, which lives in items/{}/, not items/{kind_dir}/",
                    item.kind(),
                    item.kind().directory()
                ),
            );
        }
        if item.title.trim().is_empty() {
            self.invalid(&path, "`title` must not be empty");
        }
        self.targets(&path, &item.targets, item.allow_nonconformant_targets);

        // Every other file is scanned for credentials too: JSON by field,
        // other text by line. Content that is not UTF-8 is not text.
        for (name, content) in &files {
            if name == ITEM_JSON {
                continue;
            }
            let file = format!("{dir}/{name}");
            if name.ends_with(".json") {
                if let Some(value) = self.json_value(&file, content)
                    && matches!(name.as_str(), "hook.json" | "plugin.json")
                    && !value.is_object()
                {
                    self.invalid(&file, "must be a JSON object");
                }
            } else if let Ok(text) = std::str::from_utf8(content) {
                for (index, line) in text.lines().enumerate() {
                    if let Some(reason) = secret::looks_like_credential(line) {
                        self.push(
                            &file,
                            ErrorKind::Credential {
                                field: format!("line {}", index + 1),
                                reason: reason.to_owned(),
                            },
                        );
                    }
                }
            }
        }

        self.payload(dir, &item, &files);

        Some(LoadedItem {
            revision: Revision::of_files(&files),
            item,
            path: dir.to_owned(),
            files,
        })
    }

    /// Check target slugs as written: refused slugs fail, and a CLI-only slug
    /// needs the opt-in. Profiles are checked again on their resolved
    /// settings, where `extends` may supply either.
    fn targets(&mut self, path: &str, slugs: &[String], opted_in: bool) {
        for slug in slugs {
            let reason = match target::classify(slug) {
                Ok(TargetClass::Canonical) => continue,
                Ok(TargetClass::CliOnly) if opted_in => continue,
                Ok(TargetClass::CliOnly) => NONCONFORMANT.to_owned(),
                Err(reason) => reason,
            };
            self.push(
                path,
                ErrorKind::Target {
                    slug: slug.clone(),
                    reason,
                },
            );
        }
    }

    /// The checks that depend on the kind.
    fn payload(&mut self, dir: &str, item: &Item, files: &BTreeMap<String, Vec<u8>>) {
        let path = format!("{dir}/{ITEM_JSON}");
        let kind = item.kind();

        // An authored item carries its content. An imported one may point at
        // it upstream instead, and is checked only on what it does carry.
        if item.source.is_none()
            && let Some(content) = kind.content_file()
            && !files.contains_key(content)
        {
            self.push(dir, ErrorKind::MissingFile(content.into()));
        }

        match &item.payload {
            Payload::Skill(_) => {
                if let Some(bytes) = files.get("SKILL.md") {
                    self.skill(&format!("{dir}/SKILL.md"), &item.id, bytes);
                }
            }
            Payload::Prompt(prompt) => {
                let mut seen = BTreeSet::new();
                for variable in &prompt.variables {
                    let name = &variable.name;
                    let valid = name.starts_with(|c: char| c.is_ascii_alphabetic())
                        && name
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
                    if !valid {
                        self.invalid(&path, format!("variable `{name}` must be a letter followed by letters, digits, `_`, or `-`"));
                    }
                    if !seen.insert(name.as_str()) {
                        self.invalid(&path, format!("variable `{name}` is declared twice"));
                    }
                    if variable.required && variable.default.is_some() {
                        self.invalid(
                            &path,
                            format!("variable `{name}` is required and has a default; pick one"),
                        );
                    }
                }
            }
            Payload::Instructions(instructions) => {
                if instructions.sections.is_empty()
                    && !files.contains_key("AGENTS.fragment.md")
                    && item.source.is_none()
                {
                    self.invalid(
                        &path,
                        "instructions need `sections`, an AGENTS.fragment.md, or both",
                    );
                }
                self.sections(&path, "sections", &instructions.sections);
            }
            Payload::Agent(_) | Payload::Hook(_) | Payload::Plugin(_) => {}
            Payload::Mcp(mcp) => self.mcp(&path, mcp),
            Payload::Lsp(lsp) => {
                let name_ok = lsp
                    .name
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '@' || c == '_')
                    && lsp.name.len() <= 128
                    && lsp
                        .name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._@/:=-".contains(c))
                    && !lsp.name.split('/').any(|segment| segment == "..");
                if !name_ok {
                    self.invalid(
                        &path,
                        format!("lsp `name` `{}` must match APM's `[a-zA-Z0-9@_][a-zA-Z0-9._@/:=-]{{0,127}}` with no `..` segment", lsp.name),
                    );
                }
                if lsp.command.trim().is_empty() || lsp.command.split('/').any(|s| s == "..") {
                    self.invalid(
                        &path,
                        "lsp `command` must be non-empty with no `..` segment",
                    );
                }
                if lsp.extension_to_language.is_empty() {
                    self.invalid(
                        &path,
                        "lsp `extensionToLanguage` must map at least one extension",
                    );
                }
                self.slots(&path, "env", &lsp.env);
            }
            Payload::Library(library) => {
                if let Some(docs) = &library.docs
                    && !is_http_url(docs)
                {
                    self.invalid(
                        &path,
                        format!("`docs` must be an http(s) URL, got `{docs}`"),
                    );
                }
            }
            Payload::Stack(stack) => {
                if stack.markers.is_empty() {
                    self.invalid(
                        &path,
                        "a stack needs at least one marker: markers are what make it detectable",
                    );
                }
                self.sections(&path, "conventions", &stack.conventions);
            }
            Payload::Doc(doc) => {
                if let Err(why) = item::validate_doc_path(&doc.path) {
                    self.invalid(&path, format!("doc `path` `{}` {why}", doc.path));
                }
            }
        }
    }

    fn sections(&mut self, path: &str, field: &str, sections: &[item::Section]) {
        for (index, section) in sections.iter().enumerate() {
            if section.heading.trim().is_empty() || section.body.trim().is_empty() {
                self.invalid(
                    path,
                    format!("`{field}[{index}]` needs a non-empty `heading` and `body`"),
                );
            }
        }
    }

    fn mcp(&mut self, path: &str, mcp: &Mcp) {
        match mcp {
            Mcp::Remote(remote) => {
                if remote.name.is_none() && remote.url.is_none() {
                    self.invalid(
                        path,
                        "a remote MCP server needs a `url`, or a registry `name` APM resolves",
                    );
                }
                if let Some(url) = &remote.url
                    && !is_http_url(url)
                {
                    self.invalid(path, format!("`url` must be an http(s) URL, got `{url}`"));
                }
                self.slots(path, "headers", &remote.headers);
            }
            Mcp::Stdio(stdio) => {
                if stdio.command.trim().is_empty() {
                    self.invalid(path, "a stdio MCP server needs a `command`");
                }
                self.slots(path, "env", &stdio.env);
            }
            Mcp::Hosted(hosted) => {
                // ShelfKit injects a credential into the relayed call, so the
                // upstream must be reached over TLS.
                if !hosted.url.starts_with("https://") {
                    self.invalid(
                        path,
                        format!(
                            "a hosted MCP server's upstream `url` must be https, got `{}`",
                            hosted.url
                        ),
                    );
                }
                self.slots(path, "headers", &hosted.headers);
            }
        }
        if let Some(name) = mcp.name()
            && (name.is_empty() || name.contains(char::is_whitespace))
        {
            self.invalid(
                path,
                format!("MCP `name` `{name}` must be non-empty with no spaces"),
            );
        }
    }

    fn slots(&mut self, path: &str, field: &str, values: &BTreeMap<String, secret::SecretValue>) {
        for (name, value) in values {
            if let Some(reason) = secret::check_slot(name, value) {
                self.push(
                    path,
                    ErrorKind::Credential {
                        field: format!("/{field}/{name}"),
                        reason: reason.to_owned(),
                    },
                );
            }
        }
    }

    /// Check `SKILL.md`'s frontmatter. Only the problems that stop an agent
    /// from using the skill fail the load; [`Shelf::check`] reports the rest.
    fn skill(&mut self, path: &str, id: &str, bytes: &[u8]) {
        for problem in crate::skill::check_frontmatter(id, bytes).hard {
            self.push(path, ErrorKind::Frontmatter(problem));
        }
    }

    /// Load `<dir>/<id>.json` documents: bundles and profiles.
    fn documents<T: DeserializeOwned>(
        &mut self,
        dir: &str,
        id_of: impl Fn(&T) -> &String,
    ) -> BTreeMap<String, (String, T)> {
        let mut documents = BTreeMap::new();
        for path in self.list(dir) {
            let name = &path[dir.len() + 1..];
            if name.starts_with('.') {
                continue;
            }
            let Some(stem) = name
                .strip_suffix(".json")
                .filter(|stem| !stem.contains('/'))
            else {
                self.invalid(
                    &path,
                    format!("unexpected file: {dir}/ holds only <id>.json files"),
                );
                continue;
            };
            let bytes = match self.source.read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.errors.push(error);
                    continue;
                }
            };
            let Some(document) = self.json::<T>(&path, &bytes) else {
                continue;
            };
            let id = id_of(&document).clone();
            if let Err(kind) = item::validate_id(&id) {
                self.push(&path, kind);
                continue;
            }
            if id != stem {
                self.invalid(
                    &path,
                    format!("`id` is `{id}` but the file is `{stem}.json`"),
                );
                continue;
            }
            documents.insert(id, (path, document));
        }
        documents
    }

    fn check_item_references(
        &mut self,
        items: &BTreeMap<String, LoadedItem>,
        known: &BTreeSet<&str>,
        manifest: Option<&Manifest>,
    ) {
        for loaded in items.values() {
            let path = loaded.item_json();
            for required in &loaded.item.requires {
                if required == &loaded.item.id {
                    self.invalid(&path, "`requires` must not name the item itself");
                } else if !known.contains(required.as_str()) {
                    self.unknown(&path, "requires", "item", required);
                }
            }
            if let Payload::Stack(stack) = &loaded.item.payload {
                for recommended in &stack.recommends {
                    if !known.contains(recommended.as_str()) {
                        self.unknown(&path, "recommends", "item", recommended);
                    }
                }
            }
            if let (Some(source_id), Some(manifest)) = (
                loaded.item.source.as_ref().and_then(|s| s.id.as_ref()),
                manifest,
            ) && !manifest.sources.iter().any(|s| &s.id == source_id)
            {
                self.unknown(&path, "source.id", "source", source_id);
            }
        }
    }

    fn unknown(&mut self, path: &str, field: &str, what: &'static str, target: &str) {
        self.push(
            path,
            ErrorKind::UnknownReference {
                field: field.to_owned(),
                what,
                target: target.to_owned(),
            },
        );
    }

    /// Check one file's item list: every id exists, no id is pinned two ways,
    /// and every pin is a revision the source holds.
    ///
    /// A shelf loaded from files holds each item only at its current revision,
    /// so a pin to any other revision cannot be compiled and fails the load.
    /// Serving older revisions (from snapshots the hosted service keeps) is a
    /// later concern; it would widen what this check accepts, nothing else.
    fn check_refs(
        &mut self,
        path: &str,
        field: &str,
        refs: &[ItemRef],
        known: &BTreeSet<&str>,
        items: &BTreeMap<String, LoadedItem>,
    ) {
        let mut seen: BTreeMap<&str, &ItemRef> = BTreeMap::new();
        for entry in refs {
            if !known.contains(entry.id.as_str()) {
                self.unknown(path, field, "item", &entry.id);
            }
            if let (Some(pin), Some(loaded)) = (&entry.revision, items.get(&entry.id))
                && pin != &loaded.revision
            {
                self.push(
                    path,
                    ErrorKind::RevisionMismatch {
                        id: entry.id.clone(),
                        expected: pin.to_string(),
                        actual: loaded.revision.to_string(),
                    },
                );
            }
            if let Some(previous) = seen.insert(&entry.id, entry)
                && previous.revision != entry.revision
            {
                self.invalid(
                    path,
                    format!("`{field}` lists `{previous}` and `{entry}`; pick one pin"),
                );
            }
        }
    }

    fn check_bundles(
        &mut self,
        bundles: &BTreeMap<String, (String, Bundle)>,
        known: &BTreeSet<&str>,
        items: &BTreeMap<String, LoadedItem>,
    ) {
        for (path, bundle) in bundles.values() {
            self.check_refs(path, "items", &bundle.items, known, items);
        }
    }

    fn check_profiles(
        &mut self,
        profiles: &BTreeMap<String, (String, Profile)>,
        bundles: &BTreeMap<String, (String, Bundle)>,
        known: &BTreeSet<&str>,
        items: &BTreeMap<String, LoadedItem>,
    ) {
        let by_id: BTreeMap<String, Profile> = profiles
            .iter()
            .map(|(id, (_, profile))| (id.clone(), profile.clone()))
            .collect();

        for (id, (path, profile)) in profiles {
            // The profile's own list. A bundle's list is checked once, at the
            // bundle's file, not again at every profile that names it.
            self.check_refs(path, "items", &profile.items, known, items);

            // Across files, one id may still not be pinned two ways: that is
            // this profile's doing, so it is reported here.
            let mut lists: Vec<(String, &[ItemRef])> =
                vec![("`items`".to_owned(), profile.items.as_slice())];
            for bundle in &profile.bundles {
                match bundles.get(bundle) {
                    Some((_, b)) => lists.push((format!("bundle `{bundle}`"), b.items.as_slice())),
                    None => self.unknown(path, "bundles", "bundle", bundle),
                }
            }
            let mut first: BTreeMap<&str, (&str, &ItemRef)> = BTreeMap::new();
            for (label, refs) in &lists {
                for entry in *refs {
                    match first.get(entry.id.as_str()) {
                        Some((other, previous))
                            if other != label && previous.revision != entry.revision =>
                        {
                            self.invalid(
                                path.clone(),
                                format!(
                                    "{other} lists `{previous}` and {label} lists `{entry}`; pick one pin"
                                ),
                            );
                        }
                        Some(_) => {}
                        None => {
                            first.insert(&entry.id, (label, entry));
                        }
                    }
                }
            }

            for parent in &profile.extends {
                if !profiles.contains_key(parent) {
                    self.unknown(path, "extends", "profile", parent);
                }
            }

            // Refused slugs are reported where they are written. Whether a
            // CLI-only slug is opted into depends on the resolved settings,
            // since `extends` may supply the targets, the opt-in, or both.
            let written = profile.compile.targets.clone().unwrap_or_default();
            for slug in &written {
                if let Err(reason) = target::classify(slug) {
                    self.push(
                        path.clone(),
                        ErrorKind::Target {
                            slug: slug.clone(),
                            reason,
                        },
                    );
                }
            }
            let resolved = crate::resolve::settings(&by_id, id);
            if !resolved.allow_nonconformant_targets {
                for slug in &resolved.targets {
                    if target::classify(slug) == Ok(TargetClass::CliOnly) {
                        self.push(
                            path.clone(),
                            ErrorKind::Target {
                                slug: slug.clone(),
                                reason: NONCONFORMANT.replace(
                                    "set `allowNonconformantTargets`",
                                    "set `compile.allowNonconformantTargets` here or in a profile it extends",
                                ),
                            },
                        );
                    }
                }
            }
            let version = &profile.version;
            if version.trim().is_empty() {
                self.invalid(path.clone(), PROFILE_VERSION_MISSING);
            } else if !crate::profile::is_semver(version) {
                self.invalid(
                    path.clone(),
                    format!(
                        "`version` `{version}` is not a semantic version (`MAJOR.MINOR.PATCH`, with an \
                         optional `-prerelease` and `+build`)"
                    ),
                );
            }
            if profile
                .compile
                .name
                .as_deref()
                .is_some_and(|n| n.trim().is_empty())
            {
                self.invalid(path.clone(), "`compile.name` must not be empty");
            }
        }
    }

    fn check_manifest(
        &mut self,
        manifest: &Manifest,
        profiles: &BTreeMap<String, (String, Profile)>,
    ) {
        if manifest.name.trim().is_empty() {
            self.invalid(SHELF_JSON, "`name` must not be empty");
        }
        if let Some(default) = &manifest.default_profile
            && !profiles.contains_key(default)
        {
            self.unknown(SHELF_JSON, "defaultProfile", "profile", default);
        }
        if let Some(registry) = &manifest.registry
            && let Err(ErrorKind::Invalid(message)) = item::validate_id(&registry.namespace)
        {
            self.invalid(SHELF_JSON, format!("`registry.namespace`: {message}"));
        }
        let mut seen = BTreeSet::new();
        for source in &manifest.sources {
            if let Err(ErrorKind::Invalid(message)) = item::validate_id(&source.id) {
                self.invalid(SHELF_JSON, format!("`sources`: {message}"));
            }
            if let Some(name) = &source.secret
                && !crate::secret::is_secret_name(name)
            {
                self.invalid(
                    SHELF_JSON,
                    format!(
                        "source `{}`: secret name `{name}` must be UPPER_SNAKE_CASE",
                        source.id
                    ),
                );
            }
            if !seen.insert(source.id.as_str()) {
                self.invalid(
                    SHELF_JSON,
                    format!("source `{}` is declared twice", source.id),
                );
            }
        }
    }

    /// Report `extends` cycles at the profile with the smallest id in each, as
    /// the chain that closes it. A depth-first walk that visits each profile
    /// once: linear in profiles and edges.
    fn check_cycles(&mut self, profiles: &BTreeMap<String, (String, Profile)>) {
        let mut finished: BTreeSet<String> = BTreeSet::new();
        let mut cycles: BTreeSet<Vec<String>> = BTreeSet::new();
        for start in profiles.keys() {
            let mut stack = Vec::new();
            walk(profiles, start, &mut stack, &mut finished, &mut cycles);
        }
        for cycle in cycles {
            let Some(first) = cycle.first() else { continue };
            if let Some((path, _)) = profiles.get(first) {
                self.push(path.clone(), ErrorKind::ExtendsCycle(cycle));
            }
        }
    }
}

fn walk(
    profiles: &BTreeMap<String, (String, Profile)>,
    current: &str,
    stack: &mut Vec<String>,
    finished: &mut BTreeSet<String>,
    cycles: &mut BTreeSet<Vec<String>>,
) {
    if finished.contains(current) {
        return;
    }
    let Some((_, profile)) = profiles.get(current) else {
        return;
    };
    stack.push(current.to_owned());
    for parent in &profile.extends {
        if let Some(position) = stack.iter().position(|id| id == parent) {
            // Rotate so the chain starts at its smallest id: one cycle, one
            // report, however it was entered.
            let mut cycle: Vec<String> = stack[position..].to_vec();
            if let Some(min) = cycle
                .iter()
                .enumerate()
                .min_by_key(|(_, id)| *id)
                .map(|(i, _)| i)
            {
                cycle.rotate_left(min);
            }
            if let Some(first) = cycle.first().cloned() {
                cycle.push(first);
            }
            cycles.insert(cycle);
        } else {
            walk(profiles, parent, stack, finished, cycles);
        }
    }
    stack.pop();
    finished.insert(current.to_owned());
}

fn is_http_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}
