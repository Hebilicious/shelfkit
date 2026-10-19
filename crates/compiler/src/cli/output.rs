//! What `compile` writes into a repository, computed once for writing, for
//! `--frozen`, and for `verify`, so the three cannot disagree.
//!
//! The planning is [`crate::output`], shared with the WASM engine; this
//! module is the disk under it: a [`Repository`] that reads the filesystem
//! without following links, and the writes. No path is written, created, or
//! deleted through a symbolic link: every component below the repository
//! root is checked with `symlink_metadata`, before planning and again right
//! before each change, and a link is a conflict that names it.

use crate::manifest::{CompiledManifest, VENDOR_DIR};
use crate::output::{Entry, Kind, Repository};
use shelfkit_core::OnConflict;
use std::fs::FileType;
use std::path::Path;

pub use crate::output::{APM_YML, Output};

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

/// A repository on disk.
struct Disk<'a>(&'a Path);

fn kind_of(file_type: FileType) -> Kind {
    if file_type.is_symlink() {
        Kind::Link
    } else if file_type.is_dir() {
        Kind::Dir
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

impl Repository for Disk<'_> {
    fn kind(&self, relative: &str) -> Option<Kind> {
        let meta = self.0.join(relative).symlink_metadata().ok()?;
        Some(kind_of(meta.file_type()))
    }

    fn read(&self, relative: &str) -> Result<String, String> {
        let path = self.0.join(relative);
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))
    }

    fn list(&self, relative: &str) -> Result<Vec<Entry>, String> {
        let entries = std::fs::read_dir(self.0.join(relative))
            .map_err(|error| format!("{relative}: {error}"))?;
        Ok(entries
            .filter_map(Result::ok)
            .map(|entry| Entry {
                name: entry.file_name().to_str().map(str::to_owned),
                // `file_type` does not follow links.
                kind: entry
                    .file_type()
                    .map(kind_of)
                    .map_err(|error| error.to_string()),
            })
            .collect())
    }
}

/// Work out what compiling `plan` into `repo` writes. An `Err` explains
/// every conflict found; nothing has been written.
pub fn output(
    plan: &CompiledManifest,
    repo: &Path,
    on_conflict: OnConflict,
) -> Result<Output, String> {
    crate::output::output(plan.into(), &Disk(repo), on_conflict).map_err(|refusal| {
        refusal.message(
            &repo.display().to_string(),
            &repo.join(APM_YML).display().to_string(),
        )
    })
}

/// Refuse a path any of whose components below `repo` is a symbolic link:
/// writing, creating, or deleting through it could reach outside the
/// repository.
pub fn no_symlink(repo: &Path, relative: &str) -> Result<(), String> {
    crate::output::no_symlink(&Disk(repo), relative)
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
