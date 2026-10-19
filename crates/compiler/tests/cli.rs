//! The `shelfkit` command line, in process through `cli::run`, and once as
//! the real binary for the one case that depends on the machine's `PATH`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::cli::{Context, HostSystem, Platform, System, run};
use shelfkit_compiler::schema;
use shelfkit_compiler::yaml::Node;
use std::cell::RefCell;
use std::io;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn all_kinds() -> PathBuf {
    repository_root().join("crates/core/tests/fixtures/all-kinds")
}

/// A fresh, empty directory for one test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("shelfkit-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A `System` that refuses to be used: any lookup or process is a test
/// failure. Passing it proves a command never looks for or runs APM.
struct NoProcesses;

impl System for NoProcesses {
    fn find(&self, program: &str) -> Option<PathBuf> {
        panic!("looked for `{program}` on PATH");
    }
    fn capture(&self, program: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        panic!("ran {}", program.display());
    }
    fn run(&self, program: &Path, _: &[String], _: &Path) -> io::Result<i32> {
        panic!("ran {}", program.display());
    }
    fn platform(&self) -> Platform {
        Platform::Unix
    }
}

/// A machine with the given programs on PATH, recording what is run.
struct FakeMachine {
    programs: Vec<&'static str>,
    platform: Platform,
    ran: RefCell<Vec<(PathBuf, Vec<String>, PathBuf)>>,
}

impl FakeMachine {
    fn with(programs: &[&'static str]) -> Self {
        Self {
            programs: programs.to_vec(),
            platform: Platform::Unix,
            ran: RefCell::new(Vec::new()),
        }
    }
}

impl System for FakeMachine {
    fn find(&self, program: &str) -> Option<PathBuf> {
        self.programs
            .contains(&program)
            .then(|| PathBuf::from(format!("/fake/bin/{program}")))
    }
    fn capture(&self, _: &Path, _: &[&str]) -> io::Result<(i32, String)> {
        Ok((
            0,
            "Agent Package Manager (APM) CLI version 0.33.0 (abc1234)\n".to_owned(),
        ))
    }
    fn run(&self, program: &Path, args: &[String], dir: &Path) -> io::Result<i32> {
        self.ran
            .borrow_mut()
            .push((program.to_path_buf(), args.to_vec(), dir.to_path_buf()));
        Ok(0)
    }
    fn platform(&self) -> Platform {
        self.platform
    }
}

struct Ran {
    code: u8,
    stdout: String,
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
        stdout: String::from_utf8(stdout).unwrap(),
        stderr: String::from_utf8(stderr).unwrap(),
    }
}

