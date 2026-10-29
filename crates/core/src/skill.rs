//! `SKILL.md` frontmatter, checked against agentskills.io.
//!
//! A problem is *hard* when an agent cannot use the skill: there is no
//! frontmatter, it does not parse, or `name` or `description` is unusable.
//! Those are load errors. Every other deviation from the specification is
//! *soft*: harnesses such as Claude Code read the file anyway, so the shelf
//! keeps it exactly as written and `check` reports a
//! [`crate::NoticeCode::SkillFrontmatter`] notice for each one, saying what
//! the deviation costs in each agent and whether a spec-valid form keeps it.
//!
//! What each agent does was checked on Claude Code 2.1.306, Codex 0.163.0,
//! Copilot CLI 1.0.101, VS Code, and Cursor in October 2026: Claude Code,
//! Cursor, and Copilot honour `disable-model-invocation` at the top level
//! only, Codex ignores it, Copilot CLI refuses a description over 1024
//! characters, and no agent acts on `metadata` beyond its own keys. For
//! Codex, [`codex_settings`] carries `disable-model-invocation` over into
//! the `agents/openai.yaml` it reads.

use crate::revision::normalize_line_endings;
use crate::shelf::{LoadedItem, Notice, NoticeCode};

/// The agentskills.io frontmatter keys.
const SPEC_KEYS: &[&str] = &[
    "allowed-tools",
    "compatibility",
    "description",
    "license",
    "metadata",
    "name",
];

/// Keys Claude Code reads at the top level of `SKILL.md` that agentskills.io
/// does not define. None has a spec-valid place: moved into `metadata`,
/// Claude Code ignores it.
const CLAUDE_CODE_KEYS: &[&str] = &[
    "agent",
    "argument-hint",
    "context",
    "effort",
    "hooks",
    "model",
    "user-invocable",
];

/// What strict readers do with a file that strays from the specification.
const STRICT: &str = "strict validators and claude.ai's skill upload refuse this file";

const DESCRIPTION_LIMIT: usize = 1024;
const COMPATIBILITY_LIMIT: usize = 500;

/// What is wrong with a `SKILL.md`'s frontmatter, split by consequence.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct FrontmatterProblems {
    /// Problems that stop the skill from loading.
    pub hard: Vec<String>,
    /// Spec deviations that `check` reports and the shelf tolerates.
    pub soft: Vec<String>,
}

/// The YAML between a `SKILL.md`'s opening `---` fences, if it has them.
fn frontmatter_text(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(&normalize_line_endings(bytes)).into_owned();
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    text.strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---").map(|(yaml, _)| yaml.to_owned()))
}

/// Where Codex reads a skill's settings, in the skill's own folder.
pub const CODEX_SETTINGS: &str = "agents/openai.yaml";

/// The `agents/openai.yaml` a skill gets when its `SKILL.md` sets `disable-model-invocation: true` and it has no
/// such file of its own. Claude Code, Cursor, and Copilot read that key; Codex does not, and keeps a skill out of the
/// model's reach only through `policy.allow_implicit_invocation: false` in this file, which it still lets a person
/// invoke as `$<name>`.
pub fn codex_settings(loaded: &LoadedItem) -> Option<Vec<u8>> {
    if loaded.files.contains_key(CODEX_SETTINGS) {
        return None;
    }
    disables_model_invocation(loaded.files.get("SKILL.md")?).then(|| {
        b"# Written by ShelfKit: SKILL.md sets `disable-model-invocation: true`, which Codex does not read.\n\
          policy:\n  allow_implicit_invocation: false\n"
            .to_vec()
    })
}

/// Whether a `SKILL.md`'s frontmatter sets `disable-model-invocation: true`.
fn disables_model_invocation(bytes: &[u8]) -> bool {
    frontmatter_text(bytes)
        .and_then(|yaml| serde_yaml::from_str::<serde_yaml::Value>(&yaml).ok())
        .and_then(|value| {
            value
                .get("disable-model-invocation")
                .and_then(serde_yaml::Value::as_bool)
        })
        == Some(true)
}

/// Whether a skill's own `agents/openai.yaml` lets Codex use it unasked, when `SKILL.md` says no model may.
fn codex_settings_disagree(loaded: &LoadedItem) -> bool {
    let (Some(skill), Some(settings)) = (
        loaded.files.get("SKILL.md"),
        loaded.files.get(CODEX_SETTINGS),
    ) else {
        return false;
    };
    let implicit = serde_yaml::from_slice::<serde_yaml::Value>(settings)
        .ok()
        .and_then(|value| {
            value
                .get("policy")?
                .get("allow_implicit_invocation")?
                .as_bool()
        });
    disables_model_invocation(skill) && implicit != Some(false)
}

