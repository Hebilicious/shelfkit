//! The docs a directory's AGENTS.md links to, for `shelfkit add <dir>` (`docs/PRD.md` section 5.2, `doc`).
//!
//! The same rule the hosted importer follows (`packages/importers/src/docs.ts`), so a repository imports the same
//! way from this machine and from GitHub: a link counts when it is a relative markdown link, inline `[x](path)` or a
//! reference definition `[x]: path`, plain or as `./path`, with or without a `#fragment`, outside a fenced code
//! block, whose target is a regular markdown file inside the directory that is not a primitive of its own
//! (`.prompt.md`, `.instructions.md`, `.agent.md`, `SKILL.md`). Links from those docs are followed too, up to
//! [`MAX_DOCS`]. A URL, an anchor, an absolute path, and a path that climbs out of the directory are ignored.

use shelfkit_core::item::validate_doc_path;
use std::collections::{BTreeSet, VecDeque};
use std::path::Path;

/// At most this many docs are followed from one AGENTS.md: the hosted importer's bound, kept here for parity.
pub const MAX_DOCS: usize = 40;

/// One doc found by following links: its path relative to the directory, and the docs it links to in turn.
#[derive(Debug, PartialEq, Eq)]
pub struct LinkedDoc {
    pub path: String,
    pub links: Vec<String>,
}

/// What following an AGENTS.md's links found.
#[derive(Debug, PartialEq, Eq)]
pub struct Followed {
    /// The docs AGENTS.md itself links to.
    pub links: Vec<String>,
    /// Every doc reached, in the order the links reach them, breadth first.
    pub docs: Vec<LinkedDoc>,
    /// Whether more docs were linked than [`MAX_DOCS`].
    pub truncated: bool,
}

/// Whether a path names a markdown file that is not a primitive of its own.
pub fn is_doc_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.ends_with(".md")
        && name != "SKILL.md"
        && ![".prompt.md", ".instructions.md", ".agent.md"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

/// The lines of a markdown text outside fenced code blocks, with inline code spans removed.
fn outside_code(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        let opening = ['`', '~']
            .into_iter()
            .find(|mark| indent <= 3 && trimmed.starts_with(&mark.to_string().repeat(3)));
        match (fence, opening) {
            (None, Some(mark)) => fence = Some(mark),
            (Some(mark), _) if trimmed.starts_with(&mark.to_string().repeat(3)) => fence = None,
            (Some(_), _) => {}
            (None, None) => lines.push(without_code_spans(line)),
        }
    }
    lines
}

fn without_code_spans(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut inside = false;
    for c in line.chars() {
        if c == '`' {
            inside = !inside;
        } else if !inside {
            out.push(c);
        }
    }
    out
}

/// A link destination as written: `<path>` unwrapped, and a title after it dropped.
fn destination(raw: &str) -> &str {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix('<') {
        return rest.split_once('>').map_or("", |(inside, _)| inside);
    }
    raw.split(char::is_whitespace).next().unwrap_or_default()
}

/// Every link destination in a markdown text, in order: inline links and reference definitions alike.
pub fn markdown_links(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    for line in outside_code(text) {
        let trimmed = line.trim_start();
        if line.len() - trimmed.len() <= 3
            && let Some(rest) = trimmed.strip_prefix('[')
            && let Some((label, target)) = rest.split_once("]:")
            && !label.is_empty()
            && !label.contains(']')
        {
            links.push(destination(target).to_owned());
            continue;
        }
        let mut rest = line.as_str();
        while let Some(at) = rest.find("](") {
            let after = &rest[at + 2..];
            let end = after.find(')').unwrap_or(after.len());
            links.push(destination(&after[..end]).to_owned());
            rest = &after[end..];
        }
    }
    links.retain(|link| !link.is_empty());
    links
}

