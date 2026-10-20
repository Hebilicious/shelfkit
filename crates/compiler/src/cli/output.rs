//! What `compile` writes into a repository, computed once for writing, for
//! `--frozen`, and for `verify`, so the three cannot disagree.
//!
//! `compile` owns two things in the target repository: its `apm.yml`, merged
//! with whatever the repository already declares (see [`crate::merge`]), and
//! the vendored packages it wrote. A package is ShelfKit's only when its
//! `apm.yml` carries the ownership marker ([`OWNER_KEY`]) for the profile
//! being compiled: a `vendor/<name>` without it (Composer's `vendor/`, say)
//! is never written into or deleted from, and the plan wanting that
//! directory is a conflict. Inside an owned package, a file the plan no
//! longer has is removed. Nothing else is touched: no lockfile, no harness
//! directory.
//!
//! No path is written, created, or deleted through a symbolic link: every
//! component below the repository root is checked with `symlink_metadata`,
//! before planning and again right before each change, and a link is a
//! conflict that names it.

use crate::manifest::{CompiledManifest, OWNER_KEY, VENDOR_DIR};
use crate::merge::{MergeError, merge};
use crate::yaml::Node;
use shelfkit_core::OnConflict;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const APM_YML: &str = "apm.yml";

/// The repository as `compile` would leave it.
#[derive(Debug, Default)]
pub struct Output {
    /// Every file to write, by path relative to the repository, with `/`.
    pub files: BTreeMap<String, Vec<u8>>,
    /// Files to remove, relative to the repository.
    pub remove: Vec<String>,
    /// Declarations in an existing `apm.yml` that differed, and how
    /// `onConflict` settled them.
    pub conflicts: Vec<String>,
}

/// One way the repository differs from [`Output`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Create(String),
    Update(String),
    Remove(String),
}

impl std::fmt::Display for Change {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Create(path) => write!(f, "create {path}"),
            Self::Update(path) => write!(f, "update {path}"),
            Self::Remove(path) => write!(f, "remove {path}"),
        }
    }
}

/// Work out what compiling `plan` into `repo` writes. An `Err` explains
/// every conflict found; nothing has been written.
pub fn output(
    plan: &CompiledManifest,
    repo: &Path,
    on_conflict: OnConflict,
) -> Result<Output, String> {
    let mut out = Output::default();
    let mut refused: Vec<String> = Vec::new();

    // The packages ShelfKit wrote for this profile, by directory name.
    let owned = owned_packages(repo, &plan.profile);

    // Every package directory the plan writes must be absent or ShelfKit's.
    let planned: BTreeSet<&str> = plan
        .files
        .iter()
        .filter_map(|file| file.path.strip_prefix(&format!("{VENDOR_DIR}/")))
        .filter_map(|rest| rest.split('/').next())
        .collect();
    for name in &planned {
        let dir = format!("{VENDOR_DIR}/{name}");
        let exists = repo.join(&dir).symlink_metadata().is_ok();
        if exists && !owned.contains(*name) {
            refused.push(format!(
                "{dir} exists and is not a package ShelfKit vendored for profile `{}` (its apm.yml \
                 has no `{OWNER_KEY}: {}`); move it, or compile into another repository",
                plan.profile, plan.profile
            ));
        }
    }

    let manifest = match read_regular(repo, APM_YML) {
        Ok(Some(text)) => {
            let owned_entries: BTreeSet<String> =
                owned.iter().map(|n| format!("{VENDOR_DIR}/{n}")).collect();
            match merge(&text, &plan.apm_yml, &owned_entries, on_conflict) {
                Ok(merged) => {
                    out.conflicts = merged.conflicts;
                    merged.text
                }
                Err(MergeError::Unreadable(why)) => {
                    return Err(format!(
                        "{}: cannot read it as a manifest: {why}",
                        repo.join(APM_YML).display()
                    ));
                }
                Err(MergeError::Conflicts(conflicts)) => {
                    return Err(format!(
                        "{} already declares, differently, what the shelf declares:\n{}\n\
                         onConflict is `fail`, so nothing was written. Decide which side wins with \
                         `--on-conflict shelf-wins` or `--on-conflict local-wins`, or set the \
                         profile's `compile.onConflict`.",
                        repo.join(APM_YML).display(),
                        bullet(&conflicts)
                    ));
                }
            }
        }
        Ok(None) => plan.apm_yml.clone(),
        Err(why) => {
            refused.push(why);
            String::new()
        }
    };
    out.files.insert(APM_YML.to_owned(), manifest.into_bytes());

    for file in &plan.files {
        out.files.insert(file.path.clone(), file.bytes()?);
    }

    // Stale files: only inside packages carrying this profile's marker.
    for name in &owned {
        match files_under(repo, &format!("{VENDOR_DIR}/{name}")) {
            Ok(paths) => out.remove.extend(
                paths
                    .into_iter()
                    .filter(|path| !out.files.contains_key(path)),
            ),
            Err(why) => refused.push(why),
        }
    }

    for path in out.files.keys().chain(&out.remove) {
        if let Err(why) = no_symlink(repo, path) {
            refused.push(why);
        }
    }
    if refused.is_empty() {
        Ok(out)
    } else {
        refused.sort();
        refused.dedup();
        Err(format!(
            "nothing was written to {}:\n{}",
            repo.display(),
            bullet(&refused)
        ))
    }
}