/// Every file under `dir`, relative, sorted.
fn tree(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current).unwrap().filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                found.push(
                    path.strip_prefix(dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    found.sort();
    found
}

#[test]
fn compile_dry_run_prints_a_manifest_that_validates_against_the_vendored_schema() {
    let shelf = all_kinds();
    for profile in ["base", "full", "minimal"] {
        let ran = shelfkit(&shelf, &NoProcesses, &["compile", "--dry-run", profile]);
        assert_eq!(ran.code, 0, "{}", ran.stderr);
        let manifest = Node::parse(&ran.stdout).unwrap();
        assert_eq!(
            schema::validate(&manifest),
            Ok(()),
            "{profile}:\n{}",
            ran.stdout
        );
    }
}

#[test]
fn compile_never_reaches_a_process_when_writing_dry_running_or_checking() {
    let repo = scratch("no-processes");
    let shelf = all_kinds();
    let shelf_arg = shelf.to_str().unwrap();
    for args in [
        vec!["--shelf", shelf_arg, "compile", "full"],
        vec!["--shelf", shelf_arg, "compile", "full", "--frozen"],
        vec![
            "--shelf",
            shelf_arg,
            "compile",
            "full",
            "--dry-run",
            "--json",
        ],
        vec!["--shelf", shelf_arg, "verify", "full"],
        vec!["--shelf", shelf_arg, "check"],
    ] {
        let ran = shelfkit(&repo, &NoProcesses, &args);
        assert_eq!(ran.code, 0, "{args:?}: {}", ran.stderr);
    }
    // It wrote the manifest and the vendored packages, and nothing APM writes.
    let files = tree(&repo);
    assert!(files.contains(&"apm.yml".to_owned()));
    assert!(files.contains(&"vendor/full/.apm/hooks/format-on-save.json".to_owned()));
    assert!(!files.iter().any(|f| f.starts_with("apm.lock")
        || f.starts_with("apm_modules")
        || f.starts_with(".claude")));
}

#[test]
fn dry_run_json_is_the_plan_and_the_golden_file() {
    let ran = shelfkit(
        &all_kinds(),
        &NoProcesses,
        &["compile", "--dry-run", "--json", "full"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let golden = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/all-kinds/full.plan.json"),
    )
    .unwrap();
    assert_eq!(ran.stdout, golden);
}

#[test]
fn frozen_fails_until_the_repository_matches_and_writes_nothing() {
    let repo = scratch("frozen");
    let shelf = all_kinds();
    let shelf_arg = shelf.to_str().unwrap();
    let frozen = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal", "--frozen"],
    );
    assert_eq!(frozen.code, 1);
    assert!(
        frozen.stderr.contains("would create apm.yml"),
        "{}",
        frozen.stderr
    );
    assert!(tree(&repo).is_empty(), "--frozen wrote files");

    assert_eq!(
        shelfkit(
            &repo,
            &NoProcesses,
            &["--shelf", shelf_arg, "compile", "minimal"]
        )
        .code,
        0
    );
    assert_eq!(
        shelfkit(
            &repo,
            &NoProcesses,
            &["--shelf", shelf_arg, "compile", "minimal", "--frozen"]
        )
        .code,
        0
    );

    std::fs::write(
        repo.join("vendor/minimal/.apm/prompts/pr-description.prompt.md"),
        "edited\n",
    )
    .unwrap();
    let drifted = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "verify", "minimal"],
    );
    assert_eq!(drifted.code, 1);
    assert!(
        drifted.stderr.contains("pr-description.prompt.md differs"),
        "{}",
        drifted.stderr
    );
}

