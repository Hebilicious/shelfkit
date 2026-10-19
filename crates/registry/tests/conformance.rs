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
        let mut registry = Registry { store, keys };
        move |request| registry.handle(request, "2026-10-19T12:00:00Z")
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
