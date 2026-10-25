//! Items whose content is in the shelf, compiled into APM's package layout.
//!
//! Shelf-authored items compile into one local APM package with a `.apm/`
//! directory, APM's layout for "N independent primitives" (`docs/PRD.md`
//! section 3.1):
//!
//! | Kind | Written to |
//! | --- | --- |
//! | `skill` | `.apm/skills/<id>/`, every file of the item but `item.json` |
//! | `prompt` | `.apm/prompts/<id>.prompt.md` |
//! | `agent` | `.apm/agents/<id>.agent.md` |
//! | `hook` | `.apm/hooks/<id>.json` |
//! | `instructions`, `library`, `stack` | `.github/instructions/<id>.instructions.md` |
//!
//! Instructions are the exception to `.apm/`, on purpose. APM 0.33's
//! installer turns `.apm/instructions/` into a rule file per item per agent
//! (`.claude/rules/`, `.cursor/rules/`, `.github/instructions/`), which Codex
//! never reads and which Cursor and Copilot then also get from AGENTS.md.
//! It does not deploy a package's `.github/instructions/`, while `apm
//! compile` reads both directories. So a package that keeps its
//! instructions there installs no rule files, and `apm compile` writes them
//! into one section of the repository's AGENTS.md, which every agent reads
//! (`docs/PRD.md` section 4.2). The compiler's APM test installs a compiled
//! package to hold APM to this.
//!
//! A `plugin` is a package layout of its own, not a primitive under `.apm/`,
//! so each one is vendored beside that package as its own directory, with
//! the item's files as they are: a shelf never rewrites a package's layout.
//!
//! Text is written with LF line endings, the bytes the revision hashed.

use shelfkit_core::item::{Library, Payload, Prompt, Section, Stack};
use shelfkit_core::revision::normalize_line_endings;
use shelfkit_core::{ItemKind, LoadedItem};
use std::collections::BTreeMap;
use std::fmt::Write as _;

const ITEM_JSON: &str = "item.json";

/// The files one item contributes to the vendored package, by path relative
/// to the package root. An error is a message about the item.
pub fn primitive_files(loaded: &LoadedItem) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let item = &loaded.item;
    let id = &item.id;
    let mut files = BTreeMap::new();
    match &item.payload {
        Payload::Skill(_) => {
            require(loaded, "SKILL.md")?;
            for (name, bytes) in content_files(loaded) {
                files.insert(format!(".apm/skills/{id}/{name}"), bytes);
            }
        }
        Payload::Prompt(prompt) => {
            let body = text(loaded, require(loaded, "prompt.md")?)?;
            files.insert(
                format!(".apm/prompts/{id}.prompt.md"),
                render_prompt(description(loaded), prompt, &body).into_bytes(),
            );
        }
        Payload::Agent(_) => {
            let body = require(loaded, "agent.md")?;
            files.insert(
                format!(".apm/agents/{id}.agent.md"),
                normalize_line_endings(body),
            );
        }
        Payload::Hook(_) => {
            // APM classifies a virtual file only by `.prompt.md`,
            // `.instructions.md`, and `.agent.md`, so a hook can never be a
            // file dependency: it arrives through a package or not at all.
            let hook = require(loaded, "hook.json").map_err(|_| {
                format!(
                    "a hook compiles into the vendored package, because APM cannot pin a `.json` \
                     file, so `{id}` must carry its hook.json"
                )
            })?;
            let extra: Vec<String> = content_files(loaded)
                .map(|(name, _)| name)
                .filter(|name| name != "hook.json")
                .collect();
            if !extra.is_empty() {
                return Err(format!(
                    "a hook compiles to `.apm/hooks/{id}.json` alone, and `{id}` also carries {}, \
                     which the vendored hook could not reference; inline them or drop them",
                    extra.join(", ")
                ));
            }
            files.insert(
                format!(".apm/hooks/{id}.json"),
                normalize_line_endings(hook),
            );
        }
        Payload::Instructions(instructions) => {
            let fragment = match loaded.files.get("AGENTS.fragment.md") {
                Some(bytes) => Some(text(loaded, bytes)?),
                None => None,
            };
            let body = render_sections(&instructions.sections, fragment.as_deref());
            files.insert(
                instructions_path(id),
                render_instructions(loaded, &body).into_bytes(),
            );
        }
        Payload::Library(library) => {
            let body = render_library(library);
            files.insert(
                instructions_path(id),
                render_instructions(loaded, &body).into_bytes(),
            );
        }
        Payload::Stack(stack) => {
            let body = render_stack(stack);
            files.insert(
                instructions_path(id),
                render_instructions(loaded, &body).into_bytes(),
            );
        }
        Payload::Plugin(_) | Payload::Mcp(_) | Payload::Lsp(_) => {
            return Err(format!(
                "a `{}` item does not compile into the `.apm/` package",
                item.kind()
            ));
        }
    }
    Ok(files)
}

