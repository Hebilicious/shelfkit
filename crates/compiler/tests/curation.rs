//! Curation (issue #8) from the CLI's side.
//!
//! - The curated shelf the importers build from recorded responses
//!   (`packages/importers/test/fixtures/curated-shelf`, M4's exit criterion)
//!   loads with `crates/core` and compiles; its manifest is a golden file.
//! - `shelfkit doctor` reports drift by replaying the importers' recorded
//!   responses (`packages/importers/test/fixtures/http`): the requests are the
//!   hosted importer's, byte for byte, and doctor writes nothing.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::Value;
use shelfkit_compiler::cli::{Context, HttpRequest, HttpResponse, Platform, System, run};
use shelfkit_compiler::engine::{Request, plan};
use shelfkit_core::{DirSource, load};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn curated() -> PathBuf {
    repository_root().join("packages/importers/test/fixtures/curated-shelf")
}

fn golden(relative: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(relative);
    if std::env::var_os("SHELFKIT_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!("missing {relative}: run with SHELFKIT_UPDATE_GOLDEN=1 to create it")
    });
    assert_eq!(
        expected, actual,
        "{relative} changed; if intended, regenerate with SHELFKIT_UPDATE_GOLDEN=1"
    );
}

#[test]
fn the_curated_shelf_loads_with_provenance_and_licence_on_every_item_and_compiles() {
    let source = DirSource::new(curated());
    let shelf =
        load(&source).unwrap_or_else(|errors| panic!("the curated shelf does not load:\n{errors}"));
    assert_eq!(shelf.items.len(), 7);
    let mut sources = std::collections::BTreeSet::new();
    for loaded in shelf.items.values() {
        let item_source = loaded
            .item
            .source
            .as_ref()
            .unwrap_or_else(|| panic!("{} is not an import", loaded.item.id));
        assert!(
            item_source.license.is_some(),
            "{} records no licence",
            loaded.item.id
        );
        assert!(
            item_source.resolved_commit.is_some() || item_source.version.is_some(),
            "{} is not pinned",
            loaded.item.id
        );
        sources.insert(item_source.id.clone().unwrap());
    }
    assert_eq!(
        sources.into_iter().collect::<Vec<_>>(),
        [
            "anthropics",
            "awesome-copilot",
            "clawhub",
            "hebilicious",
            "mcp-registry"
        ]
    );
    // The link-only skill carries its provenance and no content.
    let link = &shelf.items["doc-coauthoring"];
    assert_eq!(link.files.keys().collect::<Vec<_>>(), ["item.json"]);

    let compiled = plan(&source, &Request::default()).unwrap_or_else(|errors| panic!("{errors}"));
    golden("curated/default.apm.yml", &compiled.apm_yml);
    golden("curated/default.plan.json", &compiled.to_json());
    for expected in [
        "git: anthropics/skills/skills/brand-guidelines",
        "git: github/awesome-copilot/instructions/rust.instructions.md",
        "git: github/awesome-copilot/agents/CSharpExpert.agent.md",
        "id: hebilicious/default",
        "https://shelfkit.hebilicious.workers.dev/apm",
        "io.github.github/github-mcp-server",
    ] {
        assert!(
            compiled.apm_yml.contains(expected),
            "{expected} missing from\n{}",
            compiled.apm_yml
        );
    }
    // ClawHub's skill has no Git upstream, so its MIT-0 copy is vendored.
    assert!(
        compiled
            .files
            .iter()
            .any(|file| file.path.ends_with("skills/github/SKILL.md"))
    );
}

/// A machine whose network is the importers' recorded responses, and which
/// records every request. It has no programs and refuses to run any.
struct Recorded {
    responses: BTreeMap<String, Value>,
    requests: RefCell<Vec<String>>,
}

impl Recorded {
    fn new() -> Self {
        let mut responses = BTreeMap::new();
        let dir = repository_root().join("packages/importers/test/fixtures/http");
        for entry in std::fs::read_dir(dir).unwrap() {
            let fixture: Value =
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
            for (key, answer) in fixture["responses"].as_object().unwrap() {
                responses.insert(key.clone(), answer.clone());
            }
        }
        Self {
            responses,
            requests: RefCell::new(Vec::new()),
        }
    }
}

