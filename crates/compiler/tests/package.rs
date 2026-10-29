//! A profile packaged for a registry: its layout, its version, and its bytes.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::engine::{Request, package_profile, plan};
use shelfkit_compiler::yaml::Node;
use shelfkit_core::{DirSource, MemorySource};
use shelfkit_registry::archive;
use shelfkit_registry::host::{MemoryKeys, MemoryStore, Registry};
use shelfkit_registry::{PackageId, digest};
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

const SHELF: &str = r#"{ "name": "t", "defaultProfile": "p", "registry": { "namespace": "acme", "public": true } }"#;
const PROMPT: &str = r#"{ "id": "hello", "kind": "prompt", "title": "Hello" }"#;

fn shelf(profile: &str, prompt_body: &str) -> MemorySource {
    [
        ("shelf.json", SHELF),
        ("items/prompts/hello/item.json", PROMPT),
        ("items/prompts/hello/prompt.md", prompt_body),
        ("profiles/p.json", profile),
    ]
    .into_iter()
    .collect()
}

const PROFILE: &str = r#"{ "id": "p", "title": "P", "version": "0.1.0", "items": ["hello"], "compile": { "targets": ["claude"] } }"#;

#[test]
fn the_archive_is_the_package_manifest_and_the_profiles_own_primitives() {
    let source = shelf(PROFILE, "Say hello.\n");
    let packaged = package_profile(&source, &Request::default()).unwrap();
    let compiled = plan(&source, &Request::default()).unwrap();

    assert_eq!(packaged.package, "acme/p");
    assert_eq!(packaged.version, "0.1.0");
    let files = archive::read(&packaged.archive).unwrap();
    let paths: Vec<&str> = files.keys().map(String::as_str).collect();
    assert_eq!(paths, [".apm/prompts/hello.prompt.md", "apm.yml"]);
    assert_eq!(packaged.files, paths);

    // The primitives are exactly what `compile` vendors into vendor/p/.
    let vendored = compiled
        .files
        .iter()
        .find(|file| file.path == "vendor/p/.apm/prompts/hello.prompt.md")
        .unwrap();
    assert_eq!(
        files[".apm/prompts/hello.prompt.md"],
        vendored.bytes().unwrap()
    );

    // The manifest names the repo and the version, and has no targets and no local path.
    let manifest = Node::parse(std::str::from_utf8(&files["apm.yml"]).unwrap()).unwrap();
    assert_eq!(manifest.get("name"), Some(&Node::string("p")));
    assert_eq!(
        manifest.get("version"),
        Some(&Node::string(&packaged.version))
    );
    assert!(manifest.get("targets").is_none());
    assert!(
        !std::str::from_utf8(&files["apm.yml"])
            .unwrap()
            .contains("vendor")
    );

    assert_eq!(packaged.digest, digest(&packaged.archive));
    assert_eq!(packaged.size_bytes, packaged.archive.len() as u64);
}

#[test]
fn the_same_profile_packages_to_the_same_bytes_whatever_the_line_endings() {
    let lf = package_profile(&shelf(PROFILE, "Say hello.\nTwice.\n"), &Request::default()).unwrap();
    let again =
        package_profile(&shelf(PROFILE, "Say hello.\nTwice.\n"), &Request::default()).unwrap();
    let crlf = package_profile(
        &shelf(PROFILE, "Say hello.\r\nTwice.\r\n"),
        &Request::default(),
    )
    .unwrap();
    assert_eq!(lf.archive, again.archive);
    assert_eq!(lf.archive, crlf.archive);
    assert_eq!(lf.version, crlf.version);
}

#[test]
fn a_changed_profile_keeps_its_version_until_it_is_bumped() {
    let first = package_profile(&shelf(PROFILE, "Say hello.\n"), &Request::default()).unwrap();
    let second = package_profile(&shelf(PROFILE, "Say goodbye.\n"), &Request::default()).unwrap();
    // The version is the profile's own, whatever its content: the bytes change and the version does not, which
    // is why the registry refuses the second publish until the profile's `version` moves.
    assert_eq!(first.version, second.version);
    assert_ne!(first.profile_revision, second.profile_revision);
    assert_ne!(first.digest, second.digest);
}

