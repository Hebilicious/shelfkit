//! Where a shelf's bytes come from.
//!
//! The loader never touches the filesystem itself. It asks a [`FileSource`]
//! for relative, `/`-separated paths and their bytes, so the same code loads a
//! shelf from a directory in the CLI and from memory in WASM (the Worker and
//! the browser preview).

use crate::error::{Error, ErrorKind, Result};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A read-only view of a shelf's files.
pub trait FileSource {
    /// Every file under `dir`, recursively, as paths relative to the shelf
    /// root (`items/prompts/x/item.json`). A missing directory is empty, not
    /// an error. Order does not matter: the loader sorts.
    ///
    /// An entry the source cannot use (a symbolic link, a name that is not
    /// UTF-8, one it cannot read) is left out and reported in
    /// [`Listing::errors`], so one bad file costs one error and the rest of
    /// the shelf still loads and validates.
    fn list(&self, dir: &str) -> Listing;

    /// The bytes of one file, by its path relative to the shelf root.
    fn read(&self, path: &str) -> Result<Vec<u8>>;
}

/// The files under one directory, and the entries that could not be listed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listing {
    pub paths: Vec<String>,
    pub errors: Vec<Error>,
}

/// A shelf held in memory, keyed by relative path. This is what WASM callers
/// build from the files they were handed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemorySource {
    files: BTreeMap<String, Vec<u8>>,
}

impl MemorySource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, path: impl Into<String>, bytes: impl Into<Vec<u8>>) {
        self.files.insert(path.into(), bytes.into());
    }

    pub fn files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.files
    }

    /// Copy every file out of another source, for tests and for callers that
    /// want to hold a directory in memory.
    pub fn snapshot(source: &dyn FileSource, dirs: &[&str]) -> Result<Self> {
        let mut memory = Self::new();
        for dir in dirs {
            let listing = source.list(dir);
            if let Some(error) = listing.errors.into_iter().next() {
                return Err(error);
            }
            for path in listing.paths {
                let bytes = source.read(&path)?;
                memory.insert(path, bytes);
            }
        }
        Ok(memory)
    }
}

impl<P: Into<String>, B: Into<Vec<u8>>> FromIterator<(P, B)> for MemorySource {
    fn from_iter<I: IntoIterator<Item = (P, B)>>(iter: I) -> Self {
        let mut memory = Self::new();
        for (path, bytes) in iter {
            memory.insert(path, bytes);
        }
        memory
    }
}

impl FileSource for MemorySource {
    fn list(&self, dir: &str) -> Listing {
        let prefix = format!("{}/", dir.trim_end_matches('/'));
        Listing {
            paths: self
                .files
                .keys()
                .filter(|path| path.starts_with(&prefix))
                .cloned()
                .collect(),
            errors: Vec::new(),
        }
    }

    fn read(&self, path: &str) -> Result<Vec<u8>> {
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| Error::new(path, ErrorKind::Read("no such file".into())))
    }
}

/// A shelf in a directory on disk, for the CLI.
///
/// Symbolic links are refused rather than followed: a link's target depends
/// on the checkout, and Windows may materialize one as a text file, so a
/// revision over it would differ between two clones of the same shelf.
#[derive(Debug, Clone)]
pub struct DirSource {
    root: PathBuf,
}

impl DirSource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `path` relative to the shelf root, with `/` separators. A component
    /// that is not UTF-8 is written lossily, for the message, and refused.
    fn relative(&self, path: &Path) -> Result<String> {
        let relative = path.strip_prefix(&self.root).unwrap_or(path);
        let lossy: Vec<String> = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect();
        let joined = lossy.join("/");
        if relative
            .components()
            .any(|component| component.as_os_str().to_str().is_none())
        {
            return Err(Error::new(
                joined,
                ErrorKind::Path("file name is not UTF-8".into()),
            ));
        }
        Ok(joined)
    }
}

impl FileSource for DirSource {
    fn list(&self, dir: &str) -> Listing {
        let mut listing = Listing::default();
        let base = self.root.join(dir);
        if !base.is_dir() {
            return listing;
        }

        for entry in walkdir::WalkDir::new(&base).follow_links(false) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    let path = error.path().map_or_else(
                        || dir.to_owned(),
                        |p| self.relative(p).unwrap_or_else(|e| e.path),
                    );
                    listing
                        .errors
                        .push(Error::new(path, ErrorKind::Read(error.to_string())));
                    continue;
                }
            };
            let file_type = entry.file_type();
            if !file_type.is_symlink() && !file_type.is_file() {
                continue;
            }
            let path = match self.relative(entry.path()) {
                Ok(path) => path,
                Err(error) => {
                    listing.errors.push(error);
                    continue;
                }
            };
            if file_type.is_symlink() {
                listing.errors.push(Error::new(
                    path,
                    ErrorKind::Path("symbolic links are not allowed in a shelf".into()),
                ));
            } else {
                listing.paths.push(path);
            }
        }
        listing
    }

    fn read(&self, path: &str) -> Result<Vec<u8>> {
        std::fs::read(self.root.join(path))
            .map_err(|error| Error::new(path, ErrorKind::Read(error.to_string())))
    }
}

/// A path the loader accepts: relative, `/`-separated, with no empty, `.`, or
/// `..` segment and no backslash. Anything else would hash differently, or
/// escape the shelf, depending on who reads it.
pub(crate) fn check_path(path: &str) -> Result<()> {
    let bad = |message: &str| Err(Error::new(path, ErrorKind::Path(message.into())));
    if path.is_empty() || path.starts_with('/') {
        return bad("must be relative to the shelf root");
    }
    if path.contains('\\') {
        return bad("must use `/` separators");
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return bad("must not contain empty, `.`, or `..` segments");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_lists_by_directory_prefix() {
        let source: MemorySource = [
            ("items/a/item.json", "{}"),
            ("items-other/b", "{}"),
            ("profiles/x.json", "{}"),
        ]
        .into_iter()
        .collect();
        assert_eq!(source.list("items").paths, vec!["items/a/item.json"]);
        assert!(source.list("bundles").paths.is_empty());
    }

    #[test]
    fn paths_must_be_clean_and_relative() {
        assert!(check_path("items/a/item.json").is_ok());
        for bad in ["/abs", "a//b", "a/../b", "a/./b", "a\\b", ""] {
            assert!(check_path(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn missing_file_error_carries_the_path() {
        let error = MemorySource::new().read("shelf.json").unwrap_err();
        assert_eq!(error.path, "shelf.json");
    }
}
