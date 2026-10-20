//! Golden files: every profile of every fixture shelf, compiled.
//!
//! Each profile writes `tests/golden/<shelf>/<profile>.apm.yml`, the manifest
//! as a reviewer reads it, and `<profile>.plan.json`, the `CompiledManifest`
//! exactly as `shelfkit compile --dry-run --json` prints it. The schema
//! package parses every plan with `CompilePlanSchema`, and the engine package
//! checks that WASM produces the same bytes. A change to either file is a
//! change to what ShelfKit emits: when it is intended, regenerate with
//! `SHELFKIT_UPDATE_GOLDEN=1 cargo test --package shelfkit-compiler` and
//! review the diff.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::engine::{Request, plan};
use shelfkit_core::{DirSource, load};
use std::path::{Path, PathBuf};

/// The fixture shelves, by golden directory name.
fn shelves() -> Vec<(&'static str, PathBuf)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    vec![
        ("all-kinds", root.join("../core/tests/fixtures/all-kinds")),
        ("edges", root.join("tests/fixtures/edges")),
        ("registry", root.join("tests/fixtures/registry")),
        ("shelfkit", root.join("../../shelf")),
    ]
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
fn every_profile_of_every_fixture_shelf_matches_its_golden_files() {
    for (name, root) in shelves() {
        let source = DirSource::new(&root);
        let shelf =
            load(&source).unwrap_or_else(|errors| panic!("{name} does not load:\n{errors}"));
        assert!(!shelf.profiles.is_empty(), "{name} has no profiles");
        for id in shelf.profiles.keys() {
            let request = Request {
                profile: Some(id.clone()),
                ..Request::default()
            };
            let compiled =
                plan(&source, &request).unwrap_or_else(|errors| panic!("{name}/{id}:\n{errors}"));
            golden(&format!("{name}/{id}.apm.yml"), &compiled.apm_yml);
            golden(&format!("{name}/{id}.plan.json"), &compiled.to_json());
        }
    }
}

#[test]
fn the_schema_package_lists_exactly_the_note_codes_the_compiler_writes() {
    let catalog =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/schema/acidcat.catalog.json");
    let catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(catalog).unwrap()).unwrap();
    let listed: std::collections::BTreeSet<String> = catalog["capabilities"]["shelf.compile.plan"]
        ["output"]["properties"]["notes"]["items"]["properties"]["code"]["enum"]
        .as_array()
        .expect("the catalog lists the compile note codes")
        .iter()
        .map(|code| code.as_str().unwrap().to_owned())
        .collect();
    let written: std::collections::BTreeSet<String> = shelfkit_compiler::NoteCode::ALL
        .iter()
        .map(|code| {
            serde_json::to_value(code)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(listed, written);
}
