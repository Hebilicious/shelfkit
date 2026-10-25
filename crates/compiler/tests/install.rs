//! `shelfkit install <shelf>/<profile>`: adding a hosted profile to a repository's apm.yml, and handing APM the key a
//! private shelf needs, against an in-memory stand-in for a deployment's registry and GraphQL.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::json;
use shelfkit_compiler::cli::{Context, HttpRequest, HttpResponse, Platform, System, run};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

const URL: &str = "https://shelf.example.dev";
const KEY: &str = "sko_secretsecretsecretsecretsecretsecretsecr";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("shelfkit-install-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One process run: its arguments and the environment it was given.
type Run = (Vec<String>, Vec<(String, String)>);

/// A deployment holding one profile, `team/web`, and a machine with `uvx` on PATH that records what it runs.
struct Machine {
    /// The shelf is private: the registry answers 401 without the key.
    private: bool,
    /// What the keychain holds, by deployment URL.
    keychain: BTreeMap<String, String>,
    /// Every run: the arguments and the environment it was given.
    ran: RefCell<Vec<Run>>,
    /// Every HTTP request, as `METHOD url`, and whether it carried the key.
    requests: RefCell<Vec<(String, bool)>>,
    /// The newest published version, first in the registry's list.
    newest: RefCell<&'static str>,
}

impl Machine {
    fn new(private: bool) -> Self {
        Self {
            keychain: BTreeMap::new(),
            private,
            newest: RefCell::new("1.0.0"),
            ran: RefCell::new(Vec::new()),
            requests: RefCell::new(Vec::new()),
        }
    }

    fn logged_in(mut self) -> Self {
        self.keychain.insert(URL.to_owned(), KEY.to_owned());
        self
    }
}

fn answer(status: u16, body: &serde_json::Value) -> io::Result<HttpResponse> {
    Ok(HttpResponse {
        body: serde_json::to_vec(body).unwrap(),
        status,
    })
}

impl System for Machine {
    fn find(&self, program: &str) -> Option<PathBuf> {
        (program == "uvx").then(|| PathBuf::from("/fake/bin/uvx"))
    }
    fn capture(&self, program: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        panic!("captured {}", program.display());
    }
    fn run(
        &self,
        _: &Path,
        args: &[String],
        _: &Path,
        env: &[(String, String)],
    ) -> io::Result<i32> {
        self.ran.borrow_mut().push((args.to_vec(), env.to_vec()));
        Ok(0)
    }
    fn platform(&self) -> Platform {
        Platform::Unix
    }
    fn keychain_get(&self, account: &str) -> io::Result<Option<String>> {
        Ok(self.keychain.get(account).cloned())
    }
    fn http(&self, request: &HttpRequest) -> io::Result<HttpResponse> {
        let keyed = request
            .headers
            .iter()
            .any(|(name, value)| name == "authorization" && *value == format!("Bearer {KEY}"));
        self.requests
            .borrow_mut()
            .push((format!("{} {}", request.method, request.url), keyed));
        if self.private && !keyed {
            return answer(401, &json!({ "status": 401, "title": "Unauthorized" }));
        }
        match request.url.strip_prefix(URL).unwrap() {
            "/apm/v1/packages/team/web/versions" | "/apm/v1/packages/team/any/versions" => answer(
                200,
                &json!({ "versions": [
                    { "version": *self.newest.borrow(), "digest": "sha256:01", "published_at": "2026-10-25T01:00:00Z" },
                    { "version": "0.9.0", "digest": "sha256:00", "published_at": "2026-10-25T00:00:00Z" },
                ] }),
            ),
            "/graphql" if String::from_utf8_lossy(&request.body).contains("\"any\"") => answer(
                200,
                &json!({ "data": { "shelf": { "profile": { "resolution": {
                    "compile": { "targets": [] },
                    "items": [{ "kind": "prompt" }],
                } } } } }),
            ),
            "/graphql" => answer(
                200,
                &json!({ "data": { "shelf": { "profile": { "resolution": {
                    "compile": { "targets": ["claude", "codex"] },
                    "items": [{ "kind": "skill" }, { "kind": "stack" }],
                } } } } }),
            ),
            _ => answer(404, &json!({ "status": 404, "title": "Not Found" })),
        }
    }
}

struct Ran {
    code: u8,
    stderr: String,
}

fn shelfkit(cwd: &Path, system: &dyn System, args: &[&str]) -> Ran {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut ctx = Context {
        cwd: cwd.to_path_buf(),
        stdout: &mut stdout,
        stderr: &mut stderr,
        system,
    };
    let code = run(
        std::iter::once("shelfkit").chain(args.iter().copied()),
        &mut ctx,
    );
    Ran {
        code,
        stderr: String::from_utf8(stderr).unwrap(),
    }
}

#[test]
fn a_public_profile_goes_into_a_new_apm_yml_and_apm_installs_it() {
    let repo = scratch("my-app");
    let machine = Machine::new(false);
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    let name = repo.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(
        manifest,
        format!(
            "name: {name}\nversion: \"0.0.0\"\ntargets:\n  - claude\n  - codex\nregistries:\n  team:\n    url: \"{URL}/apm\"\n\
             dependencies:\n  apm:\n    - registry: team\n      id: team/web\n      version: \"1.0.0\"\n\
             compilation:\n  strategy: single-file\n  agents_md:\n    mode: managed_section\n"
        )
    );
    let ran_apm = machine.ran.borrow();
    let runs: Vec<String> = ran_apm
        .iter()
        .map(|(args, _)| args[3..].join(" "))
        .collect();
    assert_eq!(
        runs,
        [
            "experimental enable registries",
            "install",
            "compile --target codex"
        ],
        "a public shelf needs no registry in APM's user config"
    );
    assert!(
        ran_apm.iter().all(|(_, env)| env
            .iter()
            .all(|(name, _)| !name.starts_with("APM_REGISTRY_TOKEN_"))),
        "a public shelf needs no key"
    );
    assert!(machine.requests.borrow().iter().all(|(_, keyed)| !keyed));

    // The instructions go into AGENTS.md, which every agent reads, Claude Code through CLAUDE.md's import.
    assert_eq!(
        std::fs::read_to_string(repo.join("AGENTS.md")).unwrap(),
        "<!-- apm:start -->\n<!-- apm:end -->\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("CLAUDE.md")).unwrap(),
        "@AGENTS.md\n"
    );
}

#[test]
fn a_hand_written_agents_md_and_claude_md_are_kept_and_given_the_section_and_the_import() {
    let repo = scratch("hand-written");
    std::fs::write(repo.join("AGENTS.md"), "# Our rules\n\nBe kind.").unwrap();
    std::fs::write(repo.join("CLAUDE.md"), "# Claude\n").unwrap();
    let machine = Machine::new(false);
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        std::fs::read_to_string(repo.join("AGENTS.md")).unwrap(),
        "# Our rules\n\nBe kind.\n\n<!-- apm:start -->\n<!-- apm:end -->\n"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("CLAUDE.md")).unwrap(),
        "# Claude\n\n@AGENTS.md\n"
    );
    assert!(
        ran.stderr
            .contains("keeps everything else in the file as it is"),
        "{}",
        ran.stderr
    );

    // Once they are in place, a second install leaves both files alone.
    let again = shelfkit(&repo, &machine, &["install"]);
    assert_eq!(again.code, 0, "{}", again.stderr);
    assert!(!again.stderr.contains("AGENTS.md"), "{}", again.stderr);
    assert_eq!(
        std::fs::read_to_string(repo.join("CLAUDE.md")).unwrap(),
        "# Claude\n\n@AGENTS.md\n"
    );
}

