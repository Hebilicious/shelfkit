//! Loading the fixture shelves, and the properties a revision must keep.
//!
//! Golden files live in `tests/golden/`. When a change to the format is
//! intended, regenerate them with `SHELFKIT_UPDATE_GOLDEN=1 cargo test
//! --package shelfkit-core` and review the diff: it is the change.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde::Serialize;
use shelfkit_core::{
    DirSource, ErrorKind, Errors, FileSource, Item, ItemKind, Listing, MemorySource, Origin,
    Revision, Shelf, load,
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
    /// Each profile as the Rust model serializes it, which is what
    /// `shelf.profile.get` passes through; the schema package parses these.
    declared: BTreeMap<String, shelfkit_core::Profile>,
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
        declared: shelf.profiles.clone(),
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
    fn list(&self, dir: &str) -> Listing {
        let mut listing = self.0.list(dir);
        listing.paths.reverse();
        listing
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
    assert_eq!(drizzle.revision, drizzle.current);
}

#[test]
fn requires_pulls_items_in() {
    let mut source = memory("all-kinds");
    source.insert(
        "profiles/review.json",
        r#"{ "id": "review", "title": "Review", "version": "0.1.0", "items": ["review-checklist"] }"#,
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

fn errors_of(source: &MemorySource) -> Vec<String> {
    load(source)
        .map(|_| Vec::new())
        .unwrap_or_else(|errors| errors.iter().map(ToString::to_string).collect())
}

#[test]
fn a_profile_without_a_version_fails_the_load_at_its_file() {
    let mut source = memory("all-kinds");
    let path = "profiles/minimal.json";
    let mut minimal: serde_json::Value =
        serde_json::from_slice(&source.read(path).unwrap()).unwrap();
    minimal.as_object_mut().unwrap().remove("version");
    source.insert(path, serde_json::to_vec_pretty(&minimal).unwrap());
    // An empty version is no version, and the profile's other errors are still reported.
    source.insert(
        "profiles/blank.json",
        r#"{ "id": "blank", "title": "Blank", "version": "", "items": ["ghost"] }"#,
    );
    let missing = "a profile needs a `version`, a semantic version such as `0.1.0`: \
                   it is the version the profile publishes as";
    assert_eq!(
        errors_of(&source),
        [
            "profiles/blank.json: `items` references unknown item `ghost`".to_owned(),
            format!("profiles/blank.json: {missing}"),
            format!("profiles/minimal.json: {missing}"),
        ]
    );
}

#[test]
fn editing_a_pinned_item_fails_the_load_at_the_pinning_profile() {
    let mut source = memory("all-kinds");
    let path = "items/libraries/drizzle/item.json";
    let mut drizzle: serde_json::Value =
        serde_json::from_slice(&source.read(path).unwrap()).unwrap();
    drizzle["notes"] = serde_json::json!(["A changed note."]);
    source.insert(path, serde_json::to_vec_pretty(&drizzle).unwrap());

    let errors = load(&source).unwrap_err();
    let mismatches: Vec<_> = errors
        .iter()
        .filter(|error| matches!(error.kind, ErrorKind::RevisionMismatch { .. }))
        .collect();
    assert_eq!(mismatches.len(), 1, "{errors}");
    assert_eq!(mismatches[0].path, "profiles/base.json");
    let message = mismatches[0].to_string();
    assert!(message.contains("update the pin"), "{message}");

    // Updating the pin to the revision the error names makes the shelf load,
    // and the profile revision moves with the content it compiles.
    let ErrorKind::RevisionMismatch { actual, .. } = &mismatches[0].kind else {
        unreachable!()
    };
    let profile = String::from_utf8(source.read("profiles/base.json").unwrap()).unwrap();
    let before = load(&memory("all-kinds"))
        .unwrap()
        .resolve("base")
        .unwrap()
        .revision;
    let pinned = with_drizzle_pin(&profile, actual);
    source.insert("profiles/base.json", pinned);
    let after = load(&source).unwrap().resolve("base").unwrap().revision;
    assert_ne!(before, after);
}

/// Replace drizzle's pin in a profile file with `revision`.
fn with_drizzle_pin(profile: &str, revision: &str) -> String {
    let start = profile.find("drizzle@").unwrap() + "drizzle@".len();
    let end = start + "sha256-".len() + 64;
    format!("{}{revision}{}", &profile[..start], &profile[end..])
}

#[test]
fn a_cli_only_target_is_checked_against_the_resolved_opt_in() {
    // A: the parent opts in, the child turns the opt-in off and inherits kiro.
    let mut a = memory("all-kinds");
    a.insert(
        "profiles/parent.json",
        r#"{ "id": "parent", "title": "P", "version": "0.1.0", "compile": { "targets": ["kiro"], "allowNonconformantTargets": true } }"#,
    );
    a.insert(
        "profiles/child.json",
        r#"{ "id": "child", "title": "C", "version": "0.1.0", "extends": ["parent"], "compile": { "allowNonconformantTargets": false } }"#,
    );
    assert_eq!(
        errors_of(&a),
        [
            "profiles/child.json: target `kiro`: is outside the OpenAPM v0.1 producer set; \
          set `compile.allowNonconformantTargets` here or in a profile it extends to opt in"
        ]
    );

    // B: the parent opts in, the child names kiro itself.
    let mut b = memory("all-kinds");
    b.insert(
        "profiles/parent.json",
        r#"{ "id": "parent", "title": "P", "version": "0.1.0", "compile": { "allowNonconformantTargets": true } }"#,
    );
    b.insert(
        "profiles/child.json",
        r#"{ "id": "child", "title": "C", "version": "0.1.0", "extends": ["parent"], "compile": { "targets": ["kiro"] } }"#,
    );
    let shelf = load(&b).unwrap_or_else(|errors| panic!("{errors}"));
    assert!(
        shelf
            .check()
            .iter()
            .any(|notice| notice.path == "profiles/child.json"
                && notice.code == shelfkit_core::NoticeCode::ProducerNonconformantTarget)
    );
}

#[test]
fn a_cli_only_target_on_an_item_needs_the_opt_in_and_is_reported() {
    let mut source = memory("all-kinds");
    let path = "items/prompts/pr-description/item.json";
    let mut item: serde_json::Value = serde_json::from_slice(&source.read(path).unwrap()).unwrap();
    item["targets"] = serde_json::json!(["claude", "kiro"]);
    source.insert(path, serde_json::to_vec_pretty(&item).unwrap());
    assert_eq!(
        errors_of(&source),
        [format!(
            "{path}: target `kiro`: is outside the OpenAPM v0.1 producer set; \
             set `allowNonconformantTargets` to opt in"
        )]
    );

    item["allowNonconformantTargets"] = serde_json::json!(true);
    source.insert(path, serde_json::to_vec_pretty(&item).unwrap());
    let shelf = load(&source).unwrap();
    assert!(shelf.check().iter().any(|notice| notice.path == path));
}

#[test]
fn a_skill_off_the_agentskills_spec_loads_and_is_reported() {
    let mut source = memory("all-kinds");
    let path = "items/skills/review-checklist/SKILL.md";
    let description = "word ".repeat(210);
    source.insert(
        path,
        format!(
            "---\nname: review-checklist\ndescription: >-\n  {description}\n\
             disable-model-invocation: true\n\
             metadata:\n  credits:\n    skill: review\n    author: someone\n---\n\nBody.\n"
        ),
    );
    let shelf = load(&source).unwrap_or_else(|errors| panic!("{errors}"));

    // The file is kept exactly as written.
    assert_eq!(
        shelf.items["review-checklist"].files["SKILL.md"],
        source.read(path).unwrap()
    );

    let reported = |notices: &[shelfkit_core::Notice]| -> Vec<String> {
        notices
            .iter()
            .filter(|notice| {
                notice.path == path && notice.code == shelfkit_core::NoticeCode::SkillFrontmatter
            })
            .map(|notice| notice.message.clone())
            .collect()
    };
    // Notices are sorted, so they come in message order.
    let checked = reported(&shelf.check());
    assert_eq!(checked.len(), 3, "{checked:?}");
    // Each says what the deviation costs, agent by agent.
    assert!(
        checked[0].starts_with("`description` is 1050 characters")
            && checked[0].contains("Copilot CLI refuses to load the skill"),
        "{checked:?}"
    );
    assert!(
        checked[1].starts_with("`disable-model-invocation` is not an agentskills.io key")
            && checked[1].contains("Codex ignores it"),
        "{checked:?}"
    );
    assert!(
        checked[2].starts_with("`metadata` must map strings to strings")
            && checked[2].contains("flattening it to string values loses nothing"),
        "{checked:?}"
    );

    // A profile that installs the skill carries the same notices into its plan,
    // and one that does not carries none.
    assert_eq!(reported(&shelf.resolve("full").unwrap().notices), checked);
    assert!(reported(&shelf.resolve("minimal").unwrap().notices).is_empty());

    // Codex reads `disable-model-invocation` from agents/openai.yaml, which the installed skill gets.
    let settings = shelfkit_core::skill::codex_settings(&shelf.items["review-checklist"]).unwrap();
    let settings: serde_yaml::Value = serde_yaml::from_slice(&settings).unwrap();
    assert_eq!(
        settings["policy"]["allow_implicit_invocation"],
        serde_yaml::Value::Bool(false)
    );
}

#[test]
fn a_skills_own_codex_settings_are_kept_and_a_disagreement_reported() {
    let mut source = memory("all-kinds");
    source.insert(
        "items/skills/review-checklist/SKILL.md",
        "---\nname: review-checklist\ndescription: Review.\ndisable-model-invocation: true\n---\n\nBody.\n",
    );
    let settings = "items/skills/review-checklist/agents/openai.yaml";
    source.insert(settings, "interface:\n  display_name: \"Review\"\n");
    let shelf = load(&source).unwrap_or_else(|errors| panic!("{errors}"));
    assert_eq!(
        shelfkit_core::skill::codex_settings(&shelf.items["review-checklist"]),
        None,
        "the skill's own file is never replaced"
    );
    let reported: Vec<String> = shelf
        .check()
        .iter()
        .filter(|notice| notice.path == settings)
        .map(|notice| notice.message.clone())
        .collect();
    assert_eq!(reported.len(), 1, "{reported:?}");
    assert!(
        reported[0].contains("Codex still uses the skill on its own"),
        "{reported:?}"
    );

    source.insert(settings, "policy:\n  allow_implicit_invocation: false\n");
    let agreeing = load(&source).unwrap_or_else(|errors| panic!("{errors}"));
    assert!(
        agreeing
            .check()
            .iter()
            .all(|notice| notice.path != settings)
    );
}

#[test]
fn a_skill_an_agent_cannot_use_still_fails_the_load() {
    let path = "items/skills/review-checklist/SKILL.md";
    let fails = |text: &str| {
        let mut source = memory("all-kinds");
        source.insert(path, text);
        errors_of(&source)
    };
    let invalid = |reason: &str| vec![format!("{path}: invalid SKILL.md frontmatter: {reason}")];
    assert_eq!(
        fails("No frontmatter.\n"),
        invalid("must start with a `---` YAML block")
    );
    assert_eq!(fails("---\n- a\n---\n"), invalid("must be a YAML mapping"));
    assert_eq!(
        fails("---\ndescription: A thing.\n---\n"),
        invalid("`name` is required and must be a string")
    );
    assert_eq!(
        fails("---\nname: other\ndescription: A thing.\n---\n"),
        invalid("`name` is `other` but must equal the item id `review-checklist`")
    );
    assert_eq!(
        fails("---\nname: review-checklist\ndescription: \"\"\n---\n"),
        invalid("`description` is required and must be non-empty")
    );
    let unparsable = fails("---\nname: review-checklist\ndescription: Use it: when asked\n---\n");
    assert_eq!(unparsable.len(), 1, "{unparsable:?}");
    assert!(unparsable[0].starts_with(&format!("{path}: invalid SKILL.md frontmatter: ")));
}

#[test]
fn a_credential_in_any_text_file_fails_the_load() {
    let mut source = memory("all-kinds");
    // Assembled at run time so the source holds no token-shaped literal.
    let token = format!("ghp_{}", "x1".repeat(18));
    source.insert(
        "items/prompts/pr-description/prompt.md",
        format!("Write the description.\nUse {token} to read the repository.\n"),
    );
    assert_eq!(
        errors_of(&source),
        [
            "items/prompts/pr-description/prompt.md: `line 2` holds a literal that looks like a \
          credential (a GitHub token); use a secret reference such as { \"secret\": \"NAME\" }"
        ]
    );
}

#[test]
fn os_junk_is_ignored_and_other_dotfiles_are_content() {
    let base = memory("all-kinds");
    let before = revisions(&load(&base).unwrap());

    let mut junk = base.clone();
    for name in [".DS_Store", "Thumbs.db", "desktop.ini"] {
        junk.insert(format!("items/prompts/pr-description/{name}"), "junk");
    }
    junk.insert("profiles/.DS_Store", "junk");
    assert_eq!(revisions(&load(&junk).unwrap()), before);

    let mut plugin = base;
    plugin.insert(
        "items/plugins/release-tools/.claude-plugin/plugin.json",
        "{}",
    );
    let after = revisions(&load(&plugin).unwrap());
    assert_ne!(after["item release-tools"], before["item release-tools"]);
}

#[test]
fn bundle_errors_are_reported_once_at_the_bundle() {
    let errors: Vec<String> = load_fixture("errors")
        .unwrap_err()
        .iter()
        .map(ToString::to_string)
        .collect();
    let ghost: Vec<&String> = errors
        .iter()
        .filter(|message| message.contains("ghost-in-bundle"))
        .collect();
    assert_eq!(
        ghost,
        ["bundles/stray.json: `items` references unknown item `ghost-in-bundle`"]
    );
}

#[test]
fn cycle_detection_is_linear_in_the_profiles() {
    // Each profile extends the next two: a walk that does not remember
    // finished profiles takes Fibonacci time here and never ends.
    let mut source = memory("all-kinds");
    let count = 80;
    for index in 0..count {
        let parents: Vec<String> = (index + 1..count.min(index + 3))
            .map(|parent| format!("\"p{parent}\""))
            .collect();
        source.insert(
            format!("profiles/p{index}.json"),
            format!(
                r#"{{ "id": "p{index}", "title": "P", "version": "0.1.0", "extends": [{}] }}"#,
                parents.join(", ")
            ),
        );
    }
    assert!(load(&source).is_ok());
}

#[cfg(unix)]
#[test]
fn one_symbolic_link_costs_one_error() {
    let root = std::env::temp_dir().join(format!("shelfkit-symlink-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, bytes) in memory("all-kinds").files() {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }
    std::os::unix::fs::symlink(
        "/etc/hostname",
        root.join("items/prompts/pr-description/link.md"),
    )
    .unwrap();

    let errors = load(&DirSource::new(&root)).unwrap_err();
    std::fs::remove_dir_all(&root).unwrap();
    assert_eq!(
        errors.to_string(),
        "items/prompts/pr-description/link.md: invalid path: symbolic links are not allowed in a shelf"
    );
}

#[test]
fn the_schema_package_lists_exactly_the_notice_codes_rust_emits() {
    let catalog =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/schema/acidcat.catalog.json");
    let catalog: serde_json::Value =
        serde_json::from_slice(&std::fs::read(catalog).unwrap()).unwrap();
    let listed: BTreeSet<String> = catalog["$defs"]["Notice"]["properties"]["code"]["enum"]
        .as_array()
        .expect("the catalog's Notice type lists its codes")
        .iter()
        .map(|code| code.as_str().unwrap().to_owned())
        .collect();
    let emitted: BTreeSet<String> = shelfkit_core::NoticeCode::ALL
        .iter()
        .map(|code| {
            serde_json::to_value(code)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(listed, emitted);
}

#[test]
fn a_source_names_its_secret_by_reference_only() {
    let shelf = |secret: &str| {
        let mut source = MemorySource::new();
        source.insert(
            "shelf.json",
            format!(
                r#"{{ "name": "t", "sources": [{{ "id": "private", "kind": "git", "repo": "https://github.com/acme/private", "secret": "{secret}" }}] }}"#
            )
            .into_bytes(),
        );
        load(&source)
    };
    let loaded = shelf("GITHUB_TOKEN").unwrap();
    assert_eq!(
        loaded.manifest.sources[0].secret.as_deref(),
        Some("GITHUB_TOKEN")
    );
    let errors = shelf("ghp_notaname").unwrap_err();
    assert!(
        errors.to_string().contains("must be UPPER_SNAKE_CASE"),
        "{errors}"
    );
}
