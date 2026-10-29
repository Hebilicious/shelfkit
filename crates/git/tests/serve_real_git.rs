//! The server's side against the real `git` as a client: a repository kept in
//! memory and served over HTTP with nothing but `serve` and
//! `receive_pack::parse_request` answers `git push`, `clone`, `fetch`, and a
//! shallow clone, and what `git` ends up with passes `git fsck --strict`.
//!
//! Each test skips, saying so, when there is no `git` on PATH.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use flate2::read::GzDecoder;
use shelfkit_git::receive_pack::{RefStatus, parse_request};
use shelfkit_git::serve::{
    Service, UploadAnswer, advertise, parse_upload_request, status_report, upload_response,
};
use shelfkit_git::{Commit, Kind, ObjectId, pack, tree};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// A directory removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "shelfkit-serve-{name}-{}-{}",
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

// The test drives the real `git` against the library; the library spawns nothing.
#[allow(clippy::disallowed_methods)]
fn have_git(test: &str) -> bool {
    let found = Command::new("git").arg("--version").output().is_ok();
    if !found {
        eprintln!("skipped {test}: no `git` on PATH");
    }
    found
}

/// `git` in `dir`, with no user or system configuration.
// The test drives the real `git` against the library; the library spawns nothing.
#[allow(clippy::disallowed_methods)]
fn git_in(dir: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("HOME", dir)
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.com")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.com")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap()
}

/// `git` that must succeed; its stdout, trimmed.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = git_in(dir, args);
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// The repository the server keeps: objects by id, and references.
#[derive(Default)]
struct Repository {
    objects: HashMap<ObjectId, (Kind, Vec<u8>)>,
    refs: BTreeMap<String, ObjectId>,
}

impl Repository {
    fn commit(&self, id: ObjectId) -> Commit {
        let (kind, body) = &self.objects[&id];
        assert_eq!(*kind, Kind::Commit);
        Commit::decode(body).unwrap()
    }

    /// Every object reachable from `tree`, the tree included.
    fn tree_closure(&self, tree_id: ObjectId, into: &mut Vec<ObjectId>) {
        into.push(tree_id);
        for entry in tree::decode(&self.objects[&tree_id].1).unwrap() {
            match entry.mode {
                tree::EntryMode::Tree => self.tree_closure(entry.id, into),
                tree::EntryMode::Leaf(shelfkit_git::Mode::Gitlink) => {}
                tree::EntryMode::Leaf(_) => into.push(entry.id),
            }
        }
    }

    /// Every object reachable from `commits`, their histories whole.
    fn closure(&self, commits: &[ObjectId]) -> HashSet<ObjectId> {
        let mut seen = HashSet::new();
        let mut queue: VecDeque<ObjectId> = commits.iter().copied().collect();
        while let Some(id) = queue.pop_front() {
            if !seen.insert(id) {
                continue;
            }
            let commit = self.commit(id);
            let mut trees = Vec::new();
            self.tree_closure(commit.tree, &mut trees);
            seen.extend(trees);
            queue.extend(commit.parents);
        }
        seen
    }

    /// Answer one upload-pack request: the wanted commits, less what the
    /// client has, cut at its depth.
    fn upload(&self, body: &[u8]) -> Vec<u8> {
        let request = parse_upload_request(body).unwrap();
        let common: Vec<ObjectId> = request
            .haves
            .iter()
            .copied()
            .filter(|id| self.objects.contains_key(id))
            .collect();
        let has = self.closure(&common);
        let mut shallow = Vec::new();
        let mut send = Vec::new();
        let mut sent = HashSet::new();
        let mut queue: VecDeque<(ObjectId, u32)> =
            request.wants.iter().map(|id| (*id, 1)).collect();
        while let Some((id, depth)) = queue.pop_front() {
            if has.contains(&id) || !sent.insert(id) {
                continue;
            }
            let commit = self.commit(id);
            send.push(id);
            let mut trees = Vec::new();
            self.tree_closure(commit.tree, &mut trees);
            send.extend(trees.into_iter().filter(|id| !has.contains(id)));
            if request.depth.is_some_and(|limit| depth >= limit) {
                if !commit.parents.is_empty() {
                    shallow.push(id);
                }
            } else {
                queue.extend(commit.parents.iter().map(|parent| (*parent, depth + 1)));
            }
        }
        let mut unique = HashSet::new();
        let objects: Vec<(Kind, &[u8])> = send
            .into_iter()
            .filter(|id| unique.insert(*id))
            .map(|id| {
                let (kind, body) = &self.objects[&id];
                (*kind, body.as_slice())
            })
            .collect();
        upload_response(&UploadAnswer {
            deepens: request.deepens(),
            shallow: &shallow,
            unshallow: &[],
            negotiation: request.negotiation,
            common: &common,
            pack: &objects,
        })
        .unwrap()
    }

