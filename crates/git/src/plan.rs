//! A commit planned from complete file lists: what the Worker calls to push a
//! shelf's new state on top of its last commit.

use crate::commit::{Commit, Signature};
use crate::object::{Kind, Mode, ObjectId, object_id};
use crate::receive_pack::{self, Update};
use crate::tree::{self, FileEntry};
use crate::{Error, Result, pack};
use std::collections::HashSet;

/// A commit to make.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInput {
    /// The commit `reference` points at now, or `None` to create it with a
    /// root commit.
    pub parent: Option<ObjectId>,
    /// Every file of the parent commit; empty for a root commit. The server
    /// has each of these blobs, and every tree they build.
    pub base: Vec<FileEntry>,
    /// Every file of the new commit.
    pub files: Vec<NewFile>,
    /// The full name of the reference to update, as `refs/heads/main`.
    pub reference: String,
    pub author: Signature,
    /// The author, when `None`.
    pub committer: Option<Signature>,
    pub message: String,
}

/// One file of the new commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFile {
    pub path: String,
    pub mode: Mode,
    pub source: Source,
}

/// Where a file's contents come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A blob of the parent commit, by id: an unchanged file, or one moved.
    Known(ObjectId),
    /// The file's bytes.
    Contents(Vec<u8>),
}

/// What [`plan_commit`] made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPlan {
    /// The new commit's root tree.
    pub tree: ObjectId,
    /// Every file of the new commit, in the order given, with its blob id.
    pub files: Vec<FileEntry>,
    /// How many objects the pack holds.
    pub objects: usize,
    /// The commit and its push, or `None` when the tree is the parent's
    /// and there is nothing to commit.
    pub push: Option<Push>,
}

impl CommitPlan {
    /// Whether the files are exactly the parent commit's.
    pub fn unchanged(&self) -> bool {
        self.push.is_none()
    }
}

/// A commit, and the receive-pack request that pushes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push {
    pub commit: ObjectId,
    /// The body of the `POST /git-receive-pack`, moving the reference from
    /// the parent (or from nothing) to `commit`.
    pub request: Vec<u8>,
}