fn bullet(lines: &[String]) -> String {
    lines
        .iter()
        .map(|line| format!("  - {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Refuse a path any of whose components below `repo` is a symbolic link:
/// writing, creating, or deleting through it could reach outside the
/// repository.
pub fn no_symlink(repo: &Path, relative: &str) -> Result<(), String> {
    let mut current = repo.to_path_buf();
    let mut shown = String::new();
    for component in relative.split('/') {
        current.push(component);
        if !shown.is_empty() {
            shown.push('/');
        }
        shown.push_str(component);
        match current.symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "{shown} is a symbolic link; ShelfKit never writes, creates, or deletes through one"
                ));
            }
            Ok(_) => {}
            // Nothing exists from here down, so nothing below can be a link.
            Err(_) => return Ok(()),
        }
    }
    Ok(())
}

/// A file's text when it exists as a regular file, `None` when it does not
/// exist, and an error when it is reached through a link or is not a file.
fn read_regular(repo: &Path, relative: &str) -> Result<Option<String>, String> {
    no_symlink(repo, relative)?;
    let path = repo.join(relative);
    match path.symlink_metadata() {
        Err(_) => Ok(None),
        Ok(meta) if !meta.is_file() => Err(format!("{relative} is not a regular file")),
        Ok(_) => std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|error| format!("{}: {error}", path.display())),
    }
}

/// The directories under `vendor/` whose `apm.yml` (a regular file, reached
/// through no link) carries the ownership marker for `profile`.
fn owned_packages(repo: &Path, profile: &str) -> BTreeSet<String> {
    let mut owned = BTreeSet::new();
    if no_symlink(repo, VENDOR_DIR).is_err() {
        return owned;
    }
    let Ok(entries) = std::fs::read_dir(repo.join(VENDOR_DIR)) else {
        return owned;
    };
    for entry in entries.filter_map(Result::ok) {
        // `file_type` does not follow links: a linked package is never ours.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let marked = read_regular(repo, &format!("{VENDOR_DIR}/{name}/{APM_YML}"))
            .ok()
            .flatten()
            .and_then(|text| Node::parse(&text).ok())
            .is_some_and(|manifest| {
                manifest.get(OWNER_KEY).and_then(Node::as_str) == Some(profile)
            });
        if marked {
            owned.insert(name);
        }
    }
    owned
}

/// Every file under `dir` (relative to `repo`), relative to `repo`, sorted.
/// A link anywhere inside is refused rather than followed or deleted.
fn files_under(repo: &Path, dir: &str) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_owned()];
    while let Some(current) = stack.pop() {
        let entries = std::fs::read_dir(repo.join(&current))
            .map_err(|error| format!("{current}: {error}"))?;
        for entry in entries.filter_map(Result::ok) {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Err(format!("{current} holds a file name that is not UTF-8"));
            };
            let path = format!("{current}/{name}");
            let kind = entry
                .file_type()
                .map_err(|error| format!("{path}: {error}"))?;
            if kind.is_symlink() {
                return Err(format!(
                    "{path} is a symbolic link; ShelfKit never writes, creates, or deletes through one"
                ));
            }
            if kind.is_dir() {
                stack.push(path);
            } else {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

/// How the repository differs from what `compile` would write.
pub fn changes(out: &Output, repo: &Path) -> Vec<Change> {
    let mut changes = Vec::new();
    for (path, bytes) in &out.files {
        match std::fs::read(repo.join(path)) {
            Ok(current) if current == *bytes => {}
            Ok(_) => changes.push(Change::Update(path.clone())),
            Err(_) => changes.push(Change::Create(path.clone())),
        }
    }
    changes.extend(out.remove.iter().cloned().map(Change::Remove));
    changes
}

/// Write the changes, then remove directories they left empty.
pub fn apply(out: &Output, changes: &[Change], repo: &Path) -> Result<(), String> {
    for change in changes {
        let (Change::Create(path) | Change::Update(path) | Change::Remove(path)) = change;
        // Checked again here: the repository may have changed since planning.
        no_symlink(repo, path)?;
        match change {
            Change::Create(path) | Change::Update(path) => {
                let target = repo.join(path);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|error| format!("{}: {error}", parent.display()))?;
                }
                let bytes = out.files.get(path).map(Vec::as_slice).unwrap_or_default();
                std::fs::write(&target, bytes)
                    .map_err(|error| format!("{}: {error}", target.display()))?;
            }
            Change::Remove(path) => {
                let target = repo.join(path);
                std::fs::remove_file(&target)
                    .map_err(|error| format!("{}: {error}", target.display()))?;
                let mut parent = target.parent();
                while let Some(dir) = parent {
                    if dir == repo.join(VENDOR_DIR) || std::fs::remove_dir(dir).is_err() {
                        break;
                    }
                    parent = dir.parent();
                }
            }
        }
    }
    Ok(())
}