#[test]
fn an_existing_manifest_keeps_its_own_declarations_and_conflicts_follow_on_conflict() {
    let repo = scratch("conflict");
    let shelf = all_kinds();
    let shelf_arg = shelf.to_str().unwrap();
    std::fs::write(
        repo.join("apm.yml"),
        "name: my-app\nversion: 2.0.0\ntargets: [claude]\ndependencies:\n  apm:\n    - acme/standards#v1\n",
    )
    .unwrap();
    let failed = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "base"],
    );
    assert_eq!(failed.code, 1);
    assert!(failed.stderr.contains("`targets`"), "{}", failed.stderr);
    assert!(
        !repo.join("vendor").exists(),
        "a failed compile wrote files"
    );

    let ran = shelfkit(
        &repo,
        &NoProcesses,
        &[
            "--shelf",
            shelf_arg,
            "compile",
            "base",
            "--on-conflict",
            "shelf-wins",
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    assert_eq!(
        manifest,
        "name: my-app\nversion: \"2.0.0\"\ntargets:\n  - claude\n  - copilot\ndependencies:\n  apm:\n    \
         - acme/standards#v1\n    - ./vendor/base\n"
    );
}

#[test]
fn install_with_neither_apm_nor_uv_prints_the_install_command_and_installs_nothing() {
    let repo = scratch("install-missing");
    std::fs::write(repo.join("apm.yml"), "name: x\nversion: 1.0.0\n").unwrap();
    for (platform, command) in [
        (
            Platform::Unix,
            "curl -LsSf https://astral.sh/uv/install.sh | sh",
        ),
        (
            Platform::Windows,
            "powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\"",
        ),
    ] {
        let machine = FakeMachine {
            platform,
            ..FakeMachine::with(&[])
        };
        let ran = shelfkit(&repo, &machine, &["install"]);
        assert_eq!(ran.code, 1);
        assert!(ran.stderr.contains(command), "{}", ran.stderr);
        assert!(machine.ran.borrow().is_empty(), "something was run");
    }
    assert_eq!(tree(&repo), ["apm.yml"]);
}

#[test]
fn install_through_uvx_prints_the_pinned_command_before_running_it_in_the_repository() {
    let repo = scratch("install-uvx");
    std::fs::write(repo.join("apm.yml"), "name: x\nversion: 1.0.0\n").unwrap();
    let machine = FakeMachine::with(&["uvx"]);
    let ran = shelfkit(&repo, &machine, &["install", "--", "--dry-run"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(
        ran.stderr
            .starts_with("$ uvx --from apm-cli==0.33.0 apm install --dry-run\n"),
        "{}",
        ran.stderr
    );
    let ran_calls = machine.ran.borrow();
    assert_eq!(ran_calls.len(), 1);
    assert_eq!(
        ran_calls[0].1,
        ["--from", "apm-cli==0.33.0", "apm", "install", "--dry-run"]
    );
    assert_eq!(ran_calls[0].2, repo);
}

#[test]
fn install_prefers_apm_on_the_path_and_doctor_reports_the_choice() {
    let repo = scratch("install-path");
    std::fs::write(repo.join("apm.yml"), "name: x\nversion: 1.0.0\n").unwrap();
    let machine = FakeMachine::with(&["apm", "uvx"]);
    let ran = shelfkit(&repo, &machine, &["install"]);
    assert!(ran.stderr.starts_with("$ apm install\n"), "{}", ran.stderr);

    let doctor = shelfkit(&repo, &FakeMachine::with(&["apm"]), &["doctor"]);
    assert_eq!(doctor.code, 0);
    assert!(
        doctor.stdout.contains("0.33.0, in the supported range"),
        "{}",
        doctor.stdout
    );
    assert!(doctor.stdout.contains("issue #8"), "{}", doctor.stdout);
    let missing = shelfkit(&repo, &FakeMachine::with(&[]), &["doctor"]);
    assert!(
        missing
            .stdout
            .contains("curl -LsSf https://astral.sh/uv/install.sh | sh"),
        "{}",
        missing.stdout
    );
}

/// The binary itself, with an empty `PATH`: the acceptance case as a user
/// meets it.
#[test]
// Runs the built binary as a user would; it is not product code spawning APM.
#[allow(clippy::disallowed_methods)]
fn the_binary_without_apm_or_uv_on_path_fails_with_the_install_command() {
    let repo = scratch("binary-missing");
    std::fs::write(repo.join("apm.yml"), "name: x\nversion: 1.0.0\n").unwrap();
    let empty = scratch("binary-missing-path");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_shelfkit"))
        .arg("install")
        .current_dir(&repo)
        .env("PATH", &empty)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    let expected = if cfg!(windows) {
        "irm https://astral.sh/uv/install.ps1 | iex"
    } else {
        "curl -LsSf https://astral.sh/uv/install.sh | sh"
    };
    assert!(stderr.contains(expected), "{stderr}");
    assert_eq!(tree(&repo), ["apm.yml"]);
}

#[test]
fn init_add_ls_show_and_rm_manage_a_shelf() {
    let root = scratch("manage");
    let shelf = root.join("shelf");
    let ran = shelfkit(&root, &NoProcesses, &["init", "shelf"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);

    // A local package in APM's layout.
    let package = root.join("team-kit");
    std::fs::create_dir_all(package.join(".apm/prompts")).unwrap();
    std::fs::create_dir_all(package.join(".apm/skills/release-notes")).unwrap();
    std::fs::create_dir_all(package.join(".apm/hooks")).unwrap();
    std::fs::write(
        package.join(".apm/prompts/standup.prompt.md"),
        "---\ndescription: Write a standup.\n---\n\nSummarize yesterday.\n",
    )
    .unwrap();
    std::fs::write(
        package.join(".apm/skills/release-notes/SKILL.md"),
        "---\nname: release-notes\ndescription: Draft release notes.\n---\n\nRead the log.\n",
    )
    .unwrap();
    std::fs::write(package.join(".apm/hooks/fmt.json"), r#"{ "Stop": [] }"#).unwrap();

    let ran = shelfkit(&shelf, &NoProcesses, &["add", "../team-kit"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout
            .lines()
            .filter(|l| l.starts_with("added"))
            .count(),
        3,
        "{}",
        ran.stdout
    );

    let listed = shelfkit(&shelf, &NoProcesses, &["ls", "--json"]);
    let rows: serde_json::Value = serde_json::from_str(&listed.stdout).unwrap();
    let ids: Vec<&str> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["fmt", "release-notes", "standup"]);

    let shown = shelfkit(&shelf, &NoProcesses, &["show", "standup", "--json"]);
    let item: serde_json::Value = serde_json::from_str(&shown.stdout).unwrap();
    assert_eq!(item["item"]["source"]["id"], "team-kit");
    assert_eq!(
        item["item"]["source"]["path"],
        ".apm/prompts/standup.prompt.md"
    );

    // Selected in a profile, it compiles into the vendored package.
    std::fs::write(
        shelf.join("profiles/default.json"),
        r#"{ "id": "default", "title": "Default", "items": ["standup", "fmt"] }"#,
    )
    .unwrap();
    let dry = shelfkit(&shelf, &NoProcesses, &["compile", "--dry-run", "--json"]);
    assert_eq!(dry.code, 0, "{}", dry.stderr);
    assert!(
        dry.stdout
            .contains("vendor/default/.apm/prompts/standup.prompt.md")
    );

    // Adding the same items again is refused, with nothing written.
    let again = shelfkit(&shelf, &NoProcesses, &["add", "../team-kit"]);
    assert_eq!(again.code, 1);
    assert!(again.stderr.contains("already exists"), "{}", again.stderr);

    let refused = shelfkit(&shelf, &NoProcesses, &["rm", "standup"]);
    assert_eq!(refused.code, 1);
    assert!(
        refused
            .stderr
            .contains("profile `default` (profiles/default.json)"),
        "{}",
        refused.stderr
    );
    let removed = shelfkit(&shelf, &NoProcesses, &["rm", "release-notes"]);
    assert_eq!(removed.code, 0, "{}", removed.stderr);
    assert!(!shelf.join("items/skills/release-notes").exists());
    assert_eq!(shelfkit(&shelf, &NoProcesses, &["check"]).code, 0);
}

#[test]
fn add_refuses_every_source_kind_but_a_local_path_and_fetches_nothing() {
    let root = scratch("add-remote");
    assert_eq!(shelfkit(&root, &NoProcesses, &["init"]).code, 0);
    for source in [
        "https://github.com/anthropics/skills",
        "anthropics/skills",
        "git@github.com:o/r.git",
    ] {
        let ran = shelfkit(&root, &NoProcesses, &["add", source]);
        assert_eq!(ran.code, 1, "{source}");
        assert!(ran.stderr.contains("issue #8"), "{source}: {}", ran.stderr);
    }
}

#[test]
fn check_reports_load_errors_with_their_files_and_fails() {
    let shelf = repository_root().join("crates/core/tests/fixtures/errors");
    let ran = shelfkit(&shelf, &NoProcesses, &["check"]);
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr.contains("items/libraries/typo/item.json:"),
        "{}",
        ran.stderr
    );
}

#[test]
fn recommend_reads_a_repositorys_markers() {
    let repo = scratch("recommend");
    std::fs::write(repo.join("wrangler.jsonc"), "{}").unwrap();
    std::fs::write(
        repo.join("package.json"),
        r#"{ "packageManager": "pnpm@11.8.0", "dependencies": { "vue": "3" } }"#,
    )
    .unwrap();
    let shelf = all_kinds();
    let ran = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf.to_str().unwrap(), "recommend"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(ran.stdout.contains("vue-cloudflare"), "{}", ran.stdout);
    assert!(
        ran.stdout.contains("recommended by vue-cloudflare"),
        "{}",
        ran.stdout
    );
}

/// The issue's integration check: APM accepts what ShelfKit compiles. It runs
/// only where an `apm` binary is on PATH, or, with
/// `SHELFKIT_TEST_APM_UVX=1`, through the pinned `uvx`, and skips otherwise.
///
/// It installs ShelfKit's own shelf, then a shelf that exercises what a
/// manifest can get wrong with APM: an item from a plain-http loopback
/// registry (served by this test), a Git item while that registry is the
/// default, an MCP object entry, and a vendored prompt. APM's configuration
/// (the experimental `registries` flag) goes to a scratch `HOME`.
#[test]
// Runs APM itself, which is the point of the test.
#[allow(clippy::disallowed_methods)]
fn apm_install_accepts_compiled_manifests_when_apm_is_present() {
    use shelfkit_compiler::cli::apm::Runner;
    let host = HostSystem;
    let runner = Runner::resolve(&host);
    let usable = match &runner {
        Runner::Path { .. } => true,
        Runner::Uvx { .. } => std::env::var_os("SHELFKIT_TEST_APM_UVX").is_some(),
        Runner::Missing => false,
    };
    if !usable {
        eprintln!(
            "skipping: no `apm` binary on PATH, so `apm install` was not run against a compiled manifest \
             (set SHELFKIT_TEST_APM_UVX=1 to run the pinned APM through uvx)"
        );
        return;
    }

    let root = scratch("apm-install");
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let real_home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let cache =
        std::env::var_os("XDG_CACHE_HOME").map_or_else(|| real_home.join(".cache"), PathBuf::from);
    let data = std::env::var_os("XDG_DATA_HOME")
        .map_or_else(|| real_home.join(".local/share"), PathBuf::from);
    let apm = |args: &[&str], dir: &Path| {
        let (program, full) = runner.command(args).unwrap();
        std::process::Command::new(program)
            .args(full)
            .current_dir(dir)
            .env("HOME", &home)
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_DATA_HOME", &data)
            .status()
            .unwrap()
    };
    let install = |repo: &Path| {
        std::process::Command::new(env!("CARGO_BIN_EXE_shelfkit"))
            .arg("install")
            .current_dir(repo)
            .env("HOME", &home)
            .env("XDG_CACHE_HOME", &cache)
            .env("XDG_DATA_HOME", &data)
            .status()
            .unwrap()
    };

    // ShelfKit's own shelf: vendored instructions and a prompt.
    let own = root.join("own");
    std::fs::create_dir_all(&own).unwrap();
    let shelf = repository_root().join("shelf");
    let compiled = shelfkit(
        &own,
        &NoProcesses,
        &["--shelf", shelf.to_str().unwrap(), "compile"],
    );
    assert_eq!(compiled.code, 0, "{}", compiled.stderr);
    assert!(install(&own).success(), "apm install failed on shelf/");
    assert!(
        own.join("apm.lock.yaml").is_file(),
        "APM wrote no lockfile for shelf/"
    );

    // A registry on loopback, a Git item under its default, an MCP object.
    let port = registry::serve(&[(
        "acme/conventions",
        "1.0.0",
        &[
            ("apm.yml", b"name: conventions\nversion: 1.0.0\n".as_slice()),
            (
                ".apm/instructions/conventions.instructions.md",
                b"---\ndescription: Team conventions\n---\n\nWrite tests first.\n".as_slice(),
            ),
        ],
    )]);
    let mixed = root.join("mixed-shelf");
    for (path, text) in [
        (
            "shelf.json".to_owned(),
            format!(
                r#"{{ "name": "mixed", "defaultProfile": "mixed", "sources": [
                     {{ "id": "local", "kind": "apm-registry", "url": "http://127.0.0.1:{port}" }} ] }}"#
            ),
        ),
        (
            "items/instructions/conventions/item.json".to_owned(),
            r#"{ "id": "conventions", "kind": "instructions", "title": "Conventions",
                 "source": { "id": "local", "path": "acme/conventions", "version": "1.0.0" } }"#
                .to_owned(),
        ),
        (
            "items/skills/frontend-design/item.json".to_owned(),
            r#"{ "id": "frontend-design", "kind": "skill", "title": "Frontend design",
                 "source": { "repo": "https://github.com/anthropics/skills", "path": "skills/frontend-design",
                             "resolvedCommit": "dbd4588f9e1033efb41dad4bef2f7947c8993d44" } }"#
                .to_owned(),
        ),
        (
            "items/mcp/echo/item.json".to_owned(),
            r#"{ "id": "echo", "kind": "mcp", "title": "Echo", "flavour": "stdio", "name": "echo-server",
                 "command": "echo", "args": ["ready"], "env": { "LOG_LEVEL": "info" } }"#
                .to_owned(),
        ),
        (
            "items/prompts/hello/item.json".to_owned(),
            r#"{ "id": "hello", "kind": "prompt", "title": "Hello" }"#.to_owned(),
        ),
        ("items/prompts/hello/prompt.md".to_owned(), "Say hello.\n".to_owned()),
        (
            "profiles/mixed.json".to_owned(),
            r#"{ "id": "mixed", "title": "Mixed", "items": ["conventions", "frontend-design", "echo", "hello"],
                 "compile": { "targets": ["claude"] } }"#
                .to_owned(),
        ),
    ] {
        let file = mixed.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    let repo = root.join("mixed-repo");
    std::fs::create_dir_all(&repo).unwrap();
    let compiled = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", mixed.to_str().unwrap(), "compile"],
    );
    assert_eq!(compiled.code, 0, "{}", compiled.stderr);
    let manifest = std::fs::read_to_string(repo.join("apm.yml")).unwrap();
    assert!(manifest.contains("  default: local\n"), "{manifest}");
    assert!(
        manifest.contains("- git: anthropics/skills/skills/frontend-design\n"),
        "{manifest}"
    );
    assert!(manifest.contains("registry: false"), "{manifest}");

    assert!(apm(&["experimental", "enable", "registries"], &repo).success());
    assert!(install(&repo).success(), "apm install failed:\n{manifest}");
    let lock = std::fs::read_to_string(repo.join("apm.lock.yaml")).expect("APM wrote no lockfile");
    assert!(lock.contains("acme/conventions"), "{lock}");
    assert!(
        lock.contains("dbd4588f9e1033efb41dad4bef2f7947c8993d44"),
        "{lock}"
    );
}

