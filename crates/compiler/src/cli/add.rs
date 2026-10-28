//! `shelfkit add <path>`: import items from a local directory or file.
//!
//! Only the `path` source kind is here (`docs/PRD.md` section 6, last row):
//! discovery reads APM's package layouts from a directory on this machine and
//! copies what it finds into the shelf as items with no upstream, marked
//! local by a `source` that names a `path` source in `shelf.json`. Nothing
//! here touches the network: every other source kind is imported by the
//! hosted service's import job (`add_remote.rs`).
//!
//! What a directory yields, following APM's layouts:
//!
//! | Found | Becomes |
//! | --- | --- |
//! | `.apm/skills/<n>/SKILL.md`, `.apm/prompts/*.prompt.md`, `.apm/agents/*.agent.md`, `.apm/instructions/*.instructions.md`, `.apm/hooks/*.json` | one item each |
//! | `SKILL.md` at the root | one skill, the whole directory |
//! | `plugin.json` or `.claude-plugin/` at the root | one plugin, the whole directory |
//! | `skills/<n>/SKILL.md`, `hooks/*.json` | one item each |
//! | `AGENTS.md` at the root, and the markdown files it links to | one `instructions` item, and one `doc` per file |
//!
//! The last row is ShelfKit's, not APM's, and follows the same rule as the
//! hosted importer (`linked_docs.rs`): each doc's `path` is where it sits in
//! the directory, which is how AGENTS.md links to it, and each linking item
//! `requires` the docs it links to, so a profile that selects AGENTS.md gets
//! them. Their ids come from their file names, kebab-cased and made unique.
//! A linked doc the shelf already has at that `path` is not imported again:
//! the linking item requires the shelf's own, which is the doc the compiler
//! points the link at. When the shelf has more than one there, the link is
//! imported with neither required, and the import says so.
//!
//! A single `*.prompt.md`, `*.agent.md`, or `*.instructions.md` file yields
//! one item, and any other markdown file a doc whose `path` is where it sits
//! in its repository, which is how that repository's instructions link to it.
//! Every item is validated with the rest of the shelf before anything is
//! written, and an id from an APM layout that is not kebab-case is refused
//! rather than renamed.

use super::linked_docs;
use crate::engine::Overlay;
use shelfkit_core::item::Payload;
use shelfkit_core::profile::{ShelfSource, SourceKind};
use shelfkit_core::{DirSource, Item, ItemKind, Manifest, MemorySource, load};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// One discovered primitive.
#[derive(Debug)]
struct Found {
    kind: ItemKind,
    id: String,
    description: String,
    /// Where it was, relative to the source root.
    path: String,
    /// The item's content files, relative to its directory.
    files: BTreeMap<String, Vec<u8>>,
    /// The title, when the file names one (a doc's first heading); else the id.
    title: Option<String>,
    /// What the kind adds to the common fields of `item.json` (a doc's `path`).
    fields: serde_json::Map<String, serde_json::Value>,
}

/// The files to write into the shelf, relative to its root, and the ids added.
pub struct Import {
    pub files: BTreeMap<String, Vec<u8>>,
    pub items: Vec<(ItemKind, String)>,
    /// What the import left out, for the command to report.
    pub warnings: Vec<String>,
}

