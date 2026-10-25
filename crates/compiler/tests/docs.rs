//! Docs: reference documents a profile's instructions link to, which install as one skill folder whose copies the
//! links then point at (`crates/compiler/src/docs.rs`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use shelfkit_compiler::engine::{Request, package_profile, plan};
use shelfkit_core::MemorySource;
use shelfkit_registry::archive;

const SHELF: &str = r#"{ "name": "Box", "defaultProfile": "p", "registry": { "namespace": "box", "public": true } }"#;

fn shelf(targets: &str) -> MemorySource {
    [
        ("shelf.json", SHELF.to_owned()),
        (
            "items/instructions/rules/item.json",
            r#"{ "id": "rules", "kind": "instructions", "title": "Rules", "requires": ["domain"] }"#.to_owned(),
        ),
        (
            "items/instructions/rules/AGENTS.fragment.md",
            "Read [the domain](docs/agents/domain.md#terms) first, and [the glossary](GLOSSARY.md).\n".to_owned(),
        ),
        (
            "items/docs/domain/item.json",
            r#"{ "id": "domain", "kind": "doc", "title": "Domain docs", "description": "The words the code uses.",
                 "path": "docs/agents/domain.md" }"#
                .to_owned(),
        ),
        (
            "items/docs/domain/doc.md",
            "# Domain\n\nSee also [the glossary](../../GLOSSARY.md).\n".to_owned(),
        ),
        (
            "profiles/p.json",
            format!(r#"{{ "id": "p", "title": "P", "items": ["rules"], "compile": {{ "targets": {targets} }} }}"#),
        ),
    ]
    .into_iter()
    .collect()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn a_profiles_docs_install_as_one_skill_and_its_instructions_link_to_the_copies() {
    let compiled = plan(&shelf(r#"["claude", "codex"]"#), &Request::default()).unwrap();
    let file = |path: &str| {
        text(
            compiled
                .files
                .iter()
                .find(|file| file.path == path)
                .unwrap_or_else(|| panic!("no {path}"))
                .bytes()
                .unwrap()
                .as_slice(),
        )
    };

    // The doc keeps its path inside the skill, so links between docs still resolve.
    assert_eq!(
        file("vendor/p/.apm/skills/box-p-docs/docs/agents/domain.md"),
        "# Domain\n\nSee also [the glossary](../../GLOSSARY.md).\n"
    );
    let index = file("vendor/p/.apm/skills/box-p-docs/SKILL.md");
    assert!(index.starts_with("---\nname: box-p-docs\n"), "{index}");
    assert!(
        index.contains("- [Domain docs](docs/agents/domain.md): The words the code uses."),
        "{index}"
    );

    // A link to a doc in the profile points at its installed copy; one to a file it lacks is left alone.
    let rules = file("vendor/p/.github/instructions/rules.instructions.md");
    assert!(
        rules.contains("[the domain](.agents/skills/box-p-docs/docs/agents/domain.md#terms)"),
        "{rules}"
    );
    assert!(rules.contains("[the glossary](GLOSSARY.md)"), "{rules}");

    // APM would paste each linked document into AGENTS.md; the links stay links.
    assert!(
        compiled.apm_yml.contains("  resolve_links: false\n"),
        "{}",
        compiled.apm_yml
    );
    assert!(
        !compiled.apm_yml.contains("agent-skills"),
        "codex installs .agents/skills already"
    );
}

#[test]
fn a_profile_for_claude_alone_also_installs_the_skills_folder_the_links_name() {
    let compiled = plan(&shelf(r#"["claude"]"#), &Request::default()).unwrap();
    assert!(
        compiled
            .apm_yml
            .contains("targets:\n  - claude\n  - agent-skills\n"),
        "{}",
        compiled.apm_yml
    );
}

#[test]
fn the_published_package_carries_the_docs_skill() {
    let packaged = package_profile(&shelf(r#"["claude"]"#), &Request::default()).unwrap();
    let files = archive::read(&packaged.archive).unwrap();
    assert!(files.contains_key(".apm/skills/box-p-docs/SKILL.md"));
    assert!(files.contains_key(".apm/skills/box-p-docs/docs/agents/domain.md"));
}

#[test]
fn two_docs_at_one_path_are_refused() {
    let mut source = shelf(r#"["claude"]"#);
    source.insert(
        "items/docs/other/item.json",
        r#"{ "id": "other", "kind": "doc", "title": "Other", "path": "docs/agents/domain.md" }"#,
    );
    source.insert("items/docs/other/doc.md", "# Other\n");
    source.insert(
        "profiles/p.json",
        r#"{ "id": "p", "title": "P", "items": ["rules", "other"], "compile": { "targets": ["claude"] } }"#,
    );
    let errors = plan(&source, &Request::default()).unwrap_err().to_string();
    assert!(
        errors.contains("are both the doc at `docs/agents/domain.md`"),
        "{errors}"
    );
}

/// The shelf above plus a skill written inside `.agents/skills/`, whose links climb to its repository's root.
fn with_skill(source: &mut MemorySource, items: &str) {
    source.insert(
        "items/skills/triage/item.json",
        r#"{ "id": "triage", "kind": "skill", "title": "Triage" }"#,
    );
    source.insert(
        "items/skills/triage/SKILL.md",
        "---\nname: triage\ndescription: Triage issues.\n---\n\nRead [the domain](../../../docs/agents/domain.md#labels) \
         first, then [the checklist](references/checklist.md) and [the rules](../../../AGENTS.md).\n",
    );
    source.insert(
        "items/skills/triage/references/checklist.md",
        "Words come from [the domain](../../../../docs/agents/domain.md).\n",
    );
    source.insert(
        "items/docs/glossary/item.json",
        r#"{ "id": "glossary", "kind": "doc", "title": "Glossary", "path": "GLOSSARY.md" }"#,
    );
    source.insert("items/docs/glossary/doc.md", "# Glossary\n");
    source.insert(
        "profiles/p.json",
        format!(r#"{{ "id": "p", "title": "P", "items": {items}, "compile": {{ "targets": ["claude", "codex"] }} }}"#)
            .as_str(),
    );
}

#[test]
fn a_skill_that_links_a_doc_carries_its_own_copy_with_the_docs_that_one_links() {
    let mut source = shelf(r#"["claude", "codex"]"#);
    with_skill(&mut source, r#"["rules", "triage", "glossary"]"#);
    let compiled = plan(&source, &Request::default()).unwrap();
    let file = |path: &str| {
        compiled
            .files
            .iter()
            .find(|file| file.path == path)
            .map(|file| text(&file.bytes().unwrap()))
    };
    let skill = file("vendor/p/.apm/skills/triage/SKILL.md").unwrap();
    assert!(
        skill.contains("[the domain](docs/agents/domain.md#labels)"),
        "{skill}"
    );
    assert!(
        skill.contains("[the checklist](references/checklist.md)"),
        "{skill}"
    );
    assert!(skill.contains("[the rules](../../../AGENTS.md)"), "{skill}");
    let nested = file("vendor/p/.apm/skills/triage/references/checklist.md").unwrap();
    assert!(
        nested.contains("[the domain](../docs/agents/domain.md)"),
        "{nested}"
    );
    // The copy, and the glossary it links to, are inside the skill, where APM keeps links as they are written.
    assert_eq!(
        file("vendor/p/.apm/skills/triage/docs/agents/domain.md").unwrap(),
        "# Domain\n\nSee also [the glossary](../../GLOSSARY.md).\n"
    );
    assert_eq!(
        file("vendor/p/.apm/skills/triage/GLOSSARY.md").unwrap(),
        "# Glossary\n"
    );
}

#[test]
fn a_link_to_a_file_the_profile_does_not_ship_is_noted() {
    let mut source = shelf(r#"["claude", "codex"]"#);
    with_skill(&mut source, r#"["triage"]"#);
    source.insert(
        "items/instructions/rules/AGENTS.fragment.md",
        "Read [the domain](docs/agents/domain.md), [the app](apps/web/README.md), and [triage](.agents/skills/triage/SKILL.md).\n",
    );
    source.insert(
        "items/instructions/rules/item.json",
        r#"{ "id": "rules", "kind": "instructions", "title": "Rules" }"#,
    );
    source.insert(
        "profiles/p.json",
        r#"{ "id": "p", "title": "P", "items": ["rules", "triage"], "compile": { "targets": ["claude", "codex"] } }"#,
    );
    let compiled = plan(&source, &Request::default()).unwrap();
    let notes: Vec<String> = compiled
        .notes
        .iter()
        .filter(|note| serde_json::to_value(note.code).unwrap() == "doc-link")
        .map(|note| note.message.clone())
        .collect();
    // The domain doc is on the shelf but not in the profile, from the instruction and from the skill; the app's
    // README is on no shelf. The skill's own reference, AGENTS.md, and the triage skill itself are all installed.
    assert_eq!(notes.len(), 3, "{notes:#?}");
    assert!(notes.iter().any(|note| {
        note.starts_with("`rules` links to `docs/agents/domain.md`, which is the doc `domain`")
    }));
    assert!(notes.iter().any(|note| {
        note.starts_with("`triage` links to `docs/agents/domain.md`, which is the doc `domain`")
    }));
    assert!(notes.iter().any(|note| {
        note.starts_with(
            "`rules` links to `apps/web/README.md`, which no doc in the shelf provides",
        )
    }));
}

/// What the hosted importer writes for a repository's AGENTS.md and a doc it links to (`packages/importers`), each
/// pinned to its file upstream, with or without the copies a licence permits.
fn imported(copied: bool) -> MemorySource {
    let source = r#""source": { "repo": "https://github.com/acme/app", "path": "AGENTS.md", "resolvedCommit": "c1" }"#;
    let doc_source = r#""source": { "repo": "https://github.com/acme/app", "path": "docs/domain.md", "resolvedCommit": "c1" }"#;
    let mut files = vec![
        ("shelf.json", SHELF.to_owned()),
        (
            "items/instructions/app/item.json",
            format!(
                r#"{{ "id": "app", "kind": "instructions", "title": "App", "requires": ["domain"], {source} }}"#
            ),
        ),
        (
            "items/docs/domain/item.json",
            format!(
                r#"{{ "id": "domain", "kind": "doc", "title": "Domain", "path": "docs/domain.md", {doc_source} }}"#
            ),
        ),
        (
            "profiles/p.json",
            r#"{ "id": "p", "title": "P", "items": ["app"], "compile": { "targets": ["codex"] } }"#
                .to_owned(),
        ),
    ];
    if copied {
        files.push((
            "items/instructions/app/AGENTS.fragment.md",
            "# App\n\nRead [the domain](docs/domain.md).\n".to_owned(),
        ));
        files.push(("items/docs/domain/doc.md", "# Domain\n".to_owned()));
    }
    files.into_iter().collect()
}

#[test]
fn an_imported_agents_md_compiles_from_its_copy_with_its_links_pointed_at_the_docs() {
    let compiled = plan(&imported(true), &Request::default()).unwrap();
    // APM installs instructions only from an `.instructions.md` file, so AGENTS.md is no upstream reference.
    assert!(
        !compiled.apm_yml.contains("acme/app"),
        "{}",
        compiled.apm_yml
    );
    let rules = compiled
        .files
        .iter()
        .find(|file| file.path == "vendor/p/.github/instructions/app.instructions.md")
        .expect("AGENTS.md was not vendored");
    let rules = text(rules.bytes().unwrap().as_slice());
    assert!(
        rules.contains("[the domain](.agents/skills/box-p-docs/docs/domain.md)"),
        "{rules}"
    );
}

#[test]
fn an_agents_md_or_a_doc_imported_as_a_link_says_why_it_cannot_compile() {
    let errors = plan(&imported(false), &Request::default())
        .unwrap_err()
        .to_string();
    assert!(
        errors.contains("`app` was imported as a link, without its text"),
        "{errors}"
    );
    assert!(
        errors.contains("`domain` was imported as a link, without its text"),
        "{errors}"
    );
}