#[test]
fn a_profile_version_is_published_verbatim_and_must_be_semver() {
    let versioned = r#"{ "id": "p", "title": "P", "version": "1.2.0", "items": ["hello"] }"#;
    let packaged = package_profile(&shelf(versioned, "Hi.\n"), &Request::default()).unwrap();
    assert_eq!(packaged.version, "1.2.0");
    let files = archive::read(&packaged.archive).unwrap();
    assert!(
        std::str::from_utf8(&files["apm.yml"])
            .unwrap()
            .contains("version: \"1.2.0\"\n")
    );

    let invalid = r#"{ "id": "p", "title": "P", "version": "1.2", "items": ["hello"] }"#;
    let errors = package_profile(&shelf(invalid, "Hi.\n"), &Request::default()).unwrap_err();
    let error = errors.iter().next().unwrap();
    assert_eq!(error.path, "profiles/p.json");
    assert!(
        error.to_string().contains("not a semantic version"),
        "{error}"
    );

    let unversioned = r#"{ "id": "p", "title": "P", "items": ["hello"] }"#;
    let errors = package_profile(&shelf(unversioned, "Hi.\n"), &Request::default()).unwrap_err();
    let error = errors.iter().next().unwrap();
    assert_eq!(error.path, "profiles/p.json");
    assert!(
        error.to_string().contains("a profile needs a `version`"),
        "{error}"
    );
}

#[test]
fn a_shelf_without_a_registry_namespace_cannot_publish() {
    let mut source = shelf(PROFILE, "Hi.\n");
    source.insert("shelf.json", r#"{ "name": "t", "defaultProfile": "p" }"#);
    let errors = package_profile(&source, &Request::default()).unwrap_err();
    let error = errors.iter().next().unwrap();
    assert_eq!(error.path, "shelf.json");
    assert!(error.to_string().contains("registry.namespace"), "{error}");
}

#[test]
fn an_item_that_needs_a_package_of_its_own_stops_the_publish_and_is_named() {
    let all_kinds = repository_root().join("crates/core/tests/fixtures/all-kinds");
    let request = Request {
        profile: Some("full".to_owned()),
        ..Request::default()
    };
    let errors = package_profile(&DirSource::new(&all_kinds), &request).unwrap_err();
    let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
    assert!(
        messages.iter().any(|m| m.contains("is a plugin")),
        "{messages:#?}"
    );
    assert!(
        errors
            .iter()
            .all(|error| error.path == "profiles/full.json"),
        "{messages:#?}"
    );
    // The same profile still compiles into a repository.
    assert!(plan(&DirSource::new(&all_kinds), &request).is_ok());
}

#[test]
fn a_packaged_profile_passes_the_registrys_publish_validation() {
    let packaged = package_profile(
        &DirSource::new(repository_root().join("shelf")),
        &Request::default(),
    )
    .unwrap();
    let mut store = MemoryStore::new();
    store.add_shelf(&packaged.owner, packaged.public);
    let mut registry = Registry::new(store, MemoryKeys::new());
    let package = PackageId::parse(&packaged.package).unwrap();
    let now = "2026-10-19T12:00:00Z";
    let created = registry.publish(&package, &packaged.version, packaged.archive.clone(), now);
    assert_eq!(
        created.status,
        201,
        "{}",
        String::from_utf8_lossy(&created.body)
    );
    let body: serde_json::Value = serde_json::from_slice(&created.body).unwrap();
    assert_eq!(body["digest"], packaged.digest);
    // Publishing it again is refused, and nothing changes.
    let again = registry.publish(&package, &packaged.version, packaged.archive.clone(), now);
    assert_eq!(again.status, 409);
}