impl System for Recorded {
    fn find(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn capture(&self, program: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        panic!("ran {}", program.display());
    }
    fn run(
        &self,
        program: &Path,
        _: &[String],
        _: &Path,
        _: &[(String, String)],
    ) -> io::Result<i32> {
        panic!("ran {}", program.display());
    }
    fn platform(&self) -> Platform {
        Platform::Unix
    }
    fn http(&self, request: &HttpRequest) -> io::Result<HttpResponse> {
        let key = if request.method == "GET" {
            request.url.clone()
        } else {
            format!(
                "{} {} {}",
                request.method,
                request.url,
                String::from_utf8_lossy(&request.body)
            )
        };
        self.requests.borrow_mut().push(key.clone());
        let answer = self
            .responses
            .get(&key)
            .unwrap_or_else(|| panic!("not recorded: {key}"));
        let body = if let Some(json) = answer.get("json") {
            serde_json::to_vec(json).unwrap()
        } else {
            answer["text"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec()
        };
        Ok(HttpResponse {
            status: u16::try_from(answer["status"].as_u64().unwrap()).unwrap(),
            body,
        })
    }
}

struct Ran {
    code: u8,
    stdout: String,
}

fn shelfkit(cwd: &Path, system: &dyn System, args: &[&str]) -> Ran {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let code = {
        let mut ctx = Context {
            cwd: cwd.to_path_buf(),
            stdout: &mut stdout,
            stderr: &mut stderr,
            system,
        };
        run(
            std::iter::once("shelfkit").chain(args.iter().copied()),
            &mut ctx,
        )
    };
    Ran {
        code,
        stdout: String::from_utf8(stdout).unwrap(),
    }
}

/// Every file under a directory, with its bytes.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.insert(path.clone(), std::fs::read(&path).unwrap());
            }
        }
    }
    files
}

#[test]
fn doctor_finds_every_import_of_the_curated_shelf_current_and_writes_nothing() {
    let shelf = curated();
    let before = snapshot(&shelf);
    let machine = Recorded::new();
    let ran = shelfkit(
        &shelf,
        &machine,
        &["doctor", "--shelf", shelf.to_str().unwrap()],
    );
    assert_eq!(ran.code, 0, "{}", ran.stdout);
    assert!(
        ran.stdout
            .contains("drift       7 imported item(s): 7 current, 0 moved, 0 gone, 0 not checked"),
        "{}",
        ran.stdout
    );
    assert_eq!(snapshot(&shelf), before, "doctor wrote to the shelf");
}

/// A scratch shelf of imports pinned to what upstream has since left behind.
fn drifted_shelf(name: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("shelfkit-curation-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let write = |path: &str, text: &str| {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    };
    write("shelf.json", r#"{ "name": "drifted" }"#);
    // A commit before brand-guidelines last changed, and one after.
    write(
        "items/skills/brand-guidelines/item.json",
        r#"{ "id": "brand-guidelines", "kind": "skill", "title": "Brand guidelines",
             "source": { "repo": "https://github.com/anthropics/skills", "path": "skills/brand-guidelines", "ref": "main",
                         "resolvedCommit": "0f77e501e6506235956d953cd2d7a2a4aa9ba133", "license": "Apache-2.0" } }"#,
    );
    write(
        "items/skills/brand-guidelines-later/item.json",
        r#"{ "id": "brand-guidelines-later", "kind": "skill", "title": "Brand guidelines",
             "source": { "repo": "https://github.com/anthropics/skills", "path": "skills/brand-guidelines", "ref": "main",
                         "resolvedCommit": "683bc88e56f3e09ba94f7055977f3d3aa499f202", "license": "Apache-2.0" } }"#,
    );
    write(
        "items/skills/removed/item.json",
        r#"{ "id": "removed", "kind": "skill", "title": "Removed",
             "source": { "repo": "https://github.com/anthropics/skills", "path": "skills/no-such-skill", "ref": "main",
                         "resolvedCommit": "0f77e501e6506235956d953cd2d7a2a4aa9ba133" } }"#,
    );
    write(
        "items/skills/github/item.json",
        r#"{ "id": "github", "kind": "skill", "title": "Github",
             "source": { "url": "https://clawhub.ai/steipete/skills/github", "path": "steipete/github", "version": "0.9.0" } }"#,
    );
    write(
        "items/mcp/github-mcp-server/item.json",
        r#"{ "id": "github-mcp-server", "kind": "mcp", "flavour": "remote", "name": "io.github.github/github-mcp-server", "title": "GitHub",
             "source": { "url": "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.github%2Fgithub-mcp-server/versions/0.0.1", "version": "0.0.1" } }"#,
    );
    write(
        "items/prompts/commit-style/item.json",
        r#"{ "id": "commit-style", "kind": "prompt", "title": "Commit message",
             "source": { "url": "https://shelfkit.hebilicious.workers.dev", "path": "hebilicious/commit-style",
                         "digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000" } }"#,
    );
    root
}

