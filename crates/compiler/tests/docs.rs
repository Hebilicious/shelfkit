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
