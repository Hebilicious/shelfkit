//! A profile's docs: the reference documents its instructions link to (`docs/PRD.md` section 4.2).
//!
//! APM 0.33 has no primitive for a document and installs no loose file, but it copies a skill folder whole into
//! `.agents/skills/` and `.claude/skills/`, which a repository commits. So a profile's docs compile into one skill
//! of its own, `<namespace>-<profile>-docs`, each at its `path` inside the folder, so links between docs still
//! resolve; the skill's `SKILL.md` lists them, and every agent sees that list and opens a doc when it needs one.
//!
//! The instructions keep linking to a doc by its `path` (`docs/agents/domain.md`); the compiler points those links
//! at the installed copy, `.agents/skills/<skill>/docs/agents/domain.md`, relative to the repository's root, which is
//! where AGENTS.md is read from. The manifest turns `compile`'s link resolution off, since APM would otherwise paste
//! every linked document into AGENTS.md, and makes sure some target installs skills into `.agents/skills/`.

use crate::yaml;
use std::collections::BTreeMap;

/// Where APM installs skills for every agent but Claude Code, and where instructions link docs to.
pub const DEPLOYED_ROOT: &str = ".agents/skills";

/// Targets that install skills into [`DEPLOYED_ROOT`]. A profile with docs whose targets have none of these also
/// gets `agent-skills`, the canonical target for exactly that folder.
pub const DEPLOYING_TARGETS: &[&str] = &[
    "agent-skills",
    "all",
    "antigravity",
    "codex",
    "copilot",
    "cursor",
    "gemini",
    "opencode",
    "windsurf",
];

/// One doc of a profile.
#[derive(Debug, Clone)]
pub struct Doc {
    pub id: String,
    pub title: String,
    pub description: String,
    pub bytes: Vec<u8>,
}

/// The skill a profile's docs install as: a valid skill name (lowercase letters, digits, and single hyphens, at
/// most 64 characters), unique to the shelf's namespace and the profile.
pub fn skill_name(namespace: Option<&str>, profile: &str) -> String {
    let joined = match namespace {
        Some(namespace) if !namespace.is_empty() => format!("{namespace}-{profile}-docs"),
        _ => format!("{profile}-docs"),
    };
    let mut name = String::new();
    for c in joined.to_ascii_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() { c } else { '-' };
        if !(c == '-' && (name.is_empty() || name.ends_with('-'))) {
            name.push(c);
        }
    }
    let mut name: String = name.trim_end_matches('-').chars().take(64).collect();
    while name.ends_with('-') {
        name.pop();
    }
    name
}

/// The skill's files, by path inside the package: `.apm/skills/<skill>/SKILL.md` and each doc at its path.
pub fn skill_files(skill: &str, docs: &BTreeMap<String, Doc>) -> BTreeMap<String, Vec<u8>> {
    let root = format!(".apm/skills/{skill}");
    let mut files: BTreeMap<String, Vec<u8>> = docs
        .iter()
        .map(|(path, doc)| (format!("{root}/{path}"), doc.bytes.clone()))
        .collect();
    files.insert(format!("{root}/SKILL.md"), index(skill, docs).into_bytes());
    files
}

/// The skill's `SKILL.md`: what the docs are, for the agent's list of skills, and a link to each.
fn index(skill: &str, docs: &BTreeMap<String, Doc>) -> String {
    let titles: Vec<&str> = docs.values().map(|doc| doc.title.trim()).collect();
    let mut description = format!(
        "Reference documents this repository's instructions link to: {}. Open one when an instruction or the task \
         points to it; they are not loaded otherwise.",
        titles.join(", ")
    );
    if description.chars().count() > 1024 {
        description = description.chars().take(1021).collect::<String>() + "...";
    }
    let mut out = format!(
        "---\nname: {skill}\ndescription: {}\n---\n\n# Reference documents\n\nThe instructions in AGENTS.md link to \
         these documents. Read one when an instruction points to it or the task needs it.\n\n",
        yaml::scalar(&description)
    );
    for (path, doc) in docs {
        let summary = doc.description.trim();
        if summary.is_empty() {
            out.push_str(&format!("- [{}]({path})\n", doc.title.trim()));
        } else {
            out.push_str(&format!("- [{}]({path}): {summary}\n", doc.title.trim()));
        }
    }
    out
}