/// Plan a commit of `input.files` on top of `input.parent`. The pack holds
/// only what the server cannot already have: the commit, and the blobs and
/// trees that are not among the base's. Every problem with the input is
/// reported, each naming its path.
pub fn plan_commit(input: &CommitInput) -> Result<CommitPlan, Vec<Error>> {
    let mut errors = Vec::new();
    if let Err(error) = receive_pack::check_reference(&input.reference) {
        errors.push(error);
    }
    if input.parent.is_none() && !input.base.is_empty() {
        errors.push(Error::invalid(
            "<base>",
            "a root commit has no base: give the parent the base belongs to",
        ));
    }
    let base_trees = tree::build(&input.base).unwrap_or_else(|base_errors| {
        errors.extend(base_errors);
        tree::Trees {
            root: ObjectId::ZERO,
            objects: Vec::new(),
        }
    });
    let base_blobs: HashSet<ObjectId> = input.base.iter().map(|file| file.id).collect();

    let mut files = Vec::with_capacity(input.files.len());
    let mut new_blobs: Vec<(ObjectId, &[u8])> = Vec::new();
    let mut seen: HashSet<ObjectId> = HashSet::new();
    for file in &input.files {
        let id = match &file.source {
            Source::Known(id) => {
                if !base_blobs.contains(id) {
                    errors.push(Error::invalid(
                        &file.path,
                        format!("blob {id} is not a file of the parent commit, so the server may not have it; send the contents"),
                    ));
                }
                *id
            }
            Source::Contents(contents) => {
                let id = object_id(Kind::Blob, contents);
                if !base_blobs.contains(&id) && seen.insert(id) {
                    new_blobs.push((id, contents));
                }
                id
            }
        };
        files.push(FileEntry {
            path: file.path.clone(),
            mode: file.mode,
            id,
        });
    }
    let trees = tree::build(&files).unwrap_or_else(|tree_errors| {
        errors.extend(tree_errors);
        tree::Trees {
            root: ObjectId::ZERO,
            objects: Vec::new(),
        }
    });
    if !errors.is_empty() {
        return Err(errors);
    }

    if input.parent.is_some() && trees.root == base_trees.root {
        return Ok(CommitPlan {
            tree: trees.root,
            files,
            objects: 0,
            push: None,
        });
    }

    let commit = Commit {
        tree: trees.root,
        parents: input.parent.into_iter().collect(),
        author: input.author.clone(),
        committer: input
            .committer
            .clone()
            .unwrap_or_else(|| input.author.clone()),
        message: input.message.clone(),
    };
    let commit_body = commit.encode().map_err(|error| vec![error])?;
    let commit_id = object_id(Kind::Commit, &commit_body);

    // Without a parent the server has no tree yet, not even an empty one.
    let base_tree_ids: HashSet<ObjectId> = match input.parent {
        Some(_) => base_trees.objects.iter().map(|(id, _)| *id).collect(),
        None => HashSet::new(),
    };
    let mut objects: Vec<(Kind, &[u8])> = vec![(Kind::Commit, &commit_body)];
    for (id, body) in &trees.objects {
        if !base_tree_ids.contains(id) && seen.insert(*id) {
            objects.push((Kind::Tree, body));
        }
    }
    objects.extend(
        new_blobs
            .iter()
            .map(|(_, contents)| (Kind::Blob, *contents)),
    );

    let request = pack::write(&objects)
        .and_then(|pack| {
            let update = Update {
                old: input.parent.unwrap_or(ObjectId::ZERO),
                new: commit_id,
                name: input.reference.clone(),
            };
            receive_pack::request(&[update], &pack)
        })
        .map_err(|error| vec![error])?;
    Ok(CommitPlan {
        tree: trees.root,
        files,
        objects: objects.len(),
        push: Some(Push {
            commit: commit_id,
            request,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn author() -> Signature {
        Signature {
            name: "ShelfKit".to_owned(),
            email: "shelfkit@example.com".to_owned(),
            time: 1_700_000_000,
            offset: 0,
        }
    }

    fn contents(path: &str, text: &str) -> NewFile {
        NewFile {
            path: path.to_owned(),
            mode: Mode::File,
            source: Source::Contents(text.as_bytes().to_vec()),
        }
    }

    fn input(parent: Option<ObjectId>, base: Vec<FileEntry>, files: Vec<NewFile>) -> CommitInput {
        CommitInput {
            parent,
            base,
            files,
            reference: "refs/heads/main".to_owned(),
            author: author(),
            committer: None,
            message: "Save".to_owned(),
        }
    }

    #[test]
    fn the_same_files_on_their_parent_are_unchanged() {
        let first = plan_commit(&input(None, Vec::new(), vec![contents("a/b.md", "b")])).unwrap();
        assert!(!first.unchanged());
        assert_eq!(first.objects, 4); // commit, two trees, one blob
        let parent = first.push.as_ref().unwrap().commit;

        let again = plan_commit(&input(
            Some(parent),
            first.files.clone(),
            vec![contents("a/b.md", "b")],
        ))
        .unwrap();
        assert!(again.unchanged());
        assert_eq!(again.tree, first.tree);
        assert_eq!(again.objects, 0);

        // A known blob, by id, is the same file.
        let known = NewFile {
            path: "a/b.md".to_owned(),
            mode: Mode::File,
            source: Source::Known(first.files[0].id),
        };
        assert!(
            plan_commit(&input(Some(parent), first.files.clone(), vec![known]))
                .unwrap()
                .unchanged()
        );

        // A mode change is a change.
        let mut executable = contents("a/b.md", "b");
        executable.mode = Mode::Executable;
        let changed = plan_commit(&input(Some(parent), first.files, vec![executable])).unwrap();
        assert!(!changed.unchanged());
        assert_eq!(changed.objects, 3); // commit, two trees; the blob is known
    }

    #[test]
    fn a_known_blob_must_be_in_the_base() {
        let known = NewFile {
            path: "x".to_owned(),
            mode: Mode::File,
            source: Source::Known(object_id(Kind::Blob, b"elsewhere")),
        };
        let errors = plan_commit(&input(None, Vec::new(), vec![known])).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path(), "x");
    }

    #[test]
    fn reports_every_problem() {
        let mut bad = input(
            None,
            Vec::new(),
            vec![
                contents(".git/config", ""),
                contents("ok", ""),
                contents("ok", ""),
            ],
        );
        bad.reference = "main".to_owned();
        let errors = plan_commit(&bad).unwrap_err();
        let paths: Vec<&str> = errors.iter().map(Error::path).collect();
        assert_eq!(paths, ["main", ".git/config", "ok"]);
    }

    #[test]
    fn a_root_commit_with_no_files_is_the_empty_tree() {
        let plan = plan_commit(&input(None, Vec::new(), Vec::new())).unwrap();
        assert_eq!(
            plan.tree.to_string(),
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        );
        assert_eq!(plan.objects, 2);
    }
}