/// A plugin's own package: every file of the item but `item.json`, as is.
pub fn plugin_files(loaded: &LoadedItem) -> Result<BTreeMap<String, Vec<u8>>, String> {
    require(loaded, "plugin.json")?;
    Ok(content_files(loaded).collect())
}

/// Whether an item without an upstream can be vendored: it carries the
/// content its kind compiles from.
pub fn has_content(loaded: &LoadedItem) -> bool {
    match loaded.kind() {
        ItemKind::Instructions | ItemKind::Library | ItemKind::Stack => true,
        kind => kind
            .content_file()
            .is_some_and(|file| loaded.files.contains_key(file)),
    }
}

/// Where a package keeps its instructions: the directory `apm compile` reads and `apm install` leaves alone.
pub const INSTRUCTIONS_DIR: &str = ".github/instructions/";

fn instructions_path(id: &str) -> String {
    format!("{INSTRUCTIONS_DIR}{id}.instructions.md")
}

/// Every file of the item except `item.json`, text normalized to LF.
fn content_files(loaded: &LoadedItem) -> impl Iterator<Item = (String, Vec<u8>)> + '_ {
    loaded
        .files
        .iter()
        .filter(|(name, _)| name.as_str() != ITEM_JSON)
        .map(|(name, bytes)| {
            let bytes = if std::str::from_utf8(bytes).is_ok() {
                normalize_line_endings(bytes)
            } else {
                bytes.clone()
            };
            (name.clone(), bytes)
        })
}

fn require<'a>(loaded: &'a LoadedItem, file: &str) -> Result<&'a [u8], String> {
    loaded
        .files
        .get(file)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("`{}` has no {file} to compile", loaded.item.id))
}

/// Text that ShelfKit renders into a primitive (a prompt, an instructions
/// fragment): LF line endings, and a leading byte-order mark dropped, since
/// generated frontmatter must start the file. Files copied whole keep theirs.
fn text(loaded: &LoadedItem, bytes: &[u8]) -> Result<String, String> {
    let text = String::from_utf8(normalize_line_endings(bytes))
        .map_err(|_| format!("`{}`: content must be UTF-8 text", loaded.item.id))?;
    Ok(text
        .strip_prefix('\u{feff}')
        .map(str::to_owned)
        .unwrap_or(text))
}

/// Split a leading `---` YAML block off a markdown file.
fn frontmatter(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---\n").map(|i| (i, i + 5)).or_else(|| {
        rest.strip_suffix("\n---")
            .map(|yaml| (yaml.len(), rest.len()))
    })?;
    Some((&rest[..end.0], &rest[end.1..]))
}

/// What a primitive's frontmatter `description` says: the item's
/// description, or its title when it has none.
fn description(loaded: &LoadedItem) -> &str {
    let item = &loaded.item;
    if item.description.trim().is_empty() {
        item.title.trim()
    } else {
        item.description.trim()
    }
}

