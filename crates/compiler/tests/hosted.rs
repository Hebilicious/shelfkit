//! `shelfkit login`, `push`, and `fetch` against an in-memory stand-in for
//! the hosted service, speaking the same GraphQL operations and routes the
//! Worker serves. The Worker's own tests cover the service; these cover the
//! client: what it sends, what it keeps, and that a key is never printed.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shelfkit_compiler::cli::{
    Context, HttpRequest, HttpResponse, KEY_ENV, Platform, System, URL_ENV, run,
};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

const URL: &str = "https://shelf.example.dev";
const KEY: &str = "sko_secretsecretsecretsecretsecretsecretsecr";
const SIGN_IN_LINK: &str =
    "https://shelf.example.dev/link#ssl_owner_linklinklinklinklinklinklinklinklinklinklin";

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("shelfkit-hosted-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Default)]
struct State {
    objects: BTreeMap<String, Vec<u8>>,
    /// `path -> sha256` of the current snapshot.
    files: Option<BTreeMap<String, String>>,
    origin: String,
    packages: BTreeMap<(String, String), String>,
    requests: Vec<String>,
    /// Every object a commit has named: what `knownObjects` answers from.
    committed: std::collections::BTreeSet<String>,
}

/// The hosted service, in memory, plus a keychain and an environment.
struct Service {
    state: RefCell<State>,
    keychain: RefCell<BTreeMap<String, String>>,
    vars: BTreeMap<String, String>,
    config: PathBuf,
    typed_key: String,
    /// The browser opener on PATH, when the test gives the machine one.
    opener: Option<PathBuf>,
    /// Every command run with the opener, as its arguments.
    opened: RefCell<Vec<Vec<String>>>,
    /// What the opener exits with.
    opener_exit: i32,
    /// The machine has no browser opener on PATH.
    opener_missing: bool,
    platform: Platform,
}

impl Service {
    fn new(name: &str) -> Self {
        Self {
            config: scratch(&format!("{name}-config")),
            keychain: RefCell::new(BTreeMap::new()),
            state: RefCell::new(State::default()),
            typed_key: KEY.to_owned(),
            vars: BTreeMap::new(),
            opener: None,
            opened: RefCell::new(Vec::new()),
            opener_exit: 0,
            opener_missing: false,
            platform: Platform::Unix,
        }
    }

    /// As `shelfkit login` leaves things: the key in the keychain, the URL
    /// remembered.
    fn logged_in(name: &str) -> Self {
        let service = Self::new(name);
        service
            .keychain
            .borrow_mut()
            .insert(URL.to_owned(), KEY.to_owned());
        std::fs::create_dir_all(service.config.join("shelfkit")).unwrap();
        std::fs::write(
            service.config.join("shelfkit/config.json"),
            format!("{{ \"url\": \"{URL}\" }}\n"),
        )
        .unwrap();
        service
    }

    fn graphql(&self, body: &[u8]) -> Value {
        let request: Value = serde_json::from_slice(body).unwrap();
        let query = request["query"].as_str().unwrap();
        let variables = &request["variables"];
        let mut state = self.state.borrow_mut();
        if query.contains("createSignInLink") {
            return json!({ "data": { "createSignInLink": { "url": SIGN_IN_LINK, "expiresAt": "2026-10-22T12:15:00Z" } } });
        }
        if query.contains("viewer") {
            return json!({ "data": { "viewer": { "authenticated": true, "owner": true, "shelf": null, "keyName": null } } });
        }
        if query.contains("commitSnapshot") {
            let files: BTreeMap<String, String> = variables["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|file| {
                    (
                        file["path"].as_str().unwrap().to_owned(),
                        file["sha256"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let missing: Vec<&String> = files
                .values()
                .filter(|sha| !state.objects.contains_key(*sha))
                .collect();
            assert!(missing.is_empty(), "committed before uploading {missing:?}");
            let digest = format!(
                "sha256:{}",
                hex(serde_json::to_string(&files).unwrap().as_bytes())
            );
            state.committed.extend(files.values().cloned());
            state.files = Some(files);
            state.origin = "push".to_owned();
            return json!({ "data": { "commitSnapshot": { "ok": true, "reason": null, "errors": [], "missing": [], "snapshot": { "digest": digest, "fileCount": 0 } } } });
        }
        if query.contains("knownObjects") {
            let known: Vec<&String> = variables["sha256"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|sha| state.committed.get(sha.as_str().unwrap()))
                .collect();
            return json!({ "data": { "shelf": { "knownObjects": known } } });
        }
        if query.contains("Hosted") {
            let Some(files) = &state.files else {
                return json!({ "data": { "shelf": null } });
            };
            let listed: Vec<Value> = files
                .iter()
                .map(|(path, sha)| json!({ "path": path, "sha256": sha, "size": state.objects[sha].len() }))
                .collect();
            return json!({ "data": { "shelf": { "snapshot": { "digest": "sha256:current", "origin": state.origin }, "files": listed } } });
        }
        panic!("an operation the stand-in does not know: {query}");
    }
}

fn answer(status: u16, body: &[u8]) -> io::Result<HttpResponse> {
    Ok(HttpResponse {
        body: body.to_vec(),
        status,
    })
}

impl System for Service {
    fn find(&self, program: &str) -> Option<PathBuf> {
        if self.opener_missing {
            return None;
        }
        match &self.opener {
            Some(path) if program == "xdg-open" || program == "explorer" => Some(path.clone()),
            Some(_) => None,
            None => panic!("looked for `{program}` on PATH"),
        }
    }
    fn capture(&self, program: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        panic!("ran {}", program.display());
    }
    fn run(&self, program: &Path, args: &[String], _: &Path) -> io::Result<i32> {
        assert_eq!(
            Some(program),
            self.opener.as_deref(),
            "ran {}",
            program.display()
        );
        self.opened.borrow_mut().push(args.to_vec());
        Ok(self.opener_exit)
    }
    fn platform(&self) -> Platform {
        self.platform
    }

    fn http(&self, request: &HttpRequest) -> io::Result<HttpResponse> {
        let authorization = request
            .headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .map(|(_, value)| value.as_str());
        assert_eq!(authorization, Some(format!("Bearer {KEY}").as_str()));
        let path = request.url.strip_prefix(URL).unwrap().to_owned();
        self.state
            .borrow_mut()
            .requests
            .push(format!("{} {path}", request.method));
        if path == "/graphql" {
            return answer(
                200,
                &serde_json::to_vec(&self.graphql(&request.body)).unwrap(),
            );
        }
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let mut state = self.state.borrow_mut();
        match (request.method, parts.as_slice()) {
            ("PUT", ["raw", _, "objects", sha]) => {
                assert_eq!(hex(&request.body), *sha);
                state
                    .objects
                    .insert((*sha).to_owned(), request.body.clone());
                answer(204, b"")
            }
            ("GET", ["raw", _, "objects", sha]) => match state.objects.get(*sha) {
                Some(bytes) => answer(200, bytes),
                None => answer(404, b""),
            },
            ("PUT", ["apm", "v1", "packages", owner, repo, "versions", version]) => {
                let key = (format!("{owner}/{repo}"), (*version).replace("%2B", "+"));
                if state.packages.contains_key(&key) {
                    return answer(409, b"{}");
                }
                state
                    .packages
                    .insert(key, format!("sha256:{}", hex(&request.body)));
                answer(201, b"{}")
            }
            ("GET", ["apm", "v1", "packages", owner, repo, "versions"]) => {
                let package = format!("{owner}/{repo}");
                let versions: Vec<Value> = state
                    .packages
                    .iter()
                    .filter(|((name, _), _)| *name == package)
                    .map(|((_, version), digest)| json!({ "version": version, "digest": digest }))
                    .collect();
                answer(
                    200,
                    &serde_json::to_vec(&json!({ "versions": versions })).unwrap(),
                )
            }
            _ => panic!(
                "a route the stand-in does not serve: {} {path}",
                request.method
            ),
        }
    }

    fn keychain_get(&self, account: &str) -> io::Result<Option<String>> {
        Ok(self.keychain.borrow().get(account).cloned())
    }
    fn keychain_set(&self, account: &str, secret: &str) -> io::Result<()> {
        self.keychain
            .borrow_mut()
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
    fn keychain_delete(&self, account: &str) -> io::Result<bool> {
        Ok(self.keychain.borrow_mut().remove(account).is_some())
    }
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
    fn config_dir(&self) -> Option<PathBuf> {
        Some(self.config.clone())
    }
    fn read_secret(&self, _prompt: &str) -> io::Result<String> {
        Ok(self.typed_key.clone())
    }
}

struct Ran {
    code: u8,
    stdout: String,
    stderr: String,
}

fn shelfkit(system: &Service, cwd: &Path, args: &[&str]) -> Ran {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut ctx = Context {
        cwd: cwd.to_path_buf(),
        stderr: &mut stderr,
        stdout: &mut stdout,
        system,
    };
    let mut argv = vec!["shelfkit"];
    argv.extend_from_slice(args);
    let code = run(argv, &mut ctx);
    let ran = Ran {
        code,
        stderr: String::from_utf8(stderr).unwrap(),
        stdout: String::from_utf8(stdout).unwrap(),
    };
    assert!(
        !ran.stdout.contains(KEY) && !ran.stderr.contains(KEY),
        "a key was printed"
    );
    ran
}

fn own_shelf(name: &str) -> PathBuf {
    let dir = scratch(name).join("shelf");
    copy_dir(&repository_root().join("shelf"), &dir);
    dir
}

#[test]
fn login_keeps_the_key_in_the_keychain_and_remembers_the_deployment() {
    let service = Service::new("login");
    let ran = shelfkit(&service, &scratch("login-cwd"), &["login", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(ran.stdout.contains("account `https://shelf.example.dev`"));
    assert_eq!(
        service.keychain.borrow().get(URL).map(String::as_str),
        Some(KEY)
    );
    let config = std::fs::read_to_string(service.config.join("shelfkit/config.json")).unwrap();
    assert!(config.contains(URL) && !config.contains(KEY));

    let out = shelfkit(&service, &scratch("logout-cwd"), &["logout"]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(service.keychain.borrow().is_empty());
}

#[test]
fn open_makes_a_sign_in_link_with_the_owner_key_and_opens_it_without_printing_it() {
    let mut service = Service::logged_in("open");
    service.opener = Some(PathBuf::from("/usr/bin/xdg-open"));
    let ran = shelfkit(&service, &scratch("open-cwd"), &["open"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        *service.opened.borrow(),
        vec![vec![SIGN_IN_LINK.to_owned()]]
    );
    assert!(ran.stdout.contains("Add a passkey there"), "{}", ran.stdout);
    assert!(
        !ran.stdout.contains(SIGN_IN_LINK) && !ran.stderr.contains(SIGN_IN_LINK),
        "the link was printed"
    );
    assert_eq!(service.state.borrow().requests, vec!["POST /graphql"]);
}

#[test]
fn open_prints_the_link_only_when_asked() {
    let mut service = Service::logged_in("open-print");
    service.opener = Some(PathBuf::from("/usr/bin/xdg-open"));
    let printed = shelfkit(&service, &scratch("open-print-cwd"), &["open", "--print"]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    assert_eq!(printed.stdout.trim(), SIGN_IN_LINK);
    assert!(printed.stderr.contains("works once"));
    assert!(service.opened.borrow().is_empty());
}

#[test]
fn open_never_prints_the_link_when_the_browser_cannot_be_opened() {
    let mut failing = Service::logged_in("open-failing");
    failing.opener = Some(PathBuf::from("/usr/bin/xdg-open"));
    failing.opener_exit = 3;
    let ran = shelfkit(&failing, &scratch("open-failing-cwd"), &["open"]);
    assert_eq!(ran.code, 1);
    assert!(ran.stderr.contains("--print"), "{}", ran.stderr);
    assert!(!ran.stdout.contains(SIGN_IN_LINK) && !ran.stderr.contains(SIGN_IN_LINK));

    // With no opener on PATH at all, nothing is asked of the deployment and nothing is printed.
    let mut missing = Service::logged_in("open-missing");
    missing.opener_missing = true;
    let ran = shelfkit(&missing, &scratch("open-missing-cwd"), &["open"]);
    assert_eq!(ran.code, 1);
    assert!(ran.stderr.contains("--print"), "{}", ran.stderr);
    assert!(missing.state.borrow().requests.is_empty());
}

#[test]
fn open_does_not_read_windows_explorer_s_exit_status() {
    let mut service = Service::logged_in("open-windows");
    service.opener = Some(PathBuf::from("C:/Windows/explorer.exe"));
    service.opener_exit = 1;
    service.platform = Platform::Windows;
    let ran = shelfkit(&service, &scratch("open-windows-cwd"), &["open"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(ran.stdout.contains("Opened"), "{}", ran.stdout);
    assert!(!ran.stdout.contains(SIGN_IN_LINK) && !ran.stderr.contains(SIGN_IN_LINK));
    assert_eq!(
        *service.opened.borrow(),
        vec![vec![SIGN_IN_LINK.to_owned()]]
    );
}

#[test]
fn login_refuses_plain_http_to_a_host_that_is_not_loopback() {
    let service = Service::new("login-http");
    let ran = shelfkit(
        &service,
        &scratch("login-http-cwd"),
        &["login", "http://shelf.example.dev"],
    );
    assert_eq!(ran.code, 1);
    assert!(service.keychain.borrow().is_empty());
}

#[test]
fn push_uploads_each_file_once_commits_and_publishes_every_profile() {
    let service = Service::logged_in("push");
    let shelf = own_shelf("push");
    let ran = shelfkit(&service, &shelf, &["push", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(
        ran.stdout.contains("Pushed `hebilicious`"),
        "{}",
        ran.stdout
    );
    for profile in ["default", "agent-tools"] {
        assert!(
            ran.stdout
                .contains(&format!("Published hebilicious/{profile}@")),
            "{}",
            ran.stdout
        );
    }
    let state = service.state.borrow();
    let files = state.files.as_ref().unwrap();
    assert!(files.contains_key("shelf.json"));
    assert!(files.contains_key("items/prompts/commit-style/prompt.md"));
    assert_eq!(state.packages.len(), 2);
    drop(state);

    let again = shelfkit(&service, &shelf, &["push"]);
    assert_eq!(again.code, 0, "{}", again.stderr);
    assert!(again.stdout.contains("(0 uploaded)"), "{}", again.stdout);
    assert!(
        again.stdout.contains("already published with these bytes"),
        "{}",
        again.stdout
    );
}

#[test]
fn push_reads_the_key_from_the_environment_before_the_keychain() {
    let mut service = Service::new("push-env");
    service.vars.insert(KEY_ENV.to_owned(), KEY.to_owned());
    service.vars.insert(URL_ENV.to_owned(), URL.to_owned());
    let shelf = own_shelf("push-env");
    let ran = shelfkit(&service, &shelf, &["push", "--no-publish"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(service.state.borrow().packages.is_empty());
}

#[test]
fn push_does_not_overwrite_changes_made_on_the_service_without_force() {
    let service = Service::logged_in("push-edited");
    let shelf = own_shelf("push-edited");
    assert_eq!(shelfkit(&service, &shelf, &["push", "--url", URL]).code, 0);
    service.state.borrow_mut().origin = "edit".to_owned();
    std::fs::write(
        shelf.join("items/prompts/commit-style/prompt.md"),
        "Changed here.\n",
    )
    .unwrap();
    let refused = shelfkit(&service, &shelf, &["push"]);
    assert_eq!(refused.code, 1);
    assert!(
        refused.stderr.contains("shelfkit fetch"),
        "{}",
        refused.stderr
    );
    let forced = shelfkit(&service, &shelf, &["push", "--force", "--no-publish"]);
    assert_eq!(forced.code, 0, "{}", forced.stderr);
}

#[test]
fn fetch_writes_the_hosted_shelf_byte_for_byte_and_removes_what_it_no_longer_has() {
    let service = Service::logged_in("fetch");
    let shelf = own_shelf("fetch");
    assert_eq!(shelfkit(&service, &shelf, &["push", "--url", URL]).code, 0);

    let out = scratch("fetch-out");
    let ran = shelfkit(
        &service,
        &out,
        &[
            "fetch",
            "--id",
            "hebilicious",
            "--out",
            out.to_str().unwrap(),
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    for path in [
        "shelf.json",
        "items/prompts/commit-style/prompt.md",
        "profiles/default.json",
    ] {
        assert_eq!(
            std::fs::read(out.join(path)).unwrap(),
            std::fs::read(shelf.join(path)).unwrap(),
            "{path}"
        );
    }

    std::fs::create_dir_all(out.join("items/prompts/stale")).unwrap();
    std::fs::write(out.join("items/prompts/stale/item.json"), "{}").unwrap();
    let again = shelfkit(&service, &out, &["fetch", "--force"]);
    assert_eq!(again.code, 0, "{}", again.stderr);
    assert!(again.stdout.contains("1 removed"), "{}", again.stdout);
    assert!(!out.join("items/prompts/stale").exists());
}

#[test]
fn fetch_refuses_to_discard_work_that_was_never_pushed() {
    let service = Service::logged_in("fetch-unpushed");
    let shelf = own_shelf("fetch-unpushed");
    assert_eq!(shelfkit(&service, &shelf, &["push", "--url", URL]).code, 0);
    let prompt = shelf.join("items/prompts/commit-style/prompt.md");
    let pushed = std::fs::read(&prompt).unwrap();

    // An edit made here and never pushed, and a new item: neither is the service's to replace.
    std::fs::write(&prompt, "Edited here, not pushed.\n").unwrap();
    std::fs::create_dir_all(shelf.join("items/prompts/draft")).unwrap();
    std::fs::write(shelf.join("items/prompts/draft/item.json"), "{}").unwrap();
    let refused = shelfkit(&service, &shelf, &["fetch"]);
    assert_eq!(refused.code, 1);
    assert!(
        refused
            .stderr
            .contains("items/prompts/commit-style/prompt.md: changed here and never pushed"),
        "{}",
        refused.stderr
    );
    assert!(
        refused.stderr.contains("items/prompts/draft/item.json"),
        "{}",
        refused.stderr
    );
    assert_eq!(
        std::fs::read(&prompt).unwrap(),
        b"Edited here, not pushed.\n"
    );
    assert!(shelf.join("items/prompts/draft/item.json").exists());

    // `--force` discards them.
    let forced = shelfkit(&service, &shelf, &["fetch", "--force"]);
    assert_eq!(forced.code, 0, "{}", forced.stderr);
    assert_eq!(std::fs::read(&prompt).unwrap(), pushed);
    assert!(!shelf.join("items/prompts/draft").exists());

    // Content the service has had (an older push) is replaced by the newer one without `--force`.
    std::fs::write(&prompt, "A second version.\n").unwrap();
    assert_eq!(
        shelfkit(&service, &shelf, &["push", "--no-publish"]).code,
        0
    );
    std::fs::write(&prompt, &pushed).unwrap();
    let newer = shelfkit(&service, &shelf, &["fetch"]);
    assert_eq!(newer.code, 0, "{}", newer.stderr);
    assert_eq!(std::fs::read(&prompt).unwrap(), b"A second version.\n");
}

#[test]
fn a_command_with_no_key_says_how_to_log_in() {
    let service = Service::new("no-key");
    let shelf = own_shelf("no-key");
    let ran = shelfkit(&service, &shelf, &["push", "--url", URL]);
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr
            .contains("shelfkit login https://shelf.example.dev"),
        "{}",
        ran.stderr
    );
}
