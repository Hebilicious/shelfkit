//! `shelfkit serve`, the real binary over a real socket: the registry
//! conformance suite, and the shelf's own profiles round-tripping through it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::engine::{Request, package_profile};
use shelfkit_core::DirSource;
use shelfkit_registry::conformance::{self, Suite};
use shelfkit_registry::digest;
use shelfkit_registry::host::{HttpResponse, Request as HttpRequest};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn conformance_root() -> PathBuf {
    repository_root().join("crates/registry/conformance")
}

/// A running `shelfkit serve`, stopped when dropped.
struct Server {
    child: Child,
    url: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    /// Start the binary on a free loopback port, with keys from the
    /// environment, and wait for the line that names its URL.
    // Runs the shelfkit binary itself, which is the point of the test.
    #[allow(clippy::disallowed_methods)]
    fn start(shelf: &Path, args: &[&str], keys: &str) -> Self {
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_shelfkit"))
            .arg("--shelf")
            .arg(shelf)
            .args(["serve", "--port", "0"])
            .args(args)
            .env("SHELFKIT_SERVE_KEYS", keys)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let first = lines.next().unwrap().unwrap();
        let url = first.strip_prefix("listening on ").unwrap().to_owned();
        // Drain the rest so the server never blocks on a full pipe.
        std::thread::spawn(move || lines.for_each(drop));
        Self { child, url }
    }

    fn send(&self, request: &HttpRequest) -> HttpResponse {
        http(&self.url, request)
    }
}