#[test]
fn doctor_reports_moved_and_gone_imports_from_every_source() {
    let shelf = drifted_shelf("report");
    let machine = Recorded::new();
    let ran = shelfkit(
        &shelf,
        &machine,
        &["doctor", "--shelf", shelf.to_str().unwrap()],
    );
    assert_eq!(ran.code, 0, "{}", ran.stdout);
    assert!(
        ran.stdout
            .contains("drift       6 imported item(s): 1 current, 4 moved, 1 gone, 0 not checked"),
        "{}",
        ran.stdout
    );
    for line in [
        "moved   brand-guidelines: pinned 0f77e50, upstream main at dbd4588",
        "gone    removed: pinned 0f77e50, upstream main at dbd4588",
        "moved   github: pinned 0.9.0, upstream 1.0.0",
        "moved   github-mcp-server: pinned 0.0.1, upstream 2.0.2",
        "moved   commit-style: pinned sha256:000000000000, upstream sha256:",
    ] {
        assert!(
            ran.stdout.contains(line),
            "{line} missing from\n{}",
            ran.stdout
        );
    }
    assert!(
        !ran.stdout.contains("brand-guidelines-later:"),
        "{}",
        ran.stdout
    );
    let _ = std::fs::remove_dir_all(shelf);
}

#[test]
fn doctor_offline_reads_nothing() {
    let shelf = drifted_shelf("offline");
    let machine = Recorded::new();
    let ran = shelfkit(
        &shelf,
        &machine,
        &["doctor", "--offline", "--shelf", shelf.to_str().unwrap()],
    );
    assert_eq!(ran.code, 0);
    assert!(
        ran.stdout.contains("drift       not checked (--offline)"),
        "{}",
        ran.stdout
    );
    assert!(machine.requests.borrow().is_empty());
    let _ = std::fs::remove_dir_all(shelf);
}

/// A hosted deployment that runs one import job: discovery finds a licensed
/// skill and an unlicensed one, and applying imports what was picked.
struct Deployment {
    picked: RefCell<Option<Value>>,
    sent: RefCell<Vec<Value>>,
}

