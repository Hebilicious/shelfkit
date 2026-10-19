//! The conformance suite in `conformance/cases.json`, run against the
//! library itself, and the check that its archive files are the generated
//! ones. `shelfkit serve` runs the same suite in crates/compiler/tests/serve.rs.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_registry::conformance::{self, Suite};
use shelfkit_registry::host::{MemoryKeys, MemoryStore, Registry};
use shelfkit_registry::{Scope, digest};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("conformance")
}

fn file_name(name: &str) -> String {
    if name.ends_with("-zip") {
        format!("archives/{name}.zip")
    } else {
        format!("archives/{name}.tar.gz")
    }
}

/// The committed archives and digests are what `conformance::archives()`
/// generates. `SHELFKIT_UPDATE_CONFORMANCE=1` rewrites them.
#[test]
fn the_committed_archives_are_the_generated_ones() {
    let generated = conformance::archives().unwrap();
    let cases_path = root().join("cases.json");
    let text = std::fs::read_to_string(&cases_path).unwrap();
    if std::env::var_os("SHELFKIT_UPDATE_CONFORMANCE").is_some() {
        let mut cases: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut archives = serde_json::Map::new();
        for (name, bytes) in &generated {
            let file = file_name(name);
            std::fs::write(root().join(&file), bytes).unwrap();
            archives.insert(
                name.clone(),
                serde_json::json!({ "file": file, "digest": digest(bytes) }),
            );
        }
        cases["archives"] = serde_json::Value::Object(archives);
        let mut out = serde_json::to_string_pretty(&cases).unwrap();
        out.push('\n');
        std::fs::write(&cases_path, out).unwrap();
        return;
    }
    let suite = Suite::parse(&text).unwrap();
    let names: Vec<&String> = suite.archives.keys().collect();
    assert_eq!(names, generated.keys().collect::<Vec<_>>());
    for (name, bytes) in &generated {
        let entry = &suite.archives[name];
        assert_eq!(entry.file, file_name(name));
        assert_eq!(
            entry.digest,
            digest(bytes),
            "{name}: the digest in cases.json"
        );
        let committed = std::fs::read(root().join(&entry.file)).unwrap();
        assert!(
            committed == *bytes,
            "{name}: the committed file differs from the generated archive; \
             rerun with SHELFKIT_UPDATE_CONFORMANCE=1 and review the diff"
        );
    }
}

/// Load the suite and its archives, as any runner does.
pub fn load() -> (Suite, BTreeMap<String, Vec<u8>>) {
    let suite = Suite::parse(&std::fs::read_to_string(root().join("cases.json")).unwrap()).unwrap();
    let archives = suite
        .archives
        .iter()
        .map(|(name, entry)| {
            let bytes = std::fs::read(root().join(&entry.file)).unwrap();
            assert_eq!(digest(&bytes), entry.digest, "{name}");
            (name.clone(), bytes)
        })
        .collect();
    (suite, archives)
}

#[test]
fn the_library_passes_the_conformance_suite() {
    let (suite, archives) = load();
    let failures = conformance::run(&suite, &archives, |scenario| {
        let mut store = MemoryStore::new();
        store.add_shelf(&suite.owner, scenario.public);
        let mut keys = MemoryKeys::new();
        for key in &scenario.keys {
            let scopes = key
                .scopes
                .iter()
                .map(|s| Scope::parse(s).unwrap())
                .collect();
            keys.add(&key.key, scopes);
        }
        let mut registry = Registry::new(store, keys);
        move |request| registry.handle(request, "2026-10-19T12:00:00Z")
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The same suite with the registry mounted at `/apm`, as PRD 7.1 mounts
/// it in the Worker: requests carry the mount, and so does every URL a
/// response builds.
#[test]
fn the_library_passes_the_conformance_suite_under_a_mount() {
    let (suite, archives) = load();
    let failures = conformance::run(&suite, &archives, |scenario| {
        let mut store = MemoryStore::new();
        store.add_shelf(&suite.owner, scenario.public);
        let mut keys = MemoryKeys::new();
        for key in &scenario.keys {
            let scopes = key
                .scopes
                .iter()
                .map(|s| Scope::parse(s).unwrap())
                .collect();
            keys.add(&key.key, scopes);
        }
        let mut registry = Registry::new(store, keys);
        registry.mount = "/apm".to_owned();
        move |request: &shelfkit_registry::host::Request| {
            let mut mounted = request.clone();
            mounted.path = format!("/apm{}", request.path);
            registry.handle(&mounted, "2026-10-19T12:00:00Z")
        }
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn urls_in_responses_carry_the_mount() {
    let (_, archives) = load();
    let mut store = MemoryStore::new();
    store.add_shelf("acme", true);
    let mut registry = Registry::new(store, MemoryKeys::new());
    registry.mount = "/apm".to_owned();
    let package = shelfkit_registry::PackageId::parse("acme/web").unwrap();
    let created = registry.publish(&package, "1.0.0", archives["web-1.0.0"].clone(), "now");
    assert_eq!(created.status, 201);
    assert_eq!(
        created.header("location"),
        Some("/apm/v1/packages/acme/web/versions/1.0.0/download")
    );
    let get = |path: &str| shelfkit_registry::host::Request {
        method: "GET".to_owned(),
        path: path.to_owned(),
        ..shelfkit_registry::host::Request::default()
    };
    assert_eq!(
        registry
            .handle(&get("/apm/v1/packages/acme/web/versions"), "now")
            .status,
        200
    );
    let outside = registry.handle(&get("/v1/packages/acme/web/versions"), "now");
    assert_eq!(outside.status, 404);
    let missing = registry.handle(
        &get("/apm/v1/packages/acme/web/versions/9.9.9/download"),
        "now",
    );
    let body: serde_json::Value = serde_json::from_slice(&missing.body).unwrap();
    assert_eq!(
        body["instance"],
        "/apm/v1/packages/acme/web/versions/9.9.9/download"
    );
}