#[cfg(unix)]
#[test]
fn a_claude_md_that_links_to_agents_md_is_left_as_it_is() {
    let repo = scratch("linked");
    std::fs::write(repo.join("AGENTS.md"), "# Rules\n").unwrap();
    std::os::unix::fs::symlink("AGENTS.md", repo.join("CLAUDE.md")).unwrap();
    let machine = Machine::new(false);
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(
        repo.join("CLAUDE.md")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("AGENTS.md")).unwrap(),
        "# Rules\n\n<!-- apm:start -->\n<!-- apm:end -->\n"
    );
}

#[test]
fn what_apm_yml_already_declares_is_kept() {
    let repo = scratch("kept");
    std::fs::write(
        repo.join("apm.yml"),
        "name: kept\nversion: 2.0.0\ntargets:\n  - cursor\ndependencies:\n  apm:\n    - acme/standards\n",
    )
    .unwrap();
    let machine = Machine::new(false);
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    assert!(
        manifest.starts_with("name: kept\nversion: \"2.0.0\"\ntargets:\n  - cursor\n"),
        "{manifest}"
    );
    assert!(
        manifest.contains("    - acme/standards\n    - registry: team\n"),
        "{manifest}"
    );

    // Installing again changes nothing.
    let again = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(again.code, 0, "{}", again.stderr);
    assert!(
        again.stderr.contains("apm.yml already installs team/web"),
        "{}",
        again.stderr
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("apm.yml")).unwrap(),
        manifest
    );
}