/// Check a `SKILL.md` for the skill `id`.
pub(crate) fn check_frontmatter(id: &str, bytes: &[u8]) -> FrontmatterProblems {
    let mut problems = FrontmatterProblems::default();
    let Some(frontmatter) = frontmatter_text(bytes) else {
        problems
            .hard
            .push("must start with a `---` YAML block".to_owned());
        return problems;
    };
    let mapping = match serde_yaml::from_str::<serde_yaml::Value>(&frontmatter) {
        Ok(serde_yaml::Value::Mapping(mapping)) => mapping,
        Ok(_) => {
            problems.hard.push("must be a YAML mapping".to_owned());
            return problems;
        }
        Err(error) => {
            problems.hard.push(error.to_string());
            return problems;
        }
    };

    let string = |key: &str| mapping.get(key).and_then(serde_yaml::Value::as_str);
    match string("name") {
        Some(name) if name == id => {}
        Some(name) => problems.hard.push(format!(
            "`name` is `{name}` but must equal the item id `{id}`"
        )),
        None => problems
            .hard
            .push("`name` is required and must be a string".to_owned()),
    }
    match string("description") {
        Some(description) if description.trim().is_empty() => problems
            .hard
            .push("`description` is required and must be non-empty".to_owned()),
        Some(description) => {
            let length = description.chars().count();
            if length > DESCRIPTION_LIMIT {
                problems.soft.push(format!(
                    "`description` is {length} characters, over agentskills.io's {DESCRIPTION_LIMIT}: Copilot CLI \
                     refuses to load the skill, and Codex and VS Code cut the description short. Shortening it to \
                     {DESCRIPTION_LIMIT} loses nothing in Claude Code"
                ));
            }
        }
        None => problems
            .hard
            .push("`description` is required and must be a non-empty string".to_owned()),
    }

    for key in mapping.keys() {
        match key.as_str() {
            Some(key) if SPEC_KEYS.contains(&key) => {}
            Some("disable-model-invocation") => problems.soft.push(format!(
                "`disable-model-invocation` is not an agentskills.io key, so {STRICT}. Claude Code, Cursor, and \
                 Copilot honour it here at the top level and nowhere else (in `metadata` they ignore it). Codex \
                 ignores it, so the installed skill gets `{CODEX_SETTINGS}` with `policy: allow_implicit_invocation: \
                 false`, which Codex reads instead"
            )),
            Some(key) if CLAUDE_CODE_KEYS.contains(&key) => problems.soft.push(format!(
                "`{key}` is a Claude Code key, not an agentskills.io one, so {STRICT}. Claude Code honours it only \
                 at the top level; agents that do not know it ignore it"
            )),
            Some(key) => problems.soft.push(format!(
                "unknown key `{key}`: agentskills.io allows only {}, so {STRICT}; agents ignore a key they do not \
                 know",
                SPEC_KEYS.join(", ")
            )),
            None => problems.soft.push("keys must be strings".to_owned()),
        }
    }
    for key in ["license", "compatibility", "allowed-tools"] {
        if mapping.get(key).is_some_and(|value| !value.is_string()) {
            problems.soft.push(format!("`{key}` must be a string"));
        }
    }
    if let Some(length) = string("compatibility")
        .map(|value| value.chars().count())
        .filter(|length| *length > COMPATIBILITY_LIMIT)
    {
        problems.soft.push(format!(
            "`compatibility` is {length} characters; agentskills.io allows at most {COMPATIBILITY_LIMIT}"
        ));
    }
    if let Some(metadata) = mapping.get("metadata") {
        let flat = metadata.as_mapping().is_some_and(|map| {
            map.iter()
                .all(|(key, value)| key.is_string() && value.is_string())
        });
        if !flat {
            problems.soft.push(format!(
                "`metadata` must map strings to strings, so {STRICT}. Agents read only their own `metadata` keys, so \
                 flattening it to string values loses nothing"
            ));
        }
    }
    problems
}