    /// Apply one receive-pack request: every object, then each update whose
    /// old side is the reference's current value.
    fn receive(&mut self, body: &[u8]) -> Vec<u8> {
        let request = parse_request(body).unwrap();
        if !request.pack.is_empty() {
            for object in pack::read(&request.pack).unwrap() {
                self.objects.insert(object.id, (object.kind, object.body));
            }
        }
        let refs: Vec<RefStatus> = request
            .updates
            .iter()
            .map(|update| {
                let current = self
                    .refs
                    .get(&update.name)
                    .copied()
                    .unwrap_or(ObjectId::ZERO);
                let result = if current != update.old {
                    Err("the reference moved: fetch first".to_owned())
                } else if update.new.is_zero() {
                    self.refs.remove(&update.name);
                    Ok(())
                } else {
                    self.refs.insert(update.name.clone(), update.new);
                    Ok(())
                };
                RefStatus {
                    name: update.name.clone(),
                    result,
                }
            })
            .collect();
        status_report(&Ok(()), &refs).unwrap()
    }
}

/// An HTTP request: its method, its path with the query, its headers, and its
/// body, decoded.
struct HttpRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Option<HttpRequest> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    let mut body = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value == "chunked")
    {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).ok()?;
            let size = usize::from_str_radix(size.trim(), 16).ok()?;
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).ok()?;
            if size == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..size]);
        }
    } else if let Some(length) = headers.get("content-length") {
        body = vec![0; length.parse().ok()?];
        reader.read_exact(&mut body).ok()?;
    }
    if headers
        .get("content-encoding")
        .is_some_and(|value| value == "gzip")
    {
        let mut inflated = Vec::new();
        GzDecoder::new(body.as_slice())
            .read_to_end(&mut inflated)
            .ok()?;
        body = inflated;
    }
    Some(HttpRequest {
        method,
        target,
        body,
    })
}

fn respond(mut stream: &TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\
         cache-control: no-cache\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
}

/// Serve `repository` at `http://127.0.0.1:<port>/repo.git` until the test
/// ends; the URL.
fn serve(repository: Arc<Mutex<Repository>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/repo.git", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let Some(request) = read_request(&stream) else {
                continue;
            };
            let mut repository = repository.lock().unwrap();
            match (request.method.as_str(), request.target.as_str()) {
                ("GET", target) if target.starts_with("/repo.git/info/refs?service=") => {
                    let service = if target.ends_with("git-receive-pack") {
                        Service::ReceivePack
                    } else {
                        Service::UploadPack
                    };
                    let refs: Vec<(String, ObjectId)> = repository
                        .refs
                        .iter()
                        .map(|(name, id)| (name.clone(), *id))
                        .collect();
                    let body = advertise(service, &refs, Some("refs/heads/main")).unwrap();
                    let content_type = format!("application/x-{}-advertisement", service.name());
                    respond(&stream, "200 OK", &content_type, &body);
                }
                ("POST", "/repo.git/git-upload-pack") => {
                    let body = repository.upload(&request.body);
                    respond(
                        &stream,
                        "200 OK",
                        "application/x-git-upload-pack-result",
                        &body,
                    );
                }
                ("POST", "/repo.git/git-receive-pack") => {
                    let body = repository.receive(&request.body);
                    respond(
                        &stream,
                        "200 OK",
                        "application/x-git-receive-pack-result",
                        &body,
                    );
                }
                _ => respond(&stream, "404 Not Found", "text/plain", b"not found"),
            }
        }
    });
    url
}