pub fn import(shelf_root: &Path, target: &Path, source_id: Option<&str>) -> Result<Import, String> {
    let target = target
        .canonicalize()
        .map_err(|error| format!("{}: {error}", target.display()))?;
    let mut warnings = Vec::new();
    let (root, found) = if target.is_file() {
        let found = single_file(&target, &file_name(&target))?;
        // A doc's source is its repository, so every doc from one repository shares one source.
        let root = if found.kind == ItemKind::Doc {
            repository_of(&target).to_path_buf()
        } else {
            target.parent().map(Path::to_path_buf).unwrap_or_default()
        };
        (root, vec![found])
    } else {
        let on_shelf = shelf_docs(shelf_root);
        (target.clone(), discover(&target, &on_shelf, &mut warnings)?)
    };
    if found.is_empty() {
        return Err(format!(
            "{}: found no skill, prompt, agent, instructions, hook, or plugin in an APM layout \
             (.apm/, SKILL.md, plugin.json, skills/<name>/SKILL.md, hooks/*.json), and no AGENTS.md",
            target.display()
        ));
    }

    let manifest_bytes = std::fs::read(shelf_root.join("shelf.json"))
        .map_err(|error| format!("shelf.json: {error}"))?;
    let mut manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| format!("shelf.json: {error}"))?;
    let source_id = match source_id {
        Some(id) => id.to_owned(),
        None => kebab(&file_name(&root)).ok_or_else(|| {
            format!(
                "cannot name a source after `{}`; pass `--source-id <kebab-case-id>`",
                root.display()
            )
        })?,
    };
    let root_text = root.display().to_string();
    match manifest.sources.iter().find(|s| s.id == source_id) {
        Some(existing)
            if existing.kind == SourceKind::Path
                && existing.path.as_deref() == Some(&root_text) => {}
        Some(_) => {
            return Err(format!(
                "shelf.json already has a source `{source_id}` that is not this directory; pass \
                 `--source-id` to name this one"
            ));
        }
        None => manifest.sources.push(ShelfSource {
            id: source_id.clone(),
            kind: SourceKind::Path,
            repo: None,
            url: None,
            path: Some(root_text),
            tier: None,
            profile: None,
            secret: None,
        }),
    }

    let mut files = BTreeMap::new();
    let mut items = Vec::new();
    for found in found {
        let directory = format!("items/{}/{}", found.kind.directory(), found.id);
        if shelf_root.join(&directory).exists() {
            return Err(format!(
                "{directory} already exists; remove it with `shelfkit rm {}` first",
                found.id
            ));
        }
        let mut document = serde_json::json!({
            "id": found.id,
            "kind": found.kind,
            "title": found.title.as_deref().unwrap_or(&found.id),
            "description": found.description,
            "source": { "id": source_id, "path": found.path },
        });
        if let Some(object) = document.as_object_mut() {
            object.extend(found.fields);
        }
        let item =
            Item::from_value(document).map_err(|error| format!("{}: {error}", found.path))?;
        files.insert(
            format!("{directory}/item.json"),
            item.to_json().into_bytes(),
        );
        for (name, bytes) in found.files {
            files.insert(format!("{directory}/{name}"), bytes);
        }
        items.push((found.kind, found.id));
    }
    let mut manifest_text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    manifest_text.push('\n');
    files.insert("shelf.json".to_owned(), manifest_text.into_bytes());

    // The shelf with the import, validated before a byte is written.
    let base = DirSource::new(shelf_root);
    let mut extra = MemorySource::new();
    for (path, bytes) in &files {
        extra.insert(path.clone(), bytes.clone());
    }
    load(&Overlay { base: &base, extra }).map_err(|errors| {
        format!("the import would not load, so nothing was written:\n{errors}")
    })?;
    Ok(Import {
        files,
        items,
        warnings,
    })
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A directory or file name as an id: lowercase, with `_`, `.`, and spaces
/// as hyphens. `None` when that still is not a valid id.
fn kebab(name: &str) -> Option<String> {
    let id: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if matches!(c, '_' | '.' | ' ') { '-' } else { c })
        .collect();
    shelfkit_core::item::validate_id(&id).ok().map(|()| id)
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// An id from a name, refused rather than renamed when it is not kebab-case.
fn id_from(name: &str, at: &Path) -> Result<String, String> {
    shelfkit_core::item::validate_id(name)
        .map(|()| name.to_owned())
        .map_err(|error| format!("{}: {error}; rename it upstream to import it", at.display()))
}

/// The `description` in a markdown file's frontmatter, and the body after it.
fn frontmatter(text: &str) -> (Option<serde_yaml::Mapping>, String) {
    let normalized = text.replace("\r\n", "\n");
    if let Some(rest) = normalized.strip_prefix("---\n")
        && let Some((yaml, body)) = rest
            .split_once("\n---\n")
            .or_else(|| rest.strip_suffix("\n---").map(|y| (y, "")))
        && let Ok(serde_yaml::Value::Mapping(map)) = serde_yaml::from_str(yaml)
    {
        return (Some(map), body.trim_start_matches('\n').to_owned());
    }
    (None, normalized)
}