/// A prompt as APM reads it. A `prompt.md` with its own frontmatter is kept
/// as written; without one, the item's description (or title) and variables
/// become APM's `description` and `input`. Either way, `{{name}}` for a declared
/// variable becomes APM's `${input:name}`, which each harness rewrites.
///
/// APM surfaces every prompt as a command on the harnesses that have them,
/// so `asCommand` changes nothing in the compiled package.
fn render_prompt(description: &str, prompt: &Prompt, body: &str) -> String {
    let mut body = body.to_owned();
    for variable in &prompt.variables {
        body = body.replace(
            &format!("{{{{{}}}}}", variable.name),
            &format!("${{input:{}}}", variable.name),
        );
    }
    if frontmatter(&body).is_some() {
        return ensure_trailing_newline(body);
    }
    let mut head = String::from("---\n");
    let _ = writeln!(head, "description: {}", crate::yaml::scalar(description));
    if !prompt.variables.is_empty() {
        // APM's simple list of names, or its object list when the shelf says
        // what a variable is for.
        let described = prompt.variables.iter().any(|v| v.description.is_some());
        head.push_str("input:\n");
        for variable in &prompt.variables {
            let name = crate::yaml::scalar(&variable.name);
            if described {
                let about = variable.description.as_deref().unwrap_or_default();
                let _ = writeln!(head, "  - {name}: {}", crate::yaml::scalar(about));
            } else {
                let _ = writeln!(head, "  - {name}");
            }
        }
    }
    head.push_str("---\n\n");
    ensure_trailing_newline(head + body.trim_start_matches('\n'))
}

/// An `.instructions.md` file: APM requires a `description`, and the body
/// starts with the item's title, unless it opens with a top-level heading of
/// its own (an AGENTS.md brought in as an item), which then stands for it.
fn render_instructions(loaded: &LoadedItem, body: &str) -> String {
    let mut out = format!(
        "---\ndescription: {}\n---\n\n",
        crate::yaml::scalar(description(loaded))
    );
    let titled = body.trim_start().starts_with("# ");
    if !titled {
        let _ = writeln!(out, "# {}", loaded.item.title.trim());
    }
    if !body.is_empty() {
        if !titled {
            out.push('\n');
        }
        out.push_str(body.trim_start_matches('\n'));
    }
    ensure_trailing_newline(out)
}

fn render_sections(sections: &[Section], fragment: Option<&str>) -> String {
    let mut blocks: Vec<String> = sections
        .iter()
        .map(|s| format!("## {}\n\n{}\n", s.heading.trim(), s.body.trim()))
        .collect();
    if let Some(fragment) = fragment.map(str::trim).filter(|f| !f.is_empty()) {
        blocks.push(format!("{fragment}\n"));
    }
    blocks.join("\n")
}

fn render_library(library: &Library) -> String {
    let mut blocks = Vec::new();
    if let Some(docs) = &library.docs {
        blocks.push(format!("Documentation: {docs}\n"));
    }
    if !library.notes.is_empty() {
        let notes: String = library
            .notes
            .iter()
            .map(|note| format!("- {}\n", note.trim()))
            .collect();
        blocks.push(notes);
    }
    blocks.join("\n")
}

fn render_stack(stack: &Stack) -> String {
    render_sections(&stack.conventions, None)
}

fn ensure_trailing_newline(mut text: String) -> String {
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use shelfkit_core::item::PromptVariable;

    #[test]
    fn a_prompt_without_frontmatter_gets_apm_frontmatter() {
        let prompt = Prompt {
            as_command: true,
            variables: vec![
                PromptVariable {
                    name: "ticket".into(),
                    ..PromptVariable::default()
                },
                PromptVariable {
                    name: "audience".into(),
                    default: Some("reviewers".into()),
                    ..PromptVariable::default()
                },
            ],
        };
        let out = render_prompt(
            "Write a PR description",
            &prompt,
            "Audience: {{audience}}\nTicket: {{ticket}} {{other}}\n",
        );
        assert_eq!(
            out,
            "---\ndescription: Write a PR description\ninput:\n  - ticket\n  - audience\n---\n\n\
             Audience: ${input:audience}\nTicket: ${input:ticket} {{other}}\n"
        );
    }

    #[test]
    fn a_prompt_with_frontmatter_is_kept() {
        let body = "---\ndescription: x\n---\n\nBody\n";
        assert_eq!(render_prompt("ignored", &Prompt::default(), body), body);
    }

    #[test]
    fn frontmatter_needs_both_fences() {
        assert_eq!(frontmatter("---\na: b\n---\nrest"), Some(("a: b", "rest")));
        assert_eq!(frontmatter("---\na: b\n---"), Some(("a: b", "")));
        assert_eq!(frontmatter("no\n---\n"), None);
    }
}
