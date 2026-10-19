//! What `compile` writes into a repository, computed once for writing, for
//! `--frozen`, and for `verify`, so the three cannot disagree.
//!
//! `compile` owns two things in the target repository: its `apm.yml`, merged
//! with whatever the repository already declares (see [`crate::merge`]), and
//! the vendored packages `vendor/<profile>/` and `vendor/<profile>--*/`. A
//! file in one of those packages that the plan no longer has is removed.
//! Nothing else is touched: no lockfile, no harness directory.

use crate::manifest::{CompiledManifest, VENDOR_DIR};
use crate::merge::{MergeError, merge};
use shelfkit_core::OnConflict;
use std::collections::BTreeMap;
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

/// Work out what compiling `plan` into `repo` writes.
pub fn output(
    plan: &CompiledManifest,
    repo: &Path,
    on_conflict: OnConflict,
) -> Result<Output, String> {
    let mut out = Output::default();

    let existing = repo.join(APM_YML);
    let manifest = match std::fs::read_to_string(&existing) {
        Ok(text) => match merge(&text, &plan.apm_yml, &plan.profile, on_conflict) {
            Ok(merged) => {
                out.conflicts = merged.conflicts;
                merged.text
            }
            Err(MergeError::Unreadable(why)) => {
                return Err(format!(
                    "{}: cannot read it as a manifest: {why}",
                    existing.display()
                ));
            }
            Err(MergeError::Conflicts(conflicts)) => {
                return Err(format!(
                    "{} already declares, differently, what the shelf declares:\n{}\n\
                     onConflict is `fail`, so nothing was written. Decide which side wins with \
                     `--on-conflict shelf-wins` or `--on-conflict local-wins`, or set the \
                     profile's `compile.onConflict`.",
                    existing.display(),
                    conflicts
                        .iter()
                        .map(|c| format!("  - {c}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                ));
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => plan.apm_yml.clone(),
        Err(error) => return Err(format!("{}: {error}", existing.display())),
    };
    out.files.insert(APM_YML.to_owned(), manifest.into_bytes());

    for file in &plan.files {
        out.files.insert(file.path.clone(), file.bytes()?);
    }

    // Every package directory this profile owns, written now or before.
    let vendor = repo.join(VENDOR_DIR);
    let owned =
        |name: &str| name == plan.profile || name.starts_with(&format!("{}--", plan.profile));
    if let Ok(entries) = std::fs::read_dir(&vendor) {
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| owned(name))
            .collect();
        names.sort();
        for name in names {
            for path in files_under(repo, &format!("{VENDOR_DIR}/{name}")) {
                if !out.files.contains_key(&path) {
                    out.remove.push(path);
                }
            }
        }
    }
    Ok(out)
}

/// Every file under `dir` (relative to `repo`), relative to `repo`, sorted.
fn files_under(repo: &Path, dir: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_owned()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(repo.join(&current)) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let path = format!("{current}/{name}");
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(path),
                Ok(_) => found.push(path),
                Err(_) => {}
            }
        }
    }
    found.sort();
    found
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