/// A minimal OpenAPM registry on loopback, enough for `apm install`: the
/// versions list and the `tar.gz` download, with the archive's digest.
mod registry {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    type Package<'a> = (&'a str, &'a str, &'a [(&'a str, &'a [u8])]);

    pub fn serve(packages: &[Package<'_>]) -> u16 {
        let routes: Vec<(String, String, Vec<u8>)> = packages
            .iter()
            .flat_map(|(id, version, files)| {
                let archive = tar_gz(files);
                let digest = shelfkit_compiler::manifest::digest(&archive);
                let versions = format!(
                    r#"{{"versions":[{{"version":"{version}","digest":"{digest}","published_at":"2026-10-19T00:00:00Z"}}]}}"#
                );
                [
                    (format!("/v1/packages/{id}/versions"), "application/json".to_owned(), versions.into_bytes()),
                    (format!("/v1/packages/{id}/versions/{version}/download"), "application/gzip".to_owned(), archive),
                ]
            })
            .collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).map_or(true, |n| n == 0) || header == "\r\n" {
                        break;
                    }
                }
                let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
                let found = routes.iter().find(|(route, _, _)| *route == path);
                let (status, kind, body) = match found {
                    Some((_, kind, body)) => ("200 OK", kind.clone(), body.clone()),
                    None => (
                        "404 Not Found",
                        "application/problem+json".to_owned(),
                        br#"{"title":"not found"}"#.to_vec(),
                    ),
                };
                let mut stream = reader.into_inner();
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        port
    }

    /// A `tar.gz` of regular files: ustar headers, and gzip of stored
    /// (uncompressed) deflate blocks, which any reader accepts.
    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, bytes) in files {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[100..108].copy_from_slice(b"0000644\0");
            header[108..116].copy_from_slice(b"0000000\0");
            header[116..124].copy_from_slice(b"0000000\0");
            header[124..136].copy_from_slice(format!("{:011o}\0", bytes.len()).as_bytes());
            header[136..148].copy_from_slice(b"00000000000\0");
            header[148..156].copy_from_slice(b"        ");
            header[156] = b'0';
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            tar.extend_from_slice(&header);
            tar.extend_from_slice(bytes);
            tar.resize(tar.len().div_ceil(512) * 512, 0);
        }
        tar.resize(tar.len() + 1024, 0);

        let mut gz = vec![0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff];
        let chunks: Vec<&[u8]> = tar.chunks(65_535).collect();
        for (index, chunk) in chunks.iter().enumerate() {
            gz.push(u8::from(index + 1 == chunks.len()));
            let len = u16::try_from(chunk.len()).unwrap();
            gz.extend_from_slice(&len.to_le_bytes());
            gz.extend_from_slice(&(!len).to_le_bytes());
            gz.extend_from_slice(chunk);
        }
        gz.extend_from_slice(&crc32(&tar).to_le_bytes());
        gz.extend_from_slice(&u32::try_from(tar.len()).unwrap().to_le_bytes());
        gz
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
}