fn description_of(map: Option<&serde_yaml::Mapping>) -> String {
    map.and_then(|m| m.get("description"))
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn single_file(path: &Path, name: &str) -> Result<Found, String> {
    let root = path.parent().unwrap_or(path);
    for (suffix, kind) in [
        (".prompt.md", ItemKind::Prompt),
        (".agent.md", ItemKind::Agent),
        (".instructions.md", ItemKind::Instructions),
    ] {
        if let Some(stem) = name.strip_suffix(suffix) {
            return markdown(kind, &id_from(stem, path)?, path, root);
        }
    }
    if name == "SKILL.md" {
        return skill(root, root.parent().unwrap_or(root));
    }
    if let Some(stem) = name.strip_suffix(".md") {
        return doc(path, stem);
    }
    Err(format!(
        "{}: a single file must be a `.prompt.md`, `.agent.md`, or `.instructions.md`, a SKILL.md, or another \
         markdown file, which becomes a doc",
        path.display()
    ))
}

/// The repository a file is in: the nearest directory up with a `.git`, else the file's own directory.
fn repository_of(file: &Path) -> &Path {
    file.ancestors()
        .skip(1)
        .find(|dir| dir.join(".git").exists())
        .or_else(|| file.parent())
        .unwrap_or(file)
}

/// Any other markdown file is a doc. Its `path` is where it sits in its repository (the nearest directory up with a
/// `.git`), which is how that repository's instructions link to it; its title is its first top-level heading.
fn doc(file: &Path, stem: &str) -> Result<Found, String> {
    let id = kebab(stem).ok_or_else(|| {
        format!(
            "{}: cannot name a doc after `{stem}`; rename the file to kebab-case to import it",
            file.display()
        )
    })?;
    doc_at(file, relative(repository_of(file), file), id)
}

/// A markdown text's first top-level heading after its frontmatter.
fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(|title| title.trim().to_owned())
        .filter(|title| !title.is_empty())
}

/// The doc in `file`, at `path` in its repository, as `id`.
fn doc_at(file: &Path, path: String, id: String) -> Result<Found, String> {
    let bytes = read(file)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (map, body) = frontmatter(&text);
    let title = first_heading(&body);
    Ok(Found {
        description: description_of(map.as_ref()),
        fields: serde_json::Map::from_iter([(
            "path".to_owned(),
            serde_json::Value::String(path.clone()),
        )]),
        files: BTreeMap::from([("doc.md".to_owned(), bytes)]),
        id,
        kind: ItemKind::Doc,
        path,
        title,
    })
}

/// The ids of the shelf's docs by the `path` each installs at. A shelf that does not load has none to offer; the
/// import's own check reports why it does not.
fn shelf_docs(shelf_root: &Path) -> BTreeMap<String, Vec<String>> {
    let mut docs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if let Ok(shelf) = load(&DirSource::new(shelf_root)) {
        for loaded in shelf.items.values() {
            if let Payload::Doc(doc) = &loaded.item.payload {
                docs.entry(doc.path.clone())
                    .or_default()
                    .push(loaded.item.id.clone());
            }
        }
    }
    docs
}

/// What a directory offers: its APM layouts, then its AGENTS.md and the docs that links to.
fn discover(
    root: &Path,
    on_shelf: &BTreeMap<String, Vec<String>>,
    warnings: &mut Vec<String>,
) -> Result<Vec<Found>, String> {
    let mut found = layouts(root)?;
    let linked = agents_and_docs(root, &found, on_shelf, warnings)?;
    found.extend(linked);
    Ok(found)
}

/// A name as an id: kebab-case, at most 64 characters, as the hosted importer makes one; empty when nothing is left.
fn slug(name: &str) -> String {
    let mut id = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            id.push(c.to_ascii_lowercase());
        } else if !id.is_empty() && !id.ends_with('-') {
            id.push('-');
        }
    }
    let mut id: String = id
        .chars()
        .take(shelfkit_core::item::MAX_ID_LENGTH)
        .collect();
    while id.ends_with('-') {
        id.pop();
    }
    id
}

/// An id for `name` that none in `taken` has: the name's own, then with its `qualifier`, then numbered.
fn unique_id(name: &str, fallback: &str, qualifier: &str, taken: &mut BTreeSet<String>) -> String {
    let base = match slug(name) {
        id if id.is_empty() => fallback.to_owned(),
        id => id,
    };
    let qualified = slug(&format!("{base}-{qualifier}"));
    let mut id = [base.clone(), qualified]
        .into_iter()
        .find(|id| !taken.contains(id));
    let mut n = 2;
    while id.is_none() {
        let suffix = format!("-{n}");
        let keep = shelfkit_core::item::MAX_ID_LENGTH - suffix.len();
        let numbered = format!(
            "{}{suffix}",
            base.chars()
                .take(keep)
                .collect::<String>()
                .trim_end_matches('-')
        );
        if !taken.contains(&numbered) {
            id = Some(numbered);
        }
        n += 1;
    }
    let id = id.unwrap_or(base);
    taken.insert(id.clone());
    id
}