/// One [`NoticeCode::SkillFrontmatter`] notice per soft problem in a loaded
/// skill's `SKILL.md`. Anything else has none.
pub(crate) fn notices(loaded: &LoadedItem) -> Vec<Notice> {
    let Some(bytes) = loaded.files.get("SKILL.md") else {
        return Vec::new();
    };
    let path = format!("{}/SKILL.md", loaded.path);
    let mut notices: Vec<Notice> = check_frontmatter(&loaded.item.id, bytes)
        .soft
        .into_iter()
        .map(|problem| Notice {
            path: path.clone(),
            code: NoticeCode::SkillFrontmatter,
            message: problem,
        })
        .collect();
    if codex_settings_disagree(loaded) {
        notices.push(Notice {
            path: format!("{}/{CODEX_SETTINGS}", loaded.path),
            code: NoticeCode::SkillFrontmatter,
            message: format!(
                "SKILL.md sets `disable-model-invocation: true`, but this `{CODEX_SETTINGS}` does not set \
                 `policy: allow_implicit_invocation: false`, so Codex still uses the skill on its own. The file is \
                 the skill's, so ShelfKit leaves it as it is"
            ),
        });
    }
    notices
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill(frontmatter: &str) -> FrontmatterProblems {
        check_frontmatter(
            "demo",
            format!("---\n{frontmatter}\n---\n\nBody.\n").as_bytes(),
        )
    }

    #[test]
    fn spec_frontmatter_has_no_problems() {
        let problems = skill(
            "name: demo\ndescription: Does a thing.\nlicense: MIT\ncompatibility: Any\n\
             allowed-tools: Read\nmetadata:\n  author: someone",
        );
        assert_eq!(problems, FrontmatterProblems::default());
    }

    #[test]
    fn spec_deviations_an_agent_can_live_with_are_soft() {
        let long = "x".repeat(DESCRIPTION_LIMIT + 1);
        let problems = skill(&format!(
            "name: demo\ndescription: {long}\ndisable-model-invocation: true\n\
             license: 3\ncompatibility: {}\n\
             metadata:\n  credits:\n    skill: a\n    author: b",
            "y".repeat(COMPATIBILITY_LIMIT + 1)
        ));
        assert!(problems.hard.is_empty(), "{problems:?}");
        assert_eq!(
            problems.soft,
            [
                "`description` is 1025 characters, over agentskills.io's 1024: Copilot CLI refuses to load the \
                 skill, and Codex and VS Code cut the description short. Shortening it to 1024 loses nothing in \
                 Claude Code",
                "`disable-model-invocation` is not an agentskills.io key, so strict validators and claude.ai's \
                 skill upload refuse this file. Claude Code, Cursor, and Copilot honour it here at the top level \
                 and nowhere else (in `metadata` they ignore it). Codex ignores it, so the installed skill gets \
                 `agents/openai.yaml` with `policy: allow_implicit_invocation: false`, which Codex reads instead",
                "`license` must be a string",
                "`compatibility` is 501 characters; agentskills.io allows at most 500",
                "`metadata` must map strings to strings, so strict validators and claude.ai's skill upload refuse \
                 this file. Agents read only their own `metadata` keys, so flattening it to string values loses \
                 nothing",
            ]
        );
        assert_eq!(
            skill("name: demo\ndescription: A thing.\nargument-hint: <file>\nx-mine: 1").soft,
            [
                "`argument-hint` is a Claude Code key, not an agentskills.io one, so strict validators and \
                 claude.ai's skill upload refuse this file. Claude Code honours it only at the top level; agents \
                 that do not know it ignore it",
                "unknown key `x-mine`: agentskills.io allows only allowed-tools, compatibility, description, \
                 license, metadata, name, so strict validators and claude.ai's skill upload refuse this file; \
                 agents ignore a key they do not know",
            ]
        );
    }

    #[test]
    fn a_skill_an_agent_cannot_use_is_hard() {
        let hard = |text: &str| check_frontmatter("demo", text.as_bytes()).hard;
        assert_eq!(
            hard("No frontmatter."),
            ["must start with a `---` YAML block"]
        );
        assert_eq!(hard("---\n- a list\n---\n"), ["must be a YAML mapping"]);
        // An unquoted `: ` inside a plain scalar: no YAML reader reads it.
        assert_eq!(
            hard("---\nname: demo\ndescription: Use it: when asked\n---\n").len(),
            1
        );
        assert_eq!(
            skill("description: A thing.").hard,
            ["`name` is required and must be a string"]
        );
        assert_eq!(
            skill("name: other\ndescription: A thing.").hard,
            ["`name` is `other` but must equal the item id `demo`"]
        );
        assert_eq!(
            skill("name: demo\ndescription: '  '").hard,
            ["`description` is required and must be non-empty"]
        );
        assert_eq!(
            skill("name: demo").hard,
            ["`description` is required and must be a non-empty string"]
        );
    }
}