/// The reviewer's case: a package directory named like the profile's, whose
/// files are symbolic links out of the repository.
#[cfg(unix)]
#[test]
fn compile_never_writes_through_a_symbolic_link() {
    use std::os::unix::fs::symlink;
    let root = scratch("symlinks");
    let repo = root.join("repo");
    let outside = root.join("outside");
    std::fs::create_dir_all(repo.join("vendor/minimal")).unwrap();
    std::fs::create_dir_all(outside.join("dir")).unwrap();
    std::fs::write(outside.join("precious.txt"), "precious\n").unwrap();
    symlink(
        outside.join("precious.txt"),
        repo.join("vendor/minimal/apm.yml"),
    )
    .unwrap();
    symlink(outside.join("dir"), repo.join("vendor/minimal/.apm")).unwrap();
    let shelf = all_kinds();
    let shelf_arg = shelf.to_str().unwrap();

    let ran = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal"],
    );
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(ran.stderr.contains("vendor/minimal"), "{}", ran.stderr);
    assert_eq!(
        std::fs::read_to_string(outside.join("precious.txt")).unwrap(),
        "precious\n"
    );
    assert!(
        std::fs::read_dir(outside.join("dir"))
            .unwrap()
            .next()
            .is_none(),
        "wrote outside the repository"
    );
    assert!(
        repo.join("vendor/minimal/apm.yml")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(
        !repo.join("apm.yml").exists(),
        "a refused compile wrote apm.yml"
    );

    // A package ShelfKit did vendor, with a link planted inside it later.
    let clean = root.join("clean");
    std::fs::create_dir_all(&clean).unwrap();
    assert_eq!(
        shelfkit(
            &clean,
            &NoProcesses,
            &["--shelf", shelf_arg, "compile", "minimal"]
        )
        .code,
        0
    );
    std::fs::remove_dir_all(clean.join("vendor/minimal/.apm")).unwrap();
    symlink(outside.join("dir"), clean.join("vendor/minimal/.apm")).unwrap();
    let ran = shelfkit(
        &clean,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal"],
    );
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr
            .contains("vendor/minimal/.apm is a symbolic link"),
        "{}",
        ran.stderr
    );
    assert!(
        std::fs::read_dir(outside.join("dir"))
            .unwrap()
            .next()
            .is_none(),
        "wrote outside the repository"
    );

    // A linked apm.yml at the root is refused too.
    let linked = root.join("linked");
    std::fs::create_dir_all(&linked).unwrap();
    symlink(outside.join("precious.txt"), linked.join("apm.yml")).unwrap();
    let ran = shelfkit(
        &linked,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal"],
    );
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr.contains("apm.yml is a symbolic link"),
        "{}",
        ran.stderr
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("precious.txt")).unwrap(),
        "precious\n"
    );
}

