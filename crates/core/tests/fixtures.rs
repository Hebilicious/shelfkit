//! Loading the fixture shelves, and the properties a revision must keep.
//!
//! Golden files live in `tests/golden/`. When a change to the format is
//! intended, regenerate them with `SHELFKIT_UPDATE_GOLDEN=1 cargo test
//! --package shelfkit-core` and review the diff: it is the change.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde::Serialize;
use shelfkit_core::{
    DirSource, ErrorKind, Errors, FileSource, Item, ItemKind, MemorySource, Origin, Revision,
    Shelf, load,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn load_fixture(name: &str) -> Result<Shelf, Errors> {
    load(&DirSource::new(fixture(name)))
}

fn memory(name: &str) -> MemorySource {
    MemorySource::snapshot(
        &DirSource::new(fixture(name)),
        &["items", "bundles", "profiles"],
    )
    .map(|mut source| {
        let manifest = std::fs::read(fixture(name).join("shelf.json")).unwrap();
        source.insert("shelf.json", manifest);
        source
    })
    .unwrap()
}

fn golden(name: &str, actual: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    if std::env::var_os("SHELFKIT_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!("missing {name}: run with SHELFKIT_UPDATE_GOLDEN=1 to create it")
    });
    assert_eq!(
        expected, actual,
        "{name} changed; if intended, regenerate with SHELFKIT_UPDATE_GOLDEN=1"
    );
}

/// Every revision a shelf produces: items, then resolved profiles.
fn revisions(shelf: &Shelf) -> BTreeMap<String, Revision> {
    let items = shelf
        .items
        .iter()
        .map(|(id, loaded)| (format!("item {id}"), loaded.revision.clone()));
    let profiles = shelf.profiles.keys().map(|id| {
        let resolved = shelf.resolve(id).unwrap();
        (format!("profile {id}"), resolved.revision)
    });
    items.chain(profiles).collect()
}

#[derive(Serialize)]
struct Summary {
    items: BTreeMap<String, ItemSummary>,
    profiles: BTreeMap<String, shelfkit_core::ResolvedProfile>,
    check: Vec<shelfkit_core::Notice>,
}

#[derive(Serialize)]
struct ItemSummary {
    kind: ItemKind,
    path: String,
    files: Vec<String>,
    revision: Revision,
}

#[test]
fn all_kinds_matches_golden() {
    let shelf = load_fixture("all-kinds").unwrap_or_else(|errors| panic!("{errors}"));
    let summary = Summary {
        items: shelf
            .items
            .iter()
            .map(|(id, loaded)| {
                let summary = ItemSummary {
                    kind: loaded.kind(),
                    path: loaded.path.clone(),
                    files: loaded.files.keys().cloned().collect(),
                    revision: loaded.revision.clone(),
                };
                (id.clone(), summary)
            })
            .collect(),
        profiles: shelf
            .profiles
            .keys()
            .map(|id| (id.clone(), shelf.resolve(id).unwrap()))
            .collect(),
        check: shelf.check(),
    };
    let mut text = serde_json::to_string_pretty(&summary).unwrap();
    text.push('\n');
    golden("all-kinds.json", &text);
}

#[test]
fn all_kinds_exercises_every_kind() {
    let shelf = load_fixture("all-kinds").unwrap();
    let kinds: BTreeSet<ItemKind> = shelf.items.values().map(|loaded| loaded.kind()).collect();
    assert_eq!(kinds, ItemKind::ALL.into_iter().collect());
}

#[test]
fn errors_match_golden() {
    let errors = load_fixture("errors").unwrap_err();
    golden("errors.txt", &format!("{errors}\n"));
}

#[test]
fn every_error_names_a_file_in_the_shelf() {
    let root = fixture("errors");
    for error in load_fixture("errors").unwrap_err() {
        let path = root.join(&error.path);
        assert!(
            path.exists(),
            "`{}` does not name a file or directory: {error}",
            error.path
        );
    }
}

#[test]
fn unresolvable_requires_fails_with_the_item_path() {
    let errors = load_fixture("errors").unwrap_err();
    let error = errors
        .iter()
        .find(|error| {
            matches!(&error.kind, ErrorKind::UnknownReference { field, target, .. }
                if field == "requires" && target == "ghost")
        })
        .expect("an unknown `requires` is an error");
    assert_eq!(error.path, "items/prompts/needs-ghost/item.json");
    assert!(
        error
            .to_string()
            .starts_with("items/prompts/needs-ghost/item.json: ")
    );
}

#[test]
fn extends_cycle_fails_with_the_profile_path() {
    let errors = load_fixture("errors").unwrap_err();
    let cycles: Vec<String> = errors
        .iter()
        .filter(|error| matches!(error.kind, ErrorKind::ExtendsCycle(_)))
        .map(ToString::to_string)
        .collect();
    assert_eq!(
        cycles,
        vec![
            "profiles/a.json: `extends` cycle: a -> b -> a",
            "profiles/self.json: `extends` cycle: self -> self",
        ]
    );
}

#[test]
fn crlf_checkout_has_the_same_revisions_as_lf() {
    let lf = memory("all-kinds");
    let crlf: MemorySource = lf
        .files()
        .iter()
        .map(|(path, bytes)| {
            let text = String::from_utf8(bytes.clone()).unwrap();
            (path.clone(), text.replace('\n', "\r\n"))
        })
        .collect();
    assert_ne!(lf, crlf, "the CRLF copy must differ on disk");

    let lf = load(&lf).unwrap();
    let crlf = load(&crlf).unwrap_or_else(|errors| panic!("{errors}"));
    assert_eq!(revisions(&lf), revisions(&crlf));
}