/// The directory's AGENTS.md as instructions, and every doc its links reach (`linked_docs.rs`) that the shelf does not
/// have at its `path` yet, each requiring the docs it links to: those imported with it, or the shelf's own at that
/// path. Nothing when AGENTS.md is missing or a symbolic link (a CLAUDE.md's target, say).
fn agents_and_docs(
    root: &Path,
    layouts: &[Found],
    on_shelf: &BTreeMap<String, Vec<String>>,
    warnings: &mut Vec<String>,
) -> Result<Vec<Found>, String> {
    let agents = root.join("AGENTS.md");
    if !std::fs::symlink_metadata(&agents).is_ok_and(|meta| meta.file_type().is_file()) {
        return Ok(Vec::new());
    }
    let followed = linked_docs::follow(root);
    if followed.truncated {
        warnings.push(format!(
            "AGENTS.md links to more than {0} docs; only the first {0} were imported",
            linked_docs::MAX_DOCS
        ));
    }
    let mut taken: BTreeSet<String> = layouts.iter().map(|found| found.id.clone()).collect();
    let instructions_id = unique_id(&file_name(root), "instructions", "instructions", &mut taken);
    // Each linked doc's id: the shelf's own doc at its path, or a new one for the copy imported here.
    let mut ids: BTreeMap<&str, String> = BTreeMap::new();
    let mut new_docs = Vec::new();
    for doc in &followed.docs {
        match on_shelf.get(&doc.path).map(Vec::as_slice) {
            Some([id]) => {
                warnings.push(format!(
                    "{}: the shelf has it already, as doc `{id}`, so it was not imported again; what links to it \
                     requires that one",
                    doc.path
                ));
                ids.insert(doc.path.as_str(), id.clone());
            }
            Some(several) => {
                warnings.push(format!(
                    "{}: the shelf has {} docs at this path ({}), so it was not imported again and nothing that \
                     links to it requires one; add the one meant to its requires",
                    doc.path,
                    several.len(),
                    several.join(", ")
                ));
            }
            None => {
                let stem = doc.path.rsplit('/').next().unwrap_or(&doc.path);
                let stem = stem.strip_suffix(".md").unwrap_or(stem);
                ids.insert(doc.path.as_str(), unique_id(stem, "doc", "doc", &mut taken));
                new_docs.push(doc);
            }
        }
    }
    let requires = |links: &[String], own: &str| -> serde_json::Value {
        let mut required: Vec<&str> = links
            .iter()
            .filter_map(|link| ids.get(link.as_str()).map(String::as_str))
            .filter(|id| *id != own)
            .collect();
        required.sort_unstable();
        required.dedup();
        serde_json::json!(required)
    };

    let mut found = Vec::new();
    let mut instructions = markdown(ItemKind::Instructions, &instructions_id, &agents, root)?;
    let text = String::from_utf8_lossy(&read(&agents)?).into_owned();
    instructions.title = first_heading(&frontmatter(&text).1);
    if !followed.links.is_empty() {
        instructions.fields.insert(
            "requires".to_owned(),
            requires(&followed.links, &instructions_id),
        );
    }
    found.push(instructions);
    for doc in new_docs {
        let id = ids.get(doc.path.as_str()).cloned().unwrap_or_default();
        let mut item = doc_at(&root.join(&doc.path), doc.path.clone(), id.clone())?;
        if !doc.links.is_empty() {
            item.fields
                .insert("requires".to_owned(), requires(&doc.links, &id));
        }
        found.push(item);
    }
    Ok(found)
}

/// What APM's package layouts find in a directory.
fn layouts(root: &Path) -> Result<Vec<Found>, String> {
    let mut found = Vec::new();
    let apm = root.join(".apm");
    if apm.is_dir() {
        for dir in sorted_dirs(&apm.join("skills")) {
            if dir.join("SKILL.md").is_file() {
                found.push(skill(&dir, root)?);
            }
        }
        for (sub, suffix, kind) in [
            ("prompts", ".prompt.md", ItemKind::Prompt),
            ("agents", ".agent.md", ItemKind::Agent),
            ("instructions", ".instructions.md", ItemKind::Instructions),
        ] {
            for file in sorted_files(&apm.join(sub)) {
                if let Some(stem) = file_name(&file).strip_suffix(suffix) {
                    found.push(markdown(kind, &id_from(stem, &file)?, &file, root)?);
                }
            }
        }
        found.extend(hooks(&apm.join("hooks"), root)?);
        return Ok(found);
    }
    if root.join("SKILL.md").is_file() {
        return Ok(vec![skill(root, root.parent().unwrap_or(root))?]);
    }
    if root.join("plugin.json").is_file() || root.join(".claude-plugin").is_dir() {
        let id = id_from(&file_name(root), root)?;
        return Ok(vec![Found {
            kind: ItemKind::Plugin,
            id,
            description: String::new(),
            path: ".".to_owned(),
            files: tree(root)?,
            title: None,
            fields: serde_json::Map::new(),
        }]);
    }
    for dir in sorted_dirs(&root.join("skills")) {
        if dir.join("SKILL.md").is_file() {
            found.push(skill(&dir, root)?);
        }
    }
    found.extend(hooks(&root.join("hooks"), root)?);
    Ok(found)
}