/// The reviewer's case: Composer's `vendor/` holds a directory named like the
/// profile. ShelfKit never deletes a package it did not mark as its own.
#[test]
fn compile_deletes_only_inside_packages_carrying_its_marker() {
    let repo = scratch("composer");
    std::fs::create_dir_all(repo.join("vendor/minimal/framework/src")).unwrap();
    std::fs::write(repo.join("vendor/minimal/framework/src/App.php"), "<?php\n").unwrap();
    std::fs::create_dir_all(repo.join("vendor/minimal--tools")).unwrap();
    std::fs::write(repo.join("vendor/minimal--tools/tool.php"), "<?php\n").unwrap();
    let shelf = all_kinds();
    let shelf_arg = shelf.to_str().unwrap();

    let ran = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal"],
    );
    assert_eq!(ran.code, 1);
    assert!(
        ran.stderr
            .contains("vendor/minimal exists and is not a package ShelfKit vendored"),
        "{}",
        ran.stderr
    );
    assert!(repo.join("vendor/minimal/framework/src/App.php").is_file());
    let frozen = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal", "--frozen"],
    );
    assert_eq!(frozen.code, 1);

    // Without the clash, the unmarked `minimal--tools` is left alone, and a
    // stale file inside ShelfKit's own package is removed.
    std::fs::remove_dir_all(repo.join("vendor/minimal")).unwrap();
    assert_eq!(
        shelfkit(
            &repo,
            &NoProcesses,
            &["--shelf", shelf_arg, "compile", "minimal"]
        )
        .code,
        0
    );
    std::fs::write(repo.join("vendor/minimal/.apm/stale.md"), "old\n").unwrap();
    let ran = shelfkit(
        &repo,
        &NoProcesses,
        &["--shelf", shelf_arg, "compile", "minimal"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(
        ran.stdout.contains("remove vendor/minimal/.apm/stale.md"),
        "{}",
        ran.stdout
    );
    assert!(repo.join("vendor/minimal--tools/tool.php").is_file());
    assert!(!repo.join("vendor/minimal/.apm/stale.md").exists());
}

#[test]
fn install_on_a_registry_manifest_explains_the_flag_and_never_sets_it() {
    let repo = scratch("install-registry");
    std::fs::write(
        repo.join("apm.yml"),
        "name: x\nversion: 1.0.0\nregistries:\n  a:\n    url: \"http://127.0.0.1:8787\"\n  default: a\n",
    )
    .unwrap();
    let machine = FakeMachine::with(&["uvx"]);
    let ran = shelfkit(&repo, &machine, &["install"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let note = ran
        .stderr
        .find("uvx --from apm-cli==0.33.0 apm experimental enable registries")
        .unwrap();
    let command = ran
        .stderr
        .find("$ uvx --from apm-cli==0.33.0 apm install")
        .unwrap();
    assert!(note < command, "{}", ran.stderr);
    let calls = machine.ran.borrow();
    assert_eq!(
        calls.len(),
        1,
        "install must not change APM's configuration"
    );
    assert_eq!(calls[0].1[3], "install");

    let shelf = repository_root().join("crates/compiler/tests/fixtures/registry");
    let dry = shelfkit(
        &repo,
        &NoProcesses,
        &[
            "--shelf",
            shelf.to_str().unwrap(),
            "compile",
            "--dry-run",
            "team",
        ],
    );
    assert!(
        dry.stderr
            .contains("run `apm experimental enable registries` once"),
        "{}",
        dry.stderr
    );
    assert!(!dry.stderr.contains("&& apm install (or"), "{}", dry.stderr);
}