/// `%XX` escapes decoded, or `None` when they do not decode to UTF-8.
fn percent_decoded(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The directory-relative path a link in the file at `from` points to, or `None` when it points nowhere a doc can be:
/// a URL (any scheme), an anchor, an absolute path, a query, or a path that climbs above the directory.
pub fn resolve_link(from: &str, link: &str) -> Option<String> {
    let target = link.split('#').next().unwrap_or_default();
    let scheme = target.split_once(':').is_some_and(|(scheme, _)| {
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if target.is_empty() || target.starts_with('/') || target.contains('?') || scheme {
        return None;
    }
    let decoded = percent_decoded(target)?;
    let mut segments: Vec<&str> = match from.rsplit_once('/') {
        Some((directory, _)) => directory.split('/').collect(),
        None => Vec::new(),
    };
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            segment => segments.push(segment),
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// Whether `relative` is a regular file inside `root` (a canonical path) that no symbolic link leads to.
fn regular_file(root: &Path, relative: &str) -> bool {
    let path = root.join(relative);
    std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file())
        && path.canonicalize().is_ok_and(|real| real == path)
}

/// Follow the links of `root/AGENTS.md` through every doc they reach. `root` is canonical.
pub fn follow(root: &Path) -> Followed {
    let read = |relative: &str| {
        std::fs::read(root.join(relative))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    };
    let links_of = |from: &str, text: &str| {
        let mut seen = BTreeSet::new();
        markdown_links(text)
            .iter()
            .filter_map(|link| resolve_link(from, link))
            .filter(|path| {
                path != "AGENTS.md"
                    && is_doc_file(path)
                    && validate_doc_path(path).is_ok()
                    && regular_file(root, path)
            })
            .filter(|path| seen.insert(path.clone()))
            .collect::<Vec<_>>()
    };

    let links = links_of("AGENTS.md", &read("AGENTS.md"));
    let mut queued: BTreeSet<String> = links.iter().cloned().collect();
    let mut queue: VecDeque<String> = links.iter().cloned().collect();
    let mut docs = Vec::new();
    let mut truncated = false;
    while let Some(path) = queue.pop_front() {
        if docs.len() == MAX_DOCS {
            truncated = true;
            break;
        }
        let found = links_of(&path, &read(&path));
        for link in &found {
            if queued.insert(link.clone()) {
                queue.push_back(link.clone());
            }
        }
        docs.push(LinkedDoc { path, links: found });
    }
    Followed {
        links,
        docs,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_inline_or_reference_definitions_outside_code() {
        assert_eq!(
            markdown_links(
                "[a](x.md) and [b](<y z.md>) `[c](no.md)`\n[d]: ./w.md \"W\"\n```\n[e](fenced.md)\n```\n"
            ),
            ["x.md", "y z.md", "./w.md"]
        );
    }

    #[test]
    fn a_link_resolves_from_its_file_and_never_leaves_the_directory() {
        assert_eq!(
            resolve_link("docs/a.md", "b.md#part").as_deref(),
            Some("docs/b.md")
        );
        assert_eq!(
            resolve_link("docs/a.md", "../GLOSSARY.md").as_deref(),
            Some("GLOSSARY.md")
        );
        assert_eq!(
            resolve_link("AGENTS.md", "./docs/a%20b.md").as_deref(),
            Some("docs/a b.md")
        );
        for link in [
            "../outside.md",
            "/docs/a.md",
            "https://example.com/a.md",
            "mailto:a@example.com",
            "#anchor",
            "a.md?raw=1",
        ] {
            assert_eq!(resolve_link("AGENTS.md", link), None, "{link}");
        }
    }

    #[test]
    fn primitives_are_no_docs() {
        assert!(is_doc_file("docs/GLOSSARY.md"));
        for path in [
            "a.prompt.md",
            "b.instructions.md",
            "c.agent.md",
            "s/SKILL.md",
            "x.txt",
        ] {
            assert!(!is_doc_file(path), "{path}");
        }
    }
}
