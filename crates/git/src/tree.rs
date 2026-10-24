//! Trees: building every tree object of a flat file list, and decoding one.

use crate::object::{Kind, Mode, ObjectId, object_id};
use crate::{Error, Result};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;

/// One file of a commit: its path from the repository root, its mode, and
/// its blob's id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub mode: Mode,
    pub id: ObjectId,
}

/// Every tree object of a file list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trees {
    /// The root tree's id.
    pub root: ObjectId,
    /// Every tree as `(id, body)`, each after the trees it contains, so the
    /// root is last. A tree that occurs twice (two identical directories) is
    /// listed twice.
    pub objects: Vec<(ObjectId, Vec<u8>)>,
}

/// The `40000` a tree entry for a directory carries.
const TREE_MODE: &str = "40000";

/// Check that `path` can name a file in a tree, and split it into its
/// components. Git and every checkout would refuse what this refuses.
pub fn check_path(path: &str) -> Result<Vec<&str>> {
    let refuse = |reason: &str| Err(Error::invalid(path, reason));
    if path.is_empty() {
        return refuse("a path cannot be empty");
    }
    if path.contains('\0') {
        return refuse("a path cannot contain a NUL byte");
    }
    if path.starts_with('/') {
        return refuse("a path cannot start with `/`");
    }
    if path.ends_with('/') {
        return refuse("a path cannot end with `/`");
    }
    let components: Vec<&str> = path.split('/').collect();
    for component in &components {
        match *component {
            "" => return refuse("a path cannot contain an empty component (`//`)"),
            "." | ".." => return refuse("a path cannot contain `.` or `..`"),
            _ if is_dot_git(component) => {
                return refuse("a path cannot contain a `.git` component");
            }
            _ => {}
        }
    }
    Ok(components)
}

/// Whether a component names Git's own directory, as `git fsck` reads it:
/// in any case, with the trailing dots and spaces Windows ignores, or as
/// its 8.3 short name.
fn is_dot_git(component: &str) -> bool {
    let trimmed = component.trim_end_matches(['.', ' ']);
    trimmed.eq_ignore_ascii_case(".git") || trimmed.eq_ignore_ascii_case("git~1")
}

enum Node {
    File(Mode, ObjectId),
    Directory(BTreeMap<String, Node>),
}

/// Build every tree of `files`. Each path is checked with [`check_path`],
/// and a path given twice, or given both as a file and as a directory, is an
/// error; every error is reported, each naming its path.
pub fn build(files: &[FileEntry]) -> Result<Trees, Vec<Error>> {
    let mut root = BTreeMap::new();
    let mut errors = Vec::new();
    for file in files {
        if let Err(error) = insert(&mut root, file) {
            errors.push(error);
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let mut objects = Vec::new();
    let root = write(&root, &mut objects);
    Ok(Trees { root, objects })
}

fn insert(root: &mut BTreeMap<String, Node>, file: &FileEntry) -> Result<()> {
    let components = check_path(&file.path)?;
    let Some((name, directories)) = components.split_last() else {
        return Err(Error::invalid(&file.path, "a path cannot be empty"));
    };
    let mut directory = root;
    for (depth, component) in directories.iter().enumerate() {
        let node = directory
            .entry((*component).to_owned())
            .or_insert_with(|| Node::Directory(BTreeMap::new()));
        directory = match node {
            Node::Directory(children) => children,
            Node::File(..) => {
                let file_path = directories[..=depth].join("/");
                return Err(Error::invalid(
                    &file.path,
                    format!("`{file_path}` is a file, so it cannot be a directory too"),
                ));
            }
        };
    }
    match directory.get(*name) {
        None => {
            directory.insert((*name).to_owned(), Node::File(file.mode, file.id));
            Ok(())
        }
        Some(Node::File(..)) => Err(Error::invalid(&file.path, "the path is listed twice")),
        Some(Node::Directory(_)) => Err(Error::invalid(
            &file.path,
            "the path is a directory of other files, so it cannot be a file too",
        )),
    }
}

/// Write `directory`'s tree and every tree under it into `objects`.
fn write(directory: &BTreeMap<String, Node>, objects: &mut Vec<(ObjectId, Vec<u8>)>) -> ObjectId {
    let mut entries: Vec<(&str, &str, ObjectId)> = directory
        .iter()
        .map(|(name, node)| match node {
            Node::File(mode, id) => (name.as_str(), mode.as_str(), *id),
            Node::Directory(children) => (name.as_str(), TREE_MODE, write(children, objects)),
        })
        .collect();
    entries.sort_by(|left, right| {
        canonical_order(left.0, left.1 == TREE_MODE, right.0, right.1 == TREE_MODE)
    });
    let mut body = Vec::new();
    for (name, mode, id) in entries {
        body.extend_from_slice(mode.as_bytes());
        body.push(b' ');
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(&id.0);
    }
    let id = object_id(Kind::Tree, &body);
    objects.push((id, body));
    id
}

/// Git's order of tree entries: by name, byte by byte, with a tree's name
/// read as if it ended in `/`.
fn canonical_order(left: &str, left_is_tree: bool, right: &str, right_is_tree: bool) -> Ordering {
    let slash = |is_tree: bool| is_tree.then_some(b'/');
    left.bytes()
        .chain(slash(left_is_tree))
        .cmp(right.bytes().chain(slash(right_is_tree)))
}

/// The mode of an entry in a tree someone else wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryMode {
    File(Mode),
    /// `40000`: a directory.
    Tree,
    /// `160000`: a submodule's commit.
    Submodule,
}

impl EntryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File(mode) => mode.as_str(),
            Self::Tree => TREE_MODE,
            Self::Submodule => "160000",
        }
    }
}