fn hooks(dir: &Path, root: &Path) -> Result<Vec<Found>, String> {
    let mut found = Vec::new();
    for file in sorted_files(dir) {
        if let Some(stem) = file_name(&file).strip_suffix(".json") {
            found.push(Found {
                kind: ItemKind::Hook,
                id: id_from(stem, &file)?,
                description: String::new(),
                path: relative(root, &file),
                files: BTreeMap::from([("hook.json".to_owned(), read(&file)?)]),
                title: None,
                fields: serde_json::Map::new(),
            });
        }
    }
    Ok(found)
}

/// A skill directory, copied whole. Its id is the directory name, which the
/// loader checks against the frontmatter `name`.
fn skill(dir: &Path, root: &Path) -> Result<Found, String> {
    let text = String::from_utf8_lossy(&read(&dir.join("SKILL.md"))?).into_owned();
    let (map, _) = frontmatter(&text);
    let name = map
        .as_ref()
        .and_then(|m| m.get("name"))
        .and_then(serde_yaml::Value::as_str)
        .map_or_else(|| file_name(dir), str::to_owned);
    Ok(Found {
        kind: ItemKind::Skill,
        id: id_from(&name, dir)?,
        description: description_of(map.as_ref()),
        path: relative(root, dir),
        files: tree(dir)?,
        title: None,
        fields: serde_json::Map::new(),
    })
}

fn markdown(kind: ItemKind, id: &str, file: &Path, root: &Path) -> Result<Found, String> {
    let bytes = read(file)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (map, body) = frontmatter(&text);
    let description = description_of(map.as_ref());
    let files = match kind {
        ItemKind::Prompt => BTreeMap::from([("prompt.md".to_owned(), bytes)]),
        ItemKind::Agent => BTreeMap::from([("agent.md".to_owned(), bytes)]),
        _ => {
            if map.as_ref().is_some_and(|m| m.contains_key("applyTo")) {
                return Err(format!(
                    "{}: `applyTo` has no field in a shelf instructions item yet, and importing \
                     it without one would apply it everywhere; not imported",
                    file.display()
                ));
            }
            BTreeMap::from([("AGENTS.fragment.md".to_owned(), body.into_bytes())])
        }
    };
    Ok(Found {
        kind,
        id: id.to_owned(),
        description,
        path: relative(root, file),
        files,
        title: None,
        fields: serde_json::Map::new(),
    })
}

/// Every regular file under `dir`, by relative path. Symbolic links are
/// refused, as the loader refuses them.
fn tree(dir: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(&current)
            .map_err(|error| format!("{}: {error}", current.display()))?;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let kind = entry
                .file_type()
                .map_err(|error| format!("{}: {error}", path.display()))?;
            if kind.is_symlink() {
                return Err(format!(
                    "{}: symbolic links are not allowed in a shelf",
                    path.display()
                ));
            }
            if kind.is_dir() {
                stack.push(path);
            } else if !matches!(
                file_name(&path).as_str(),
                ".DS_Store" | "Thumbs.db" | "desktop.ini"
            ) {
                files.insert(relative(dir, &path), read(&path)?);
            }
        }
    }
    if files.contains_key("item.json") {
        return Err(format!(
            "{}: already holds an item.json, so it is a shelf item, not a source",
            dir.display()
        ));
    }
    Ok(files)
}

fn sorted_entries(dir: &Path, want_dir: bool) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| {
                    e.file_type()
                        .is_ok_and(|t| if want_dir { t.is_dir() } else { t.is_file() })
                })
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    sorted_entries(dir, true)
}

fn sorted_files(dir: &Path) -> Vec<PathBuf> {
    sorted_entries(dir, false)
}