/// `text` with every markdown link to one of `paths` (inline `[x](path)` or a reference definition `[x]: path`,
/// written plain or as `./path`, with or without a `#fragment`) pointed at the doc's installed copy.
pub fn rewrite_links(text: &str, paths: &[&str], skill: &str) -> String {
    let installed = |target: &str| -> Option<String> {
        let (path, fragment) = target
            .split_once('#')
            .map_or((target, ""), |(path, fragment)| (path, fragment));
        let path = path.strip_prefix("./").unwrap_or(path);
        paths.contains(&path).then(|| {
            let mut out = format!("{DEPLOYED_ROOT}/{skill}/{path}");
            if !fragment.is_empty() {
                out.push('#');
                out.push_str(fragment);
            }
            out
        })
    };

    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        out.push_str(
            &rewrite_reference(line, &installed)
                .unwrap_or_else(|| rewrite_inline(line, &installed)),
        );
    }
    out
}

/// A reference definition line, `[label]: target "title"`, with its target rewritten; `None` for any other line.
fn rewrite_reference(line: &str, installed: &impl Fn(&str) -> Option<String>) -> Option<String> {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let rest = trimmed.strip_prefix('[')?;
    let (label, rest) = rest.split_once("]:")?;
    let spaced = rest.len() - rest.trim_start().len();
    let rest = rest.trim_start();
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let target = installed(&rest[..end])?;
    Some(format!(
        "{indent}[{label}]:{}{target}{}",
        " ".repeat(spaced.max(1)),
        &rest[end..]
    ))
}

/// Every inline link `](target)` in the line whose target is a doc, rewritten.
fn rewrite_inline(line: &str, installed: &impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find("](") {
        let (before, after) = rest.split_at(at + 2);
        out.push_str(before);
        let end = after
            .find(|c: char| c == ')' || c.is_whitespace())
            .unwrap_or(after.len());
        let target = &after[..end];
        match installed(target) {
            Some(rewritten) => out.push_str(&rewritten),
            None => out.push_str(target),
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_skill_is_named_for_the_namespace_and_the_profile() {
        assert_eq!(
            skill_name(Some("jarettes-box"), "default"),
            "jarettes-box-default-docs"
        );
        assert_eq!(skill_name(None, "default"), "default-docs");
        assert_eq!(skill_name(Some("A.B"), "x"), "a-b-x-docs");
        assert!(skill_name(Some(&"n".repeat(80)), "x").len() <= 64);
    }

    #[test]
    fn links_to_a_doc_point_at_its_installed_copy() {
        let paths = ["docs/agents/domain.md", "GLOSSARY.md"];
        let text = "See [the domain](docs/agents/domain.md#terms) and [words](./GLOSSARY.md \"Glossary\").\n\
                    Not [this](docs/other.md) or [that](https://example.com/GLOSSARY.md).\n\
                    [glossary]: GLOSSARY.md\n";
        assert_eq!(
            rewrite_links(text, &paths, "box-default-docs"),
            "See [the domain](.agents/skills/box-default-docs/docs/agents/domain.md#terms) and \
             [words](.agents/skills/box-default-docs/GLOSSARY.md \"Glossary\").\n\
             Not [this](docs/other.md) or [that](https://example.com/GLOSSARY.md).\n\
             [glossary]: .agents/skills/box-default-docs/GLOSSARY.md\n"
        );
    }

    #[test]
    fn the_index_lists_every_doc_by_its_path_in_the_skill() {
        let docs = BTreeMap::from([(
            "docs/agents/domain.md".to_owned(),
            Doc {
                bytes: b"# Domain\n".to_vec(),
                description: "The words the code uses.".to_owned(),
                id: "domain".to_owned(),
                title: "Domain docs".to_owned(),
            },
        )]);
        let files = skill_files("box-default-docs", &docs);
        let index =
            String::from_utf8(files[".apm/skills/box-default-docs/SKILL.md"].clone()).unwrap();
        assert!(
            index.starts_with("---\nname: box-default-docs\ndescription: "),
            "{index}"
        );
        assert!(
            index.contains("- [Domain docs](docs/agents/domain.md): The words the code uses.\n"),
            "{index}"
        );
        assert_eq!(
            files[".apm/skills/box-default-docs/docs/agents/domain.md"],
            b"# Domain\n"
        );
    }
}