impl fmt::Display for EntryMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One entry of a decoded tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub name: String,
    pub mode: EntryMode,
    pub id: ObjectId,
}

/// Decode a tree's body into its entries, in the order it lists them.
pub fn decode(body: &[u8]) -> Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    let mut rest = body;
    while !rest.is_empty() {
        let what = || format!("tree entry {}", entries.len() + 1);
        let space = rest
            .iter()
            .position(|&byte| byte == b' ')
            .ok_or_else(|| Error::malformed(what(), "no space after the mode"))?;
        let mode = match &rest[..space] {
            b"100644" => EntryMode::File(Mode::File),
            b"100755" => EntryMode::File(Mode::Executable),
            b"120000" => EntryMode::File(Mode::Symlink),
            b"40000" => EntryMode::Tree,
            b"160000" => EntryMode::Submodule,
            other => {
                return Err(Error::malformed(
                    what(),
                    format!("unknown mode `{}`", String::from_utf8_lossy(other)),
                ));
            }
        };
        rest = &rest[space + 1..];
        let nul = rest
            .iter()
            .position(|&byte| byte == 0)
            .ok_or_else(|| Error::malformed(what(), "no NUL after the name"))?;
        let name = std::str::from_utf8(&rest[..nul])
            .map_err(|_| Error::malformed(what(), "the name is not UTF-8"))?
            .to_owned();
        rest = &rest[nul + 1..];
        let id = rest
            .get(..20)
            .and_then(ObjectId::from_slice)
            .ok_or_else(|| Error::malformed(what(), "the object id is cut short"))?;
        rest = &rest[20..];
        entries.push(TreeEntry { name, mode, id });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> FileEntry {
        FileEntry {
            path: path.to_owned(),
            mode: Mode::File,
            id: object_id(Kind::Blob, path.as_bytes()),
        }
    }

    fn reason(files: &[&str]) -> Vec<(String, String)> {
        let files: Vec<FileEntry> = files.iter().map(|path| file(path)).collect();
        build(&files)
            .unwrap_err()
            .into_iter()
            .map(|error| (error.path().to_owned(), error.reason().to_owned()))
            .collect()
    }

    #[test]
    fn refuses_paths_git_would() {
        for path in [
            "",
            "/a",
            "a/",
            "a//b",
            "./a",
            "a/./b",
            "a/../b",
            "..",
            ".git",
            ".GIT/config",
            "a/.Git/hooks",
            "a/.git./x",
            "a/.git /x",
            "GIT~1/config",
            "a\0b",
        ] {
            let errors = reason(&[path]);
            assert_eq!(errors.len(), 1, "{path:?}");
            assert_eq!(errors[0].0, path);
        }
        // Names that only look like it are fine.
        for path in [".github/x", "a/.gitignore", "a/.gitkeep", "git", "a.git/b"] {
            assert!(build(&[file(path)]).is_ok(), "{path}");
        }
    }

    #[test]
    fn refuses_duplicates_and_file_directory_clashes() {
        let errors = reason(&["a/b", "a/b"]);
        assert_eq!(
            errors,
            [("a/b".to_owned(), "the path is listed twice".to_owned())]
        );
        let errors = reason(&["a/b", "a/b/c"]);
        assert_eq!(errors[0].0, "a/b/c");
        assert!(errors[0].1.contains("`a/b` is a file"), "{errors:?}");
        let errors = reason(&["a/b/c", "a/b"]);
        assert_eq!(errors[0].0, "a/b");
        // Every error is reported.
        assert_eq!(reason(&["", "/x", "ok", "ok"]).len(), 3);
    }

    #[test]
    fn orders_a_tree_as_if_its_name_ended_in_a_slash() {
        // `a.b` (0x2e) sorts before `a/` (0x2f), which sorts before `a0`.
        let trees = build(&[file("a0"), file("a/x"), file("a.b")]).unwrap();
        let (root_id, root) = trees.objects.last().unwrap();
        assert_eq!(*root_id, trees.root);
        let names: Vec<String> = decode(root).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["a.b", "a", "a0"]);
    }

    #[test]
    fn decodes_what_it_builds() {
        let trees = build(&[file("dir/one"), file("two")]).unwrap();
        let root = decode(&trees.objects[1].1).unwrap();
        assert_eq!(root[0].name, "dir");
        assert_eq!(root[0].mode, EntryMode::Tree);
        assert_eq!(root[0].id, trees.objects[0].0);
        assert_eq!(root[1].mode, EntryMode::File(Mode::File));
        assert!(decode(b"100644 x").is_err());
        assert!(decode(b"100664 x\0aaaaaaaaaaaaaaaaaaaa").is_err());
        assert!(decode(b"100644 x\0short").is_err());
    }

    #[test]
    fn an_empty_list_is_the_empty_tree() {
        let trees = build(&[]).unwrap();
        assert_eq!(
            trees.root.to_string(),
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        );
    }
}
