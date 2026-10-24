//! The library against the real `git`: pushes it plans are applied by `git
//! receive-pack` and pass `git fsck --strict`, its ids are the ones `git`
//! computes, and it reads packs `git pack-objects` writes, deltas included.
//!
//! Each test skips, saying so, when there is no `git` on PATH.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_git::pack;
use shelfkit_git::receive_pack::{self, parse_report};
use shelfkit_git::{
    CommitInput, CommitPlan, FileEntry, Kind, Mode, NewFile, ObjectId, Signature, Source,
    object_id, plan_commit,
};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A directory removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "shelfkit-git-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// The test checks the library against the real `git`; the library spawns nothing.
#[allow(clippy::disallowed_methods)]
fn have_git(test: &str) -> bool {
    let found = Command::new("git").arg("--version").output().is_ok();
    if !found {
        eprintln!("skipped {test}: no `git` on PATH");
    }
    found
}

/// `git` in `dir`, with no user or system configuration, fed `stdin`.
// The test checks the library against the real `git`; the library spawns nothing.
#[allow(clippy::disallowed_methods)]
fn git_in(dir: &Path, args: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("HOME", dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

/// `git` that must succeed; its stdout.
fn git(dir: &Path, args: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> Vec<u8> {
    let output = git_in(dir, args, stdin, env);
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap()
}

fn signature() -> Signature {
    Signature {
        name: "ShelfKit Test".to_owned(),
        email: "test@shelfkit.invalid".to_owned(),
        time: 1_760_000_000,
        offset: 7 * 60,
    }
}

fn contents(path: &str, mode: Mode, bytes: &[u8]) -> NewFile {
    NewFile {
        path: path.to_owned(),
        mode,
        source: Source::Contents(bytes.to_vec()),
    }
}

fn known(file: &FileEntry) -> NewFile {
    NewFile {
        path: file.path.clone(),
        mode: file.mode,
        source: Source::Known(file.id),
    }
}

/// Push a plan's request into the bare repository at `repo` with `git
/// receive-pack`, and read its report.
fn push(repo: &Path, plan: &CommitPlan) -> receive_pack::Report {
    let request = &plan.push.as_ref().unwrap().request;
    let output = git_in(
        repo,
        &["receive-pack", "--stateless-rpc", "."],
        request,
        &[],
    );
    assert!(
        output.status.success(),
        "receive-pack failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    parse_report(&output.stdout).unwrap()
}

/// `git ls-tree -r` of a revision: path to (mode, id).
fn ls_tree(repo: &Path, revision: &str) -> BTreeMap<String, (String, String)> {
    text(git(repo, &["ls-tree", "-r", revision], b"", &[]))
        .lines()
        .map(|line| {
            let (meta, path) = line.split_once('\t').unwrap();
            let fields: Vec<&str> = meta.split(' ').collect();
            (
                path.to_owned(),
                (fields[0].to_owned(), fields[2].to_owned()),
            )
        })
        .collect()
}

/// Check the repository's `refs/heads/main` holds exactly `files`.
fn assert_tree(repo: &Path, files: &[(&str, Mode, &[u8])]) {
    let listed = ls_tree(repo, "refs/heads/main");
    let expected: BTreeMap<String, (String, String)> = files
        .iter()
        .map(|(path, mode, bytes)| {
            let id = object_id(Kind::Blob, bytes).to_string();
            ((*path).to_owned(), (mode.as_str().to_owned(), id))
        })
        .collect();
    assert_eq!(listed, expected);
    for (path, _, bytes) in files {
        let (_, id) = &listed[*path];
        assert_eq!(
            git(repo, &["cat-file", "blob", id], b"", &[]),
            *bytes,
            "{path}"
        );
    }
}

#[test]
fn pushes_that_real_git_applies() {
    if !have_git("pushes_that_real_git_applies") {
        return;
    }
    let dir = TempDir::new("push");
    git(&dir.0, &["init", "--bare", "--quiet", "repo"], b"", &[]);
    let repo = dir.0.join("repo");
    let files: Vec<(&str, Mode, &[u8])> = vec![
        ("shelf.json", Mode::File, b"{ \"name\": \"t\" }\n"),
        (
            "items/prompts/hi/item.json",
            Mode::File,
            b"{ \"id\": \"hi\" }\n",
        ),
        ("items/prompts/hi/prompt.md", Mode::File, b"Say hi.\n"),
        ("items/prompts/hi/copy.md", Mode::File, b"Say hi.\n"),
        ("bin/run.sh", Mode::Executable, b"#!/bin/sh\necho hi\n"),
        ("link", Mode::Symlink, b"shelf.json"),
        ("binary.bin", Mode::File, &[0, 159, 146, 150, 255]),
    ];
    let first = plan_commit(&CommitInput {
        parent: None,
        base: Vec::new(),
        files: files
            .iter()
            .map(|(path, mode, bytes)| contents(path, *mode, bytes))
            .collect(),
        reference: "refs/heads/main".to_owned(),
        author: signature(),
        committer: None,
        message: "Create the shelf".to_owned(),
    })
    .unwrap();
    let report = push(&repo, &first);
    assert!(report.is_ok(), "{report:?}");
    assert_eq!(report.refs[0].name, "refs/heads/main");
    git(&repo, &["fsck", "--strict", "--no-dangling"], b"", &[]);
    assert_tree(&repo, &files);
    let first_commit = first.push.as_ref().unwrap().commit;
    assert_eq!(
        text(git(&repo, &["rev-parse", "refs/heads/main"], b"", &[])).trim(),
        first_commit.to_string()
    );
    // Seven files, six distinct blobs; root, bin, items, prompts, hi; the commit.
    assert_eq!(first.objects, 12);

    // Change shelf.json, delete bin/run.sh, add a file in a new directory.
    let second_files: Vec<(&str, Mode, &[u8])> = vec![
        ("shelf.json", Mode::File, b"{ \"name\": \"t2\" }\n"),
        (
            "items/prompts/hi/item.json",
            Mode::File,
            b"{ \"id\": \"hi\" }\n",
        ),
        ("items/prompts/hi/prompt.md", Mode::File, b"Say hi.\n"),
        ("items/prompts/hi/copy.md", Mode::File, b"Say hi.\n"),
        ("link", Mode::Symlink, b"shelf.json"),
        ("binary.bin", Mode::File, &[0, 159, 146, 150, 255]),
        ("profiles/new/p.json", Mode::File, b"{ \"id\": \"p\" }\n"),
    ];
    let by_path = |path: &str| first.files.iter().find(|file| file.path == path).unwrap();
    let second = plan_commit(&CommitInput {
        parent: Some(first_commit),
        base: first.files.clone(),
        files: vec![
            contents("shelf.json", Mode::File, b"{ \"name\": \"t2\" }\n"),
            known(by_path("items/prompts/hi/item.json")),
            // Unchanged contents, sent anyway: the blob is still not packed.
            contents("items/prompts/hi/prompt.md", Mode::File, b"Say hi.\n"),
            known(by_path("items/prompts/hi/copy.md")),
            known(by_path("link")),
            known(by_path("binary.bin")),
            contents("profiles/new/p.json", Mode::File, b"{ \"id\": \"p\" }\n"),
        ],
        reference: "refs/heads/main".to_owned(),
        author: signature(),
        committer: Some(Signature {
            time: 1_760_000_100,
            ..signature()
        }),
        message: "Edit the shelf\n\nWith a body.\n".to_owned(),
    })
    .unwrap();
    // The commit, the root, profiles, profiles/new, and two new blobs.
    assert_eq!(second.objects, 6);
    let request = receive_pack::parse_request(&second.push.as_ref().unwrap().request).unwrap();
    let packed = pack::read(&request.pack).unwrap();
    assert_eq!(packed.len(), 6);
    for object in &packed {
        let exists = git_in(&repo, &["cat-file", "-e", &object.id.to_string()], b"", &[]);
        assert!(!exists.status.success(), "{} was already there", object.id);
    }
    let report = push(&repo, &second);
    assert!(report.is_ok(), "{report:?}");
    git(&repo, &["fsck", "--strict", "--no-dangling"], b"", &[]);
    assert_tree(&repo, &second_files);
    let parents = text(git(
        &repo,
        &["rev-list", "--parents", "-n", "1", "refs/heads/main"],
        b"",
        &[],
    ));
    assert_eq!(
        parents.trim(),
        format!("{} {first_commit}", second.push.as_ref().unwrap().commit)
    );

    // A push from a stale parent is refused by the server, for that ref.
    let stale = plan_commit(&CommitInput {
        parent: Some(first_commit),
        base: first.files.clone(),
        files: vec![contents("other.md", Mode::File, b"other\n")],
        reference: "refs/heads/main".to_owned(),
        author: signature(),
        committer: None,
        message: "Stale".to_owned(),
    })
    .unwrap();
    let report = push(&repo, &stale);
    assert_eq!(report.unpack, Ok(()));
    assert_eq!(report.refs.len(), 1);
    assert!(report.refs[0].result.is_err(), "{report:?}");
    assert!(!report.is_ok());
    assert_tree(&repo, &second_files);
}

#[test]
fn a_gitlink_survives_a_second_commit() {
    if !have_git("a_gitlink_survives_a_second_commit") {
        return;
    }
    let dir = TempDir::new("gitlink");
    git(&dir.0, &["init", "--bare", "--quiet", "repo"], b"", &[]);
    let repo = dir.0.join("repo");
    // A commit of another repository, which this one never has.
    let submodule = object_id(
        Kind::Commit,
        b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n",
    );
    let gitlink = NewFile {
        path: "vendor/sub".to_owned(),
        mode: Mode::Gitlink,
        source: Source::Known(submodule),
    };
    let request = |parent, base, files, message: &str| CommitInput {
        parent,
        base,
        files,
        reference: "refs/heads/main".to_owned(),
        author: signature(),
        committer: None,
        message: message.to_owned(),
    };
    let first = plan_commit(&request(
        None,
        Vec::new(),
        vec![contents("shelf.json", Mode::File, b"{}\n"), gitlink.clone()],
        "With a submodule",
    ))
    .unwrap();
    assert!(push(&repo, &first).is_ok());
    git(&repo, &["fsck", "--strict", "--no-dangling"], b"", &[]);

    // The Worker passes the whole tree back: the gitlink by id, in `base`
    // and in `files`, while a file beside it changes.
    let second = plan_commit(&request(
        Some(first.push.as_ref().unwrap().commit),
        first.files.clone(),
        vec![
            contents("shelf.json", Mode::File, b"{ \"name\": \"t\" }\n"),
            known(&first.files[1]),
        ],
        "Edit beside the submodule",
    ))
    .unwrap();
    // The commit, the root tree, and the new blob; `vendor` is unchanged.
    assert_eq!(second.objects, 3);
    assert!(push(&repo, &second).is_ok());
    git(&repo, &["fsck", "--strict", "--no-dangling"], b"", &[]);
    let listed = ls_tree(&repo, "refs/heads/main");
    assert_eq!(
        listed["vendor/sub"],
        ("160000".to_owned(), submodule.to_string())
    );
    let types = text(git(&repo, &["ls-tree", "refs/heads/main:vendor"], b"", &[]));
    assert_eq!(types, format!("160000 commit {submodule}\tsub\n"));
}

#[test]
fn ids_match_what_git_computes() {
    if !have_git("ids_match_what_git_computes") {
        return;
    }
    let dir = TempDir::new("ids");
    git(&dir.0, &["init", "--quiet", "repo"], b"", &[]);
    let repo = dir.0.join("repo");
    // Names chosen to exercise the canonical order: `a.b` < `a/` < `a0`.
    let files: Vec<(&str, Mode, &[u8])> = vec![
        ("a0", Mode::File, b"zero\n"),
        ("a/x", Mode::Executable, b"#!/bin/sh\n"),
        ("a.b", Mode::File, b"dot\n"),
        ("a-b/c/d", Mode::Symlink, b"../../a0"),
        ("A", Mode::File, b""),
    ];
    let mut entries = Vec::new();
    for (path, mode, bytes) in &files {
        let id = text(git(&repo, &["hash-object", "-w", "--stdin"], bytes, &[]));
        assert_eq!(id.trim(), object_id(Kind::Blob, bytes).to_string());
        git(
            &repo,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("{mode},{},{path}", id.trim()),
            ],
            b"",
            &[],
        );
        entries.push(FileEntry {
            path: (*path).to_owned(),
            mode: *mode,
            id: id.trim().parse().unwrap(),
        });
    }
    let tree = text(git(&repo, &["write-tree"], b"", &[]));
    let trees = shelfkit_git::tree::build(&entries).unwrap();
    assert_eq!(trees.root.to_string(), tree.trim());

    // `git mktree` builds the same root from its listing.
    let listing = git(&repo, &["ls-tree", tree.trim()], b"", &[]);
    let mktree = text(git(&repo, &["mktree"], &listing, &[]));
    assert_eq!(mktree.trim(), tree.trim());
    for (id, body) in &trees.objects {
        assert_eq!(
            git(&repo, &["cat-file", "tree", &id.to_string()], b"", &[]),
            *body
        );
    }

    let env = [
        ("GIT_AUTHOR_NAME", "ShelfKit Test"),
        ("GIT_AUTHOR_EMAIL", "test@shelfkit.invalid"),
        ("GIT_AUTHOR_DATE", "1760000000 +0700"),
        ("GIT_COMMITTER_NAME", "Other Person"),
        ("GIT_COMMITTER_EMAIL", "other@shelfkit.invalid"),
        ("GIT_COMMITTER_DATE", "1760000500 -0230"),
    ];
    let root = text(git(
        &repo,
        &["commit-tree", tree.trim(), "-m", "Root"],
        b"",
        &env,
    ));
    let root: ObjectId = root.trim().parse().unwrap();
    let child = text(git(
        &repo,
        &[
            "commit-tree",
            tree.trim(),
            "-p",
            &root.to_string(),
            "-m",
            "Child",
        ],
        b"",
        &env,
    ));
    let committer = Signature {
        name: "Other Person".to_owned(),
        email: "other@shelfkit.invalid".to_owned(),
        time: 1_760_000_500,
        offset: -150,
    };
    let ours = |parent: Option<ObjectId>, message: &str| {
        let body = shelfkit_git::Commit {
            tree: trees.root,
            parents: parent.into_iter().collect(),
            author: signature(),
            committer: committer.clone(),
            message: message.to_owned(),
        }
        .encode()
        .unwrap();
        object_id(Kind::Commit, &body)
    };
    assert_eq!(ours(None, "Root"), root);
    assert_eq!(ours(Some(root), "Child").to_string(), child.trim());

    // And `plan_commit` makes that same root commit.
    let plan = plan_commit(&CommitInput {
        parent: None,
        base: Vec::new(),
        files: files
            .iter()
            .map(|(path, mode, bytes)| contents(path, *mode, bytes))
            .collect(),
        reference: "refs/heads/main".to_owned(),
        author: signature(),
        committer: Some(committer.clone()),
        message: "Root".to_owned(),
    })
    .unwrap();
    assert_eq!(plan.push.unwrap().commit, root);

    // Decoding git's commit gives back what was asked for.
    let body = git(&repo, &["cat-file", "commit", child.trim()], b"", &[]);
    let decoded = shelfkit_git::Commit::decode(&body).unwrap();
    assert_eq!(decoded.parents, [root]);
    assert_eq!(decoded.committer, committer);
    assert_eq!(decoded.author, signature());
    assert_eq!(decoded.message, "Child\n");
}

#[test]
fn reads_packs_git_writes_with_deltas() {
    if !have_git("reads_packs_git_writes_with_deltas") {
        return;
    }
    let dir = TempDir::new("pack");
    git(&dir.0, &["init", "--bare", "--quiet", "repo"], b"", &[]);
    let repo = dir.0.join("repo");
    // Large, similar blobs: git stores all but one as deltas.
    let base: String = (0..2000)
        .map(|line| format!("line {line} of the shelf\n"))
        .collect();
    let mut blobs = Vec::new();
    for version in 0..6 {
        let mut blob = base.clone();
        blob.insert_str(
            blob.len() / 2,
            &format!("an edit made in version {version}\n"),
        );
        blob.push_str(&format!("version {version}\n"));
        blobs.push(blob.into_bytes());
    }
    let mut ids = Vec::new();
    for blob in &blobs {
        let id = text(git(&repo, &["hash-object", "-w", "--stdin"], blob, &[]));
        ids.push(id.trim().to_owned());
    }
    let listing = ids.join("\n") + "\n";
    for flags in [&["--delta-base-offset"][..], &[][..]] {
        let mut args = vec!["pack-objects", "--stdout", "-q"];
        args.extend_from_slice(flags);
        let pack_bytes = git(&repo, &args, listing.as_bytes(), &[]);

        // Prove git deltified: `verify-pack -v` lists a base for each delta.
        let pack_path = dir.0.join("check.pack");
        std::fs::write(&pack_path, &pack_bytes).unwrap();
        git(&dir.0, &["index-pack", "check.pack"], b"", &[]);
        let verified = text(git(&dir.0, &["verify-pack", "-v", "check.idx"], b"", &[]));
        let deltas = verified
            .lines()
            .filter(|line| line.split_whitespace().count() == 7)
            .count();
        assert!(deltas > 0, "git stored no deltas ({flags:?}):\n{verified}");
        std::fs::remove_file(&pack_path).unwrap();
        std::fs::remove_file(dir.0.join("check.idx")).unwrap();

        let objects = pack::read(&pack_bytes).unwrap();
        assert_eq!(objects.len(), blobs.len());
        let read: BTreeMap<String, (Kind, Vec<u8>)> = objects
            .into_iter()
            .map(|object| (object.id.to_string(), (object.kind, object.body)))
            .collect();
        for (id, blob) in ids.iter().zip(&blobs) {
            assert_eq!(read[id].0, Kind::Blob);
            assert_eq!(&read[id].1, blob, "{id} ({flags:?})");
        }
    }
}