/// One HTTP/1.1 exchange over a fresh connection.
fn http(url: &str, request: &HttpRequest) -> HttpResponse {
    let address = url.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(address).unwrap();
    let mut head = format!(
        "{} {} HTTP/1.1\r\nHost: {address}\r\n",
        request.method, request.path
    );
    for (name, value) in &request.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        request.body.len()
    ));
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&request.body).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8(raw[..split].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.trim().to_owned(), value.trim().to_owned())
        })
        .collect();
    HttpResponse {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

fn get(path: &str, headers: &[(&str, &str)]) -> HttpRequest {
    HttpRequest {
        method: "GET".to_owned(),
        path: path.to_owned(),
        headers: headers
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect(),
        body: Vec::new(),
    }
}

#[test]
fn shelfkit_serve_passes_the_conformance_suite() {
    let root = conformance_root();
    let suite = Suite::parse(&std::fs::read_to_string(root.join("cases.json")).unwrap()).unwrap();
    let archives: BTreeMap<String, Vec<u8>> = suite
        .archives
        .iter()
        .map(|(name, entry)| (name.clone(), std::fs::read(root.join(&entry.file)).unwrap()))
        .collect();
    let shelf = root.join("shelf");
    let failures = conformance::run(&suite, &archives, |scenario| {
        let keys: Vec<String> = scenario
            .keys
            .iter()
            .map(|key| format!("{}={}", key.scopes.join(","), key.key))
            .collect();
        let visibility = if scenario.public {
            "--public"
        } else {
            "--private"
        };
        let server = Server::start(&shelf, &[visibility], &keys.join(" "));
        move |request| server.send(request)
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The acceptance round trip on ShelfKit's own shelf: `serve` publishes the
/// profile, lists it with the digest `package` computes, and serves bytes
/// that hash to it. A second publish of the version is `409` and changes
/// nothing.
#[test]
fn a_profile_round_trips_through_serve_and_its_version_is_immutable() {
    let shelf = repository_root().join("shelf");
    let packaged = package_profile(&DirSource::new(&shelf), &Request::default()).unwrap();
    let server = Server::start(&shelf, &[], "publish:hebilicious/*=round-trip-key");
    let versions_path = format!("/v1/packages/{}/versions", packaged.package);

    let listed = server.send(&get(&versions_path, &[]));
    assert_eq!(listed.status, 200);
    let body: serde_json::Value = serde_json::from_slice(&listed.body).unwrap();
    assert_eq!(body["package"], packaged.package);
    assert_eq!(body["versions"][0]["version"], packaged.version);
    assert_eq!(body["versions"][0]["digest"], packaged.digest);

    let download = format!(
        "{versions_path}/{}/download",
        shelfkit_registry::identity::encode(&packaged.version)
    );
    let fetched = server.send(&get(&download, &[]));
    assert_eq!(fetched.status, 200);
    assert_eq!(fetched.header("content-type"), Some("application/gzip"));
    assert_eq!(digest(&fetched.body), packaged.digest);
    assert_eq!(fetched.body, packaged.archive);

    let republish = HttpRequest {
        method: "PUT".to_owned(),
        path: format!(
            "{versions_path}/{}",
            shelfkit_registry::identity::encode(&packaged.version)
        ),
        headers: vec![
            (
                "Authorization".to_owned(),
                "Bearer round-trip-key".to_owned(),
            ),
            ("Content-Type".to_owned(), "application/gzip".to_owned()),
        ],
        body: packaged.archive.clone(),
    };
    let conflict = server.send(&republish);
    assert_eq!(conflict.status, 409);
    assert_eq!(
        conflict.header("content-type"),
        Some("application/problem+json; charset=utf-8")
    );
    assert_eq!(server.send(&get(&versions_path, &[])).body, listed.body);
    assert_eq!(server.send(&get(&download, &[])).body, packaged.archive);
}

#[test]
fn a_private_shelf_answers_a_request_without_a_key_with_401_not_403() {
    let shelf = repository_root().join("shelf");
    let server = Server::start(&shelf, &["--private"], "read=reader-key");
    let path = "/v1/packages/hebilicious/default/versions";
    let anonymous = server.send(&get(path, &[]));
    assert_eq!(anonymous.status, 401);
    assert!(anonymous.header("www-authenticate").is_some());
    let reader = server.send(&get(path, &[("Authorization", "Bearer reader-key")]));
    assert_eq!(reader.status, 200);
}

#[test]
fn serve_refuses_a_malformed_key_without_printing_it() {
    // Runs the shelfkit binary itself.
    #[allow(clippy::disallowed_methods)]
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_shelfkit"))
        .arg("--shelf")
        .arg(repository_root().join("shelf"))
        .args(["serve", "--port", "0", "--key", "write=hunter2"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("is not a scope"), "{stderr}");
    assert!(!stderr.contains("hunter2"), "{stderr}");
}

/// M1's exit criterion as a test: APM installs a profile from `shelfkit
/// serve` through its experimental registry client. It runs where an `apm`
/// binary is on PATH, or with `SHELFKIT_TEST_APM_UVX=1` through the pinned
/// `uvx`, and skips otherwise. APM's configuration goes to a scratch `HOME`.
/// It reads only exit codes and `apm.lock.yaml`.
#[test]
// Runs APM itself, which is the point of the test.
#[allow(clippy::disallowed_methods)]
fn apm_installs_a_profile_from_shelfkit_serve_when_apm_is_present() {
    use shelfkit_compiler::cli::HostSystem;
    use shelfkit_compiler::cli::apm::Runner;
    let runner = Runner::resolve(&HostSystem);
    let usable = match &runner {
        Runner::Path { .. } => true,
        Runner::Uvx { .. } => std::env::var_os("SHELFKIT_TEST_APM_UVX").is_some(),
        Runner::Missing => false,
    };
    if !usable {
        eprintln!(
            "skipping: no `apm` binary on PATH, so APM did not install from `shelfkit serve` \
             (set SHELFKIT_TEST_APM_UVX=1 to run the pinned APM through uvx)"
        );
        return;
    }

    let shelf = repository_root().join("shelf");
    let packaged = package_profile(&DirSource::new(&shelf), &Request::default()).unwrap();
    let server = Server::start(&shelf, &[], "");

    let root = std::env::temp_dir().join(format!("shelfkit-serve-apm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let repo = root.join("repo");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(
        repo.join("apm.yml"),
        format!(
            "name: consumer\nversion: \"1.0.0\"\ntargets: [claude]\nregistries:\n  shelfkit:\n    url: {}\n  default: shelfkit\ndependencies:\n  apm:\n    - id: {}\n      version: \"{}\"\n",
            server.url, packaged.package, packaged.version
        ),
    )
    .unwrap();
    let real_home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let cache =
        std::env::var_os("XDG_CACHE_HOME").map_or_else(|| real_home.join(".cache"), PathBuf::from);
    let apm = |args: &[&str]| {
        let (program, full) = runner.command(args).unwrap();
        std::process::Command::new(program)
            .args(full)
            .current_dir(&repo)
            .env("HOME", &home)
            .env("XDG_CACHE_HOME", &cache)
            .status()
            .unwrap()
    };
    assert!(apm(&["experimental", "enable", "registries"]).success());
    assert!(apm(&["install"]).success(), "apm install failed");

    let lock: serde_yaml::Value =
        serde_yaml::from_str(&std::fs::read_to_string(repo.join("apm.lock.yaml")).unwrap())
            .unwrap();
    let entry = lock["dependencies"]
        .as_sequence()
        .unwrap()
        .iter()
        .find(|dependency| dependency["repo_url"].as_str() == Some(packaged.package.as_str()))
        .expect("the lockfile pins the profile");
    assert_eq!(entry["source"].as_str(), Some("registry"));
    assert_eq!(entry["version"].as_str(), Some(packaged.version.as_str()));
    assert_eq!(
        entry["resolved_hash"].as_str(),
        Some(packaged.digest.as_str())
    );
    assert!(
        entry["deployed_files"]
            .as_sequence()
            .is_some_and(|files| !files.is_empty()),
        "{entry:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