/// A source that lists files in reverse order, as another filesystem might.
struct Reversed(MemorySource);

impl FileSource for Reversed {
    fn list(&self, dir: &str) -> shelfkit_core::Result<Vec<String>> {
        let mut paths = self.0.list(dir)?;
        paths.reverse();
        Ok(paths)
    }

    fn read(&self, path: &str) -> shelfkit_core::Result<Vec<u8>> {
        self.0.read(path)
    }
}

#[test]
fn file_order_on_disk_does_not_change_any_revision() {
    let source = memory("all-kinds");
    let forward = load(&source).unwrap();
    let reversed = load(&Reversed(source)).unwrap();
    assert_eq!(revisions(&forward), revisions(&reversed));
}

#[test]
fn reordering_a_profile_does_not_change_any_revision() {
    let mut source = memory("all-kinds");
    let before = revisions(&load(&source).unwrap());

    let path = "profiles/full.json";
    let mut profile: serde_json::Value =
        serde_json::from_slice(&source.read(path).unwrap()).unwrap();
    for field in ["items", "bundles"] {
        profile[field].as_array_mut().unwrap().reverse();
    }
    profile["compile"]["targets"]
        .as_array_mut()
        .unwrap()
        .reverse();
    source.insert(path, serde_json::to_vec_pretty(&profile).unwrap());

    let after = revisions(&load(&source).unwrap());
    assert_eq!(before, after);
}

#[test]
fn changing_content_changes_the_item_and_profile_revisions() {
    let mut source = memory("all-kinds");
    let before = revisions(&load(&source).unwrap());
    source.insert(
        "items/prompts/pr-description/prompt.md",
        "A different prompt.\n",
    );
    let after = revisions(&load(&source).unwrap());

    let changed: Vec<&String> = before
        .keys()
        .filter(|key| before[*key] != after[*key])
        .collect();
    // `minimal` lists the prompt; `full` lists it; `base` does not.
    assert_eq!(
        changed,
        vec!["item pr-description", "profile full", "profile minimal"]
    );
}

#[test]
fn dir_and_memory_sources_agree() {
    let from_disk = load_fixture("all-kinds").unwrap();
    let from_memory = load(&memory("all-kinds")).unwrap();
    assert_eq!(revisions(&from_disk), revisions(&from_memory));
}

#[test]
fn extends_is_breadth_first_and_children_win() {
    let shelf = load_fixture("all-kinds").unwrap();
    let full = shelf.resolve("full").unwrap();

    // `full` sets its own name and targets; `pin` comes from `base`.
    assert_eq!(full.compile.name, "full-stack");
    assert_eq!(
        full.compile.targets,
        ["claude", "codex", "copilot", "cursor", "kiro"]
    );

    let origin = |id: &str| {
        full.items
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.origin.clone())
            .unwrap()
    };
    assert_eq!(
        origin("drizzle"),
        Origin::Profile {
            profile: "base".into()
        }
    );
    assert_eq!(
        origin("review-checklist"),
        Origin::Bundle {
            profile: "full".into(),
            bundle: "code-quality".into()
        }
    );
    // Listed by `full` itself, so the requirement does not claim it.
    assert_eq!(
        origin("pr-description"),
        Origin::Profile {
            profile: "full".into()
        }
    );

    let drizzle = full.items.iter().find(|item| item.id == "drizzle").unwrap();
    assert!(drizzle.pinned);
    assert_ne!(drizzle.revision, drizzle.current);
}

#[test]
fn requires_pulls_items_in() {
    let mut source = memory("all-kinds");
    source.insert(
        "profiles/review.json",
        r#"{ "id": "review", "title": "Review", "items": ["review-checklist"] }"#,
    );
    let shelf = load(&source).unwrap();
    let review = shelf.resolve("review").unwrap();
    let ids: Vec<&str> = review.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(ids, ["pr-description", "review-checklist"]);
    assert_eq!(
        review.items[0].origin,
        Origin::Requires {
            item: "review-checklist".into()
        }
    );
}

#[test]
fn provenance_round_trips_through_load_and_save() {
    let shelf = load_fixture("all-kinds").unwrap();
    for id in ["frontend-design", "context7"] {
        let loaded = &shelf.items[id];
        let source = loaded.item.source.as_ref().unwrap();
        assert!(source.license_id.is_some() && source.credit_text.is_some());

        let saved = loaded.item.to_json();
        let reloaded = Item::from_json(saved.as_bytes()).unwrap();
        assert_eq!(reloaded, loaded.item);

        // Saving loses nothing that was on disk, provenance included.
        let on_disk: serde_json::Value =
            serde_json::from_slice(&loaded.files["item.json"]).unwrap();
        let written: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(on_disk, written, "{id}");
    }
}

#[test]
fn shelfkits_own_shelf_loads() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shelf");
    let shelf = load(&DirSource::new(root)).unwrap_or_else(|errors| panic!("{errors}"));
    let default = shelf.manifest.default_profile.clone().unwrap();
    let resolved = shelf.resolve(&default).unwrap();
    assert!(!resolved.items.is_empty());
    assert!(shelf.check().is_empty(), "{:?}", shelf.check());
}

#[test]
fn a_missing_shelf_reports_shelf_json() {
    let errors = load(&MemorySource::new()).unwrap_err();
    assert_eq!(errors.to_string(), "shelf.json: missing `shelf.json`");
}