impl System for Deployment {
    fn find(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn capture(&self, program: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        panic!("ran {}", program.display());
    }
    fn run(
        &self,
        program: &Path,
        _: &[String],
        _: &Path,
        _: &[(String, String)],
    ) -> io::Result<i32> {
        panic!("ran {}", program.display());
    }
    fn platform(&self) -> Platform {
        Platform::Unix
    }
    fn var(&self, name: &str) -> Option<String> {
        (name == "SHELFKIT_KEY").then(|| "sks_curated_test".to_owned())
    }
    fn http(&self, request: &HttpRequest) -> io::Result<HttpResponse> {
        assert_eq!(
            request.url, "https://shelf.example/graphql",
            "add reads nothing but the deployment"
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        self.sent.borrow_mut().push(body.clone());
        let query = body["query"].as_str().unwrap();
        let candidates = serde_json::json!([
            { "key": "skills/pdf/SKILL.md", "kind": "skill", "id": "pdf", "licenseId": "Apache-2.0", "linkOnly": false },
            { "key": "skills/docs/SKILL.md", "kind": "skill", "id": "docs", "license": "none stated", "linkOnly": true },
        ]);
        let job = |status: &str, imported: Value, warnings: Value| {
            serde_json::json!({ "id": "job-1", "status": status, "error": null, "warnings": warnings,
                                "imported": imported, "candidates": candidates })
        };
        let data = if query.contains("startImport") {
            serde_json::json!({ "startImport": job("queued", serde_json::json!([]), serde_json::json!([])) })
        } else if query.contains("pickImport") {
            *self.picked.borrow_mut() = Some(body["variables"]["picks"].clone());
            serde_json::json!({ "pickImport": job("importing", serde_json::json!([]), serde_json::json!([])) })
        } else {
            let found = match &*self.picked.borrow() {
                None => job(
                    "ready",
                    serde_json::json!([]),
                    serde_json::json!(["1 of 2 candidates have no licence"]),
                ),
                Some(picks) => {
                    let ids: Vec<Value> = picks
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|pick| {
                            if pick["candidate"] == "skills/pdf/SKILL.md" {
                                "pdf".into()
                            } else {
                                "docs".into()
                            }
                        })
                        .collect();
                    job(
                        "done",
                        Value::Array(ids),
                        serde_json::json!(["docs: imported as a link, without its content"]),
                    )
                }
            };
            serde_json::json!({ "shelf": { "importJob": found } })
        };
        Ok(HttpResponse {
            status: 200,
            body: serde_json::to_vec(&serde_json::json!({ "data": data })).unwrap(),
        })
    }
}

#[test]
fn add_lists_a_remote_source_through_the_hosted_import_then_imports_what_was_picked() {
    let root = std::env::temp_dir().join(format!("shelfkit-curation-{}-add", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("shelf.json"),
        r#"{ "name": "curated", "registry": { "namespace": "curated" } }"#,
    )
    .unwrap();
    let before = snapshot(&root);

    let deployment = Deployment {
        picked: RefCell::new(None),
        sent: RefCell::new(Vec::new()),
    };
    let listed = shelfkit(
        &root,
        &deployment,
        &[
            "add",
            "https://github.com/anthropics/skills/tree/main/skills",
            "--url",
            "https://shelf.example",
        ],
    );
    assert_eq!(listed.code, 0, "{}", listed.stdout);
    assert!(
        listed
            .stdout
            .contains("warning: 1 of 2 candidates have no licence"),
        "{}",
        listed.stdout
    );
    assert!(
        listed
            .stdout
            .contains("skills/pdf/SKILL.md  skill pdf  (Apache-2.0)"),
        "{}",
        listed.stdout
    );
    assert!(
        listed
            .stdout
            .contains("skills/docs/SKILL.md  skill docs  (none stated)  link only"),
        "{}",
        listed.stdout
    );
    let started = &deployment.sent.borrow()[0];
    assert_eq!(
        started["variables"],
        serde_json::json!({ "shelf": "curated", "source": {
            "kind": "git", "repo": "https://github.com/anthropics/skills", "ref": "main", "path": "skills" } })
    );

    let deployment = Deployment {
        picked: RefCell::new(None),
        sent: RefCell::new(Vec::new()),
    };
    let imported = shelfkit(
        &root,
        &deployment,
        &[
            "add",
            "anthropics/skills",
            "--pick",
            "skills/docs/SKILL.md",
            "--url",
            "https://shelf.example",
        ],
    );
    assert_eq!(imported.code, 0, "{}", imported.stdout);
    assert!(
        imported.stdout.contains("imported docs"),
        "{}",
        imported.stdout
    );
    assert!(
        imported.stdout.contains("docs: imported as a link"),
        "{}",
        imported.stdout
    );
    assert!(
        imported.stdout.contains("shelfkit fetch"),
        "{}",
        imported.stdout
    );
    // The import happened on the hosted shelf; this one is untouched until `fetch`.
    assert_eq!(snapshot(&root), before);
    let _ = std::fs::remove_dir_all(root);
}

/// A machine with `GITHUB_TOKEN` set, whose network answers 404, or
/// `answer` for POSTs, and records each request's URL and whether it
/// carried a credential.
struct Watched {
    sent: RefCell<Vec<(String, bool)>>,
    post: &'static str,
}

impl System for Watched {
    fn find(&self, _: &str) -> Option<PathBuf> {
        None
    }
    fn capture(&self, program: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        panic!("ran {}", program.display());
    }
    fn run(
        &self,
        program: &Path,
        _: &[String],
        _: &Path,
        _: &[(String, String)],
    ) -> io::Result<i32> {
        panic!("ran {}", program.display());
    }
    fn platform(&self) -> Platform {
        Platform::Unix
    }
    fn var(&self, name: &str) -> Option<String> {
        (name == "GITHUB_TOKEN").then(|| "ghp_doctor_test_token".to_owned())
    }
    fn http(&self, request: &HttpRequest) -> io::Result<HttpResponse> {
        let carried = request
            .headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization"));
        self.sent.borrow_mut().push((request.url.clone(), carried));
        if request.method == "POST" {
            return Ok(HttpResponse {
                status: 200,
                body: self.post.as_bytes().to_vec(),
            });
        }
        Ok(HttpResponse {
            status: 404,
            body: Vec::new(),
        })
    }
}

fn shelf_with(name: &str, items: &[(&str, &str)]) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("shelfkit-curation-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("shelf.json"), r#"{ "name": "watched" }"#).unwrap();
    for (path, text) in items {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    root
}

#[test]
fn doctor_sends_the_github_token_to_api_github_com_and_nowhere_else() {
    let shelf = shelf_with(
        "token",
        &[
            (
                "items/mcp/lookalike/item.json",
                r#"{ "id": "lookalike", "kind": "mcp", "flavour": "remote", "name": "x/y", "title": "Lookalike",
                     "source": { "url": "https://api.github.com.evil.example/v0.1/servers/x/versions/1", "version": "1" } }"#,
            ),
            (
                "items/skills/kit/item.json",
                r#"{ "id": "kit", "kind": "skill", "title": "Kit",
                     "source": { "repo": "https://github.com/acme/kit", "path": "skills/kit", "resolvedCommit": "0000000000000000000000000000000000000000" } }"#,
            ),
        ],
    );
    let machine = Watched {
        sent: RefCell::new(Vec::new()),
        post: "{}",
    };
    let ran = shelfkit(
        &shelf,
        &machine,
        &["doctor", "--shelf", shelf.to_str().unwrap()],
    );
    assert_eq!(ran.code, 0, "{}", ran.stdout);
    let sent = machine.sent.borrow();
    assert!(
        sent.iter()
            .any(|(url, _)| url.starts_with("https://api.github.com.evil.example/")),
        "{sent:?}"
    );
    for (url, carried) in sent.iter() {
        assert_eq!(
            *carried,
            url.starts_with("https://api.github.com/"),
            "{url}"
        );
    }
    let _ = std::fs::remove_dir_all(shelf);
}

#[test]
fn doctor_reports_a_graphql_error_from_an_instance_as_an_error_not_as_gone() {
    let shelf = shelf_with(
        "graphql-error",
        &[(
            "items/prompts/commit-style/item.json",
            r#"{ "id": "commit-style", "kind": "prompt", "title": "Commit message",
                 "source": { "url": "https://shelf.example", "path": "team/commit-style", "digest": "sha256:00" } }"#,
        )],
    );
    let machine = Watched {
        sent: RefCell::new(Vec::new()),
        post: r#"{ "errors": [{ "message": "the shelf is being migrated" }] }"#,
    };
    let ran = shelfkit(
        &shelf,
        &machine,
        &["doctor", "--shelf", shelf.to_str().unwrap()],
    );
    assert!(
        ran.stdout.contains(
            "error   commit-style: https://shelf.example/graphql: the shelf is being migrated"
        ),
        "{}",
        ran.stdout
    );
    let _ = std::fs::remove_dir_all(shelf);
}