#[test]
fn a_private_shelf_without_a_key_says_to_log_in_and_writes_nothing() {
    let repo = scratch("private-no-key");
    let machine = Machine::new(true);
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr.contains(&format!("run `shelfkit login {URL}`")),
        "{}",
        ran.stderr
    );
    assert!(!repo.join("apm.yml").exists());
    assert!(machine.ran.borrow().is_empty());
}

#[test]
fn a_private_shelf_installs_with_the_key_in_apms_environment_and_never_prints_it() {
    let repo = scratch("private");
    let machine = Machine::new(true).logged_in();
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(!ran.stderr.contains(KEY));
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    assert!(!manifest.contains(KEY));
    {
        let ran_apm = machine.ran.borrow();
        let runs: Vec<String> = ran_apm
            .iter()
            .map(|(args, _)| args[3..].join(" "))
            .collect();
        assert_eq!(
            runs,
            [
                "experimental enable registries".to_owned(),
                format!("config set registry.team.url {URL}/apm"),
                "install".to_owned(),
                "compile --target codex".to_owned(),
            ]
        );
        let install = &ran_apm[2];
        assert!(
            install
                .1
                .contains(&("APM_REGISTRY_TOKEN_TEAM".to_owned(), KEY.to_owned())),
            "{:?}",
            install.1.iter().map(|(name, _)| name).collect::<Vec<_>>()
        );
        assert!(
            ran_apm
                .iter()
                .all(|(args, _)| !args.iter().any(|arg| arg.contains(KEY))),
            "a key on a command line"
        );
    }

    // A plain `shelfkit install` later, as after a fresh clone, hands APM the key again.
    machine.ran.borrow_mut().clear();
    let plain = shelfkit(&repo, &machine, &["install"]);
    assert_eq!(plain.code, 0, "{}", plain.stderr);
    assert!(
        machine
            .ran
            .borrow()
            .iter()
            .any(|(_, env)| env.contains(&("APM_REGISTRY_TOKEN_TEAM".to_owned(), KEY.to_owned())))
    );
}

#[test]
fn an_unknown_profile_is_named_and_nothing_is_written() {
    let repo = scratch("unknown");
    let machine = Machine::new(false);
    let ran = shelfkit(&repo, &machine, &["install", "team/nope", "--url", URL]);
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr.contains("has no profile team/nope"),
        "{}",
        ran.stderr
    );
    assert!(!repo.join("apm.yml").exists());
}

#[test]
fn a_profile_naming_no_agents_sets_up_the_common_four_unless_the_repository_shows_its_own() {
    let empty = scratch("no-targets");
    let machine = Machine::new(false);
    let ran = shelfkit(&empty, &machine, &["install", "team/any", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let manifest = std::fs::read_to_string(empty.join("apm.yml")).unwrap();
    assert!(
        manifest.contains("targets:\n  - claude\n  - codex\n  - copilot\n  - cursor\n"),
        "{manifest}"
    );
    assert!(
        !manifest.contains("compilation"),
        "a profile without instructions: {manifest}"
    );
    assert!(!empty.join("AGENTS.md").exists());

    let cursor = scratch("cursor-only");
    std::fs::create_dir_all(cursor.join(".cursor")).unwrap();
    let ran = shelfkit(&cursor, &machine, &["install", "team/any", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let manifest = std::fs::read_to_string(cursor.join("apm.yml")).unwrap();
    assert!(
        !manifest.contains("targets"),
        "APM detects Cursor: {manifest}"
    );
}

#[test]
fn the_newest_version_is_pinned_and_installing_again_moves_the_pin() {
    let repo = scratch("pin");
    let machine = Machine::new(false);
    let ran = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    assert!(
        manifest.contains("      version: \"1.0.0\"\n"),
        "{manifest}"
    );

    *machine.newest.borrow_mut() = "1.1.0";
    let again = shelfkit(&repo, &machine, &["install", "team/web", "--url", URL]);
    assert_eq!(again.code, 0, "{}", again.stderr);
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    assert!(
        manifest.contains("      version: \"1.1.0\"\n"),
        "{manifest}"
    );
    assert_eq!(manifest.matches("id: team/web").count(), 1, "{manifest}");
}
