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

/// The doc a link names, and the link's `#fragment` (empty when it has none): the target, written plain, as
/// `./path`, or climbing out of where it was written with leading `../` (as a skill written inside `.agents/skills/`
/// reaches its repository's root), is one of `paths`.
pub fn doc_link<'p>(target: &str, paths: &[&'p str]) -> Option<(&'p str, String)> {
    let (path, fragment) = target.split_once('#').unwrap_or((target, ""));
    let mut path = path.strip_prefix("./").unwrap_or(path);
    while let Some(rest) = path.strip_prefix("../") {
        path = rest;
    }
    let found = paths.iter().find(|candidate| **candidate == path)?;
    Some((found, fragment.to_owned()))
}

fn with_fragment(path: String, fragment: &str) -> String {
    if fragment.is_empty() {
        path
    } else {
        format!("{path}#{fragment}")
    }
}

/// An instruction's text with every link to one of `paths` pointed at the doc's copy in the profile's docs skill,
/// relative to the repository's root, which is where AGENTS.md is read from.
pub fn rewrite_links(text: &str, paths: &[&str], skill: &str) -> String {
    rewrite_targets(text, &|target| {
        doc_link(target, paths).map(|(path, fragment)| {
            with_fragment(format!("{DEPLOYED_ROOT}/{skill}/{path}"), &fragment)
        })
    })
}

/// One skill's files (by path inside the skill) with every link to a doc pointed at a copy of the doc inside the skill
/// itself, at the doc's path, and those copies added, with the docs they link to in turn.
///
/// Inside, because APM 0.33 keeps a link that stays within a skill's folder as written but rewrites one that leaves
/// it, even to a sibling skill of the same package, to the package's copy under `apm_modules/`, which a repository
/// does not commit. A skill already holding a file at a doc's path keeps it, and its links to that path are left.
pub fn localize(files: &mut BTreeMap<String, Vec<u8>>, docs: &BTreeMap<String, Doc>) {
    let paths: Vec<&str> = docs.keys().map(String::as_str).collect();
    let own: Vec<String> = files.keys().cloned().collect();
    let mut wanted: Vec<String> = Vec::new();
    for name in own.iter().filter(|name| name.ends_with(".md")) {
        let Some(bytes) = files.get_mut(name) else {
            continue;
        };
        let Ok(text) = std::str::from_utf8(bytes) else {
            continue;
        };
        let up = "../".repeat(name.matches('/').count());
        let rewritten = rewrite_targets(text, &|target| {
            let (path, fragment) = doc_link(target, &paths)?;
            if own.iter().any(|file| file == path) {
                return None;
            }
            Some(with_fragment(format!("{up}{path}"), &fragment))
        });
        if rewritten != text {
            for target in markdown_targets(text) {
                if let Some((path, _)) = doc_link(&target, &paths)
                    && !own.iter().any(|file| file == path)
                    && !wanted.iter().any(|known| known == path)
                {
                    wanted.push(path.to_owned());
                }
            }
            *bytes = rewritten.into_bytes();
        }
    }
    // The docs those docs link to, relative to where each doc sits, come too.
    let mut at = 0;
    while at < wanted.len() {
        let path = wanted[at].clone();
        at += 1;
        let Some(doc) = docs.get(&path) else { continue };
        let Ok(text) = std::str::from_utf8(&doc.bytes) else {
            continue;
        };
        for target in markdown_targets(text) {
            if let Some(linked) = resolve(&path, &target)
                && docs.contains_key(&linked)
                && !files.contains_key(&linked)
                && !wanted.contains(&linked)
            {
                wanted.push(linked);
            }
        }
    }
    for path in wanted {
        if let Some(doc) = docs.get(&path) {
            files.entry(path).or_insert_with(|| doc.bytes.clone());
        }
    }
}

/// `target`, a relative link written in the file at `from`, as a path from the root `from` is relative to; `None`
/// for an absolute URL, an anchor, or a link that climbs out of the root.
pub fn resolve(from: &str, target: &str) -> Option<String> {
    let path = target.split('#').next().unwrap_or_default();
    if path.is_empty()
        || path.contains("://")
        || path.starts_with('/')
        || path.starts_with("mailto:")
    {
        return None;
    }
    let mut segments: Vec<&str> = from.split('/').collect();
    segments.pop();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            other => segments.push(other),
        }
    }
    Some(segments.join("/"))
}

/// Every link target in a markdown text: inline `[x](target)` and reference definitions `[x]: target`.
pub fn markdown_targets(text: &str) -> Vec<String> {
    let found = std::cell::RefCell::new(Vec::new());
    rewrite_targets(text, &|target| {
        found.borrow_mut().push(target.to_owned());
        None
    });
    found.into_inner()
}

/// `text` with each link target that `rewrite` maps replaced, line by line.
fn rewrite_targets(text: &str, rewrite: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        out.push_str(
            &rewrite_reference(line, rewrite).unwrap_or_else(|| rewrite_inline(line, rewrite)),
        );
    }
    out
}

/// A reference definition line, `[label]: target "title"`, with its target rewritten; `None` for any other line.
fn rewrite_reference(line: &str, rewrite: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let rest = trimmed.strip_prefix('[')?;
    let (label, rest) = rest.split_once("]:")?;
    let spaced = rest.len() - rest.trim_start().len();
    let rest = rest.trim_start();
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let target = rewrite(&rest[..end])?;
    Some(format!(
        "{indent}[{label}]:{}{target}{}",
        " ".repeat(spaced.max(1)),
        &rest[end..]
    ))
}

/// Every inline link `](target)` in the line, its target rewritten where `rewrite` maps it.
fn rewrite_inline(line: &str, rewrite: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find("](") {
        let (before, after) = rest.split_at(at + 2);
        out.push_str(before);
        let end = after
            .find(|c: char| c == ')' || c.is_whitespace())
            .unwrap_or(after.len());
        let target = &after[..end];
        match rewrite(target) {
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
