//! `SKILL.md` frontmatter, checked against agentskills.io.
//!
//! A problem is *hard* when an agent cannot use the skill: there is no
//! frontmatter, it does not parse, or `name` or `description` is unusable.
//! Those are load errors. Every other deviation from the specification is
//! *soft*: harnesses such as Claude Code read the file anyway, so the shelf
//! keeps it exactly as written and `check` reports a
//! [`crate::NoticeCode::SkillFrontmatter`] notice for each one.

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

/// Check a `SKILL.md` for the skill `id`.
pub(crate) fn check_frontmatter(id: &str, bytes: &[u8]) -> FrontmatterProblems {
    let mut problems = FrontmatterProblems::default();
    let text = String::from_utf8_lossy(&normalize_line_endings(bytes)).into_owned();
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let frontmatter = text
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---").map(|(yaml, _)| yaml));
    let Some(frontmatter) = frontmatter else {
        problems
            .hard
            .push("must start with a `---` YAML block".to_owned());
        return problems;
    };
    let mapping = match serde_yaml::from_str::<serde_yaml::Value>(frontmatter) {
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
                    "`description` is {length} characters; agentskills.io allows at most {DESCRIPTION_LIMIT}"
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
            Some(key) => problems.soft.push(format!(
                "unknown key `{key}`; agentskills.io allows only {}",
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
            problems
                .soft
                .push("`metadata` must map strings to strings".to_owned());
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
    check_frontmatter(&loaded.item.id, bytes)
        .soft
        .into_iter()
        .map(|problem| Notice {
            path: path.clone(),
            code: NoticeCode::SkillFrontmatter,
            message: format!(
                "{problem}. Clients and uploaders that hold to agentskills.io (such as \
                 claude.ai's skill upload) may refuse this file; harnesses like Claude Code read it"
            ),
        })
        .collect()
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
                "`description` is 1025 characters; agentskills.io allows at most 1024",
                "unknown key `disable-model-invocation`; agentskills.io allows only \
                 allowed-tools, compatibility, description, license, metadata, name",
                "`license` must be a string",
                "`compatibility` is 501 characters; agentskills.io allows at most 500",
                "`metadata` must map strings to strings",
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
