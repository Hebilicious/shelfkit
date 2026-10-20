//! `shelfkit add <path>`: import items from a local directory or file.
//!
//! Only the `path` source kind is here (`docs/PRD.md` section 6, last row):
//! discovery reads APM's package layouts from a directory on this machine and
//! copies what it finds into the shelf as items with no upstream, marked
//! local by a `source` that names a `path` source in `shelf.json`. Git
//! repositories, registries, catalogs, marketplaces, and other shelves arrive
//! with their source adapters in issue #8. Nothing here touches the network.
//!
//! What a directory yields, following APM's layouts:
//!
//! | Found | Becomes |
//! | --- | --- |
//! | `.apm/skills/<n>/SKILL.md`, `.apm/prompts/*.prompt.md`, `.apm/agents/*.agent.md`, `.apm/instructions/*.instructions.md`, `.apm/hooks/*.json` | one item each |
//! | `SKILL.md` at the root | one skill, the whole directory |
//! | `plugin.json` or `.claude-plugin/` at the root | one plugin, the whole directory |
//! | `skills/<n>/SKILL.md`, `hooks/*.json` | one item each |
//!
//! A single `*.prompt.md`, `*.agent.md`, or `*.instructions.md` file yields
//! one item. Every item is validated with the rest of the shelf before
//! anything is written, and an id that is not kebab-case is refused rather
//! than renamed.

use crate::engine::Overlay;
use shelfkit_core::profile::{ShelfSource, SourceKind};
use shelfkit_core::{DirSource, Item, ItemKind, Manifest, MemorySource, load};
use std::collections::BTreeMap;
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
}

/// The files to write into the shelf, relative to its root, and the ids added.
pub struct Import {
    pub files: BTreeMap<String, Vec<u8>>,
    pub items: Vec<(ItemKind, String)>,
}

pub fn import(shelf_root: &Path, target: &Path, source_id: Option<&str>) -> Result<Import, String> {
    let target = target
        .canonicalize()
        .map_err(|error| format!("{}: {error}", target.display()))?;
    let (root, found) = if target.is_file() {
        let root = target.parent().map(Path::to_path_buf).unwrap_or_default();
        let name = file_name(&target);
        (root, vec![single_file(&target, &name)?])
    } else {
        (target.clone(), discover(&target)?)
    };
    if found.is_empty() {
        return Err(format!(
            "{}: found no skill, prompt, agent, instructions, hook, or plugin in an APM layout \
             (.apm/, SKILL.md, plugin.json, skills/<name>/SKILL.md, hooks/*.json)",
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
        let item = Item::from_value(serde_json::json!({
            "id": found.id,
            "kind": found.kind,
            "title": found.id,
            "description": found.description,
            "source": { "id": source_id, "path": found.path },
        }))
        .map_err(|error| format!("{}: {error}", found.path))?;
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
    Ok(Import { files, items })
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
    Err(format!(
        "{}: a single file must be a `.prompt.md`, `.agent.md`, or `.instructions.md`, or a SKILL.md",
        path.display()
    ))
}

fn discover(root: &Path) -> Result<Vec<Found>, String> {
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

/// The source kinds `add` cannot import yet, by how their argument looks.
pub fn unsupported_kind(source: &str) -> Option<&'static str> {
    if source.starts_with("https://") || source.starts_with("http://") {
        Some(
            "a URL (a Git repository, an APM registry, a catalog, a marketplace, or another shelf)",
        )
    } else if source.starts_with("git@") || source.starts_with("ssh://") {
        Some("a Git repository")
    } else {
        None
    }
}