/// A working repository with `files` committed on `main`.
fn commit_files(dir: &Path, files: &[(&str, &str)], message: &str) {
    for (path, contents) in files {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    git(dir, &["add", "--all"]);
    git(dir, &["commit", "--quiet", "-m", message]);
}

#[test]
fn git_pushes_clones_and_fetches_through_the_server() {
    if !have_git("git_pushes_clones_and_fetches_through_the_server") {
        return;
    }
    let repository = Arc::new(Mutex::new(Repository::default()));
    let url = serve(Arc::clone(&repository));
    let work = TempDir::new("work");
    git(&work.0, &["init", "--quiet", "-b", "main"]);
    commit_files(
        &work.0,
        &[("shelf.json", "{}\n"), ("items/prompts/a/prompt.md", "A\n")],
        "first",
    );
    git(&work.0, &["push", "--quiet", &url, "main"]);
    let first = git(&work.0, &["rev-parse", "HEAD"]);
    assert_eq!(
        repository.lock().unwrap().refs["refs/heads/main"].to_string(),
        first
    );

    let clones = TempDir::new("clones");
    git(&clones.0, &["clone", "--quiet", &url, "copy"]);
    let copy = clones.0.join("copy");
    assert_eq!(git(&copy, &["rev-parse", "HEAD"]), first);
    assert_eq!(
        std::fs::read_to_string(copy.join("items/prompts/a/prompt.md")).unwrap(),
        "A\n"
    );
    git(&copy, &["fsck", "--strict"]);

    commit_files(&work.0, &[("items/prompts/b/prompt.md", "B\n")], "second");
    git(&work.0, &["push", "--quiet", &url, "main"]);
    git(&copy, &["pull", "--quiet", "--ff-only"]);
    assert_eq!(
        git(&copy, &["rev-parse", "HEAD"]),
        git(&work.0, &["rev-parse", "HEAD"])
    );
    assert_eq!(git(&copy, &["rev-list", "--count", "HEAD"]), "2");
    git(&copy, &["fsck", "--strict"]);
}

#[test]
fn a_shallow_clone_gets_one_commit() {
    if !have_git("a_shallow_clone_gets_one_commit") {
        return;
    }
    let repository = Arc::new(Mutex::new(Repository::default()));
    let url = serve(Arc::clone(&repository));
    let work = TempDir::new("work");
    git(&work.0, &["init", "--quiet", "-b", "main"]);
    commit_files(&work.0, &[("a", "1\n")], "first");
    commit_files(&work.0, &[("a", "2\n")], "second");
    commit_files(&work.0, &[("b", "3\n")], "third");
    git(&work.0, &["push", "--quiet", &url, "main"]);

    let clones = TempDir::new("clones");
    git(
        &clones.0,
        &["clone", "--quiet", "--depth", "1", &url, "shallow"],
    );
    let shallow = clones.0.join("shallow");
    assert_eq!(
        git(&shallow, &["rev-parse", "--is-shallow-repository"]),
        "true"
    );
    assert_eq!(git(&shallow, &["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(std::fs::read_to_string(shallow.join("a")).unwrap(), "2\n");
    git(&shallow, &["fsck", "--strict"]);
}

#[test]
fn a_push_that_does_not_fast_forward_is_reported_refused() {
    if !have_git("a_push_that_does_not_fast_forward_is_reported_refused") {
        return;
    }
    let repository = Arc::new(Mutex::new(Repository::default()));
    let url = serve(Arc::clone(&repository));
    let work = TempDir::new("work");
    git(&work.0, &["init", "--quiet", "-b", "main"]);
    commit_files(&work.0, &[("a", "1\n")], "first");
    git(&work.0, &["push", "--quiet", &url, "main"]);
    // Someone else's push moves the branch on the server.
    let other = TempDir::new("other");
    git(&other.0, &["clone", "--quiet", &url, "copy"]);
    commit_files(&other.0.join("copy"), &[("b", "2\n")], "theirs");
    git(
        &other.0.join("copy"),
        &["push", "--quiet", "origin", "main"],
    );

    commit_files(&work.0, &[("c", "3\n")], "mine");
    let refused = git_in(&work.0, &["push", &url, "main"]);
    assert!(!refused.status.success());
    let theirs = git(&other.0.join("copy"), &["rev-parse", "HEAD"]);
    assert_eq!(
        repository.lock().unwrap().refs["refs/heads/main"].to_string(),
        theirs
    );
}
