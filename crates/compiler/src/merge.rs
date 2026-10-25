//! Fitting a compiled manifest into a repository that already has an
//! `apm.yml`, honouring the profile's `onConflict` (`docs/PRD.md` section 5.3).
//!
//! The repository's manifest is the base. What the compiler declares is
//! added to it, declaration by declaration:
//!
//! - `name` and `version` are the repository's identity: an existing value is
//!   kept, and the compiled one is used only when there is none.
//! - `targets`, each `registries` entry, and each `dependencies.apm`, `.mcp`,
//!   and `.lsp` entry is a declaration. One the repository does not have is
//!   appended. One it has identically is left alone. One it declares
//!   differently, by the same identity, is a conflict: `fail` stops so a
//!   human decides, `shelf-wins` replaces the repository's declaration, and
//!   `local-wins` keeps it and drops the shelf's. Never a partial merge of one
//!   declaration.
//! - `compilation` is merged key by key: the settings the compiler makes
//!   (how instructions go into AGENTS.md) replace the repository's own, and
//!   every other setting it has is kept.
//! - Everything else in the repository's manifest (its own dependencies,
//!   `scripts`, the `executables` that `apm approve` writes, `x-` keys) is
//!   kept, in its order. The exception is a package ShelfKit vendored for
//!   this profile (its `apm.yml` carries the ownership marker; the caller
//!   passes those it found): an entry for one the compile no longer writes
//!   is removed with the package.
//!
//! A dependency's identity ignores its ref: `o/r#v1` and `o/r#v2` are one
//! dependency declared two ways.

use crate::yaml::{self, Node};
use shelfkit_core::OnConflict;
use std::collections::BTreeSet;

/// The merged manifest, and every conflict it resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    pub text: String,
    /// Each declaration that differed, as `` `dependencies.mcp` entry `x` ``.
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeError {
    /// The existing `apm.yml` is not a YAML mapping APM could read.
    Unreadable(String),
    /// `onConflict: fail`, and these declarations differ.
    Conflicts(Vec<String>),
}

/// Merge `compiled` into `existing`. `owned` names the package directories
/// (`vendor/<name>`) that carry ShelfKit's marker for the profile compiled.
/// With `fail`, any conflict is an error.
pub fn merge(
    existing: &str,
    compiled: &str,
    owned: &BTreeSet<String>,
    on_conflict: OnConflict,
) -> Result<Merged, MergeError> {
    let Node::Map(mut base) = Node::parse(existing).map_err(MergeError::Unreadable)? else {
        return Err(MergeError::Unreadable(
            "the top level must be a mapping".to_owned(),
        ));
    };
    let Node::Map(ours) = Node::parse(compiled).map_err(MergeError::Unreadable)? else {
        return Err(MergeError::Unreadable(
            "the compiled manifest is not a mapping".to_owned(),
        ));
    };

    let mut merger = Merger {
        on_conflict,
        owned,
        conflicts: Vec::new(),
    };
    for (key, value) in ours {
        match key.as_str() {
            "name" | "version" => {
                if get(&base, &key).is_none() {
                    base.push((key, value));
                }
            }
            "targets" => merger.targets(&mut base, value),
            "compilation" => overlay(take_or_insert(&mut base, &key), value),
            "registries" | "dependencies" => {
                let block = take_or_insert(&mut base, &key);
                merger.block(&key, block, value);
            }
            _ => set(&mut base, key, value),
        }
    }

    if on_conflict == OnConflict::Fail && !merger.conflicts.is_empty() {
        return Err(MergeError::Conflicts(merger.conflicts));
    }
    Ok(Merged {
        text: yaml::render(&Node::Map(base)),
        conflicts: merger.conflicts,
    })
}

struct Merger<'a> {
    on_conflict: OnConflict,
    owned: &'a BTreeSet<String>,
    conflicts: Vec<String>,
}

impl Merger<'_> {
    /// Record a conflict; `true` when the shelf's declaration replaces the
    /// repository's.
    fn conflict(&mut self, what: String) -> bool {
        self.conflicts.push(what);
        self.on_conflict == OnConflict::ShelfWins
    }

    fn targets(&mut self, base: &mut Vec<(String, Node)>, ours: Node) {
        let existing = ["targets", "target"]
            .into_iter()
            .find_map(|key| get(base, key).map(|value| (key, target_set(value))));
        match existing {
            None => base.push(("targets".to_owned(), ours)),
            Some((_, theirs)) if theirs == target_set(&ours) => {}
            Some((key, _)) => {
                if self.conflict("`targets`".to_owned()) {
                    // `target` and `targets` may not both appear.
                    let position = base
                        .iter()
                        .position(|(k, _)| k == key)
                        .unwrap_or(base.len());
                    base.retain(|(k, _)| k != key);
                    base.insert(position.min(base.len()), ("targets".to_owned(), ours));
                }
            }
        }
    }

    /// `registries` (entries by name) or `dependencies` (lists by key).
    fn block(&mut self, key: &str, base: &mut Node, ours: Node) {
        let Node::Map(ours) = ours else { return };
        if !matches!(base, Node::Map(_)) {
            *base = Node::Map(Vec::new());
        }
        let Node::Map(entries) = base else { return };
        for (name, value) in ours {
            if key == "registries" {
                match get(entries, &name) {
                    None => entries.push((name, value)),
                    Some(existing) if *existing == value => {}
                    Some(_) => {
                        if self.conflict(format!("`registries.{name}`")) {
                            set(entries, name, value);
                        }
                    }
                }
            } else {
                let list = take_or_insert(entries, &name);
                self.list(&format!("dependencies.{name}"), list, value);
            }
        }
    }

    fn list(&mut self, location: &str, base: &mut Node, ours: Node) {
        let Node::Seq(ours) = ours else { return };
        if !matches!(base, Node::Seq(_)) {
            *base = Node::Seq(Vec::new());
        }
        let Node::Seq(items) = base else { return };
        if location == "dependencies.apm" {
            let compiled: Vec<_> = ours.iter().map(|entry| identity(location, entry)).collect();
            let owned = self.owned;
            items.retain(|item| {
                let (kind, name) = identity(location, item);
                let ours_once = kind == "path" && owned.contains(&name);
                !ours_once || compiled.contains(&(kind, name))
            });
        }
        for entry in ours {
            let key = identity(location, &entry);
            match items
                .iter()
                .position(|item| identity(location, item) == key)
            {
                None => items.push(entry),
                Some(index) if items[index] == entry => {}
                Some(index) => {
                    if self.conflict(format!("`{location}` entry `{}`", key.1)) {
                        items[index] = entry;
                    }
                }
            }
        }
    }
}

/// `ours` laid over `base`: a map key by key, recursively, and anything else replaced.
fn overlay(base: &mut Node, ours: Node) {
    match (base, ours) {
        (Node::Map(entries), Node::Map(ours)) => {
            for (key, value) in ours {
                overlay(take_or_insert(entries, &key), value);
            }
        }
        (slot, value) => *slot = value,
    }
}

fn get<'a>(entries: &'a [(String, Node)], key: &str) -> Option<&'a Node> {
    entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn set(entries: &mut Vec<(String, Node)>, key: String, value: Node) {
    match entries.iter_mut().find(|(k, _)| *k == key) {
        Some((_, slot)) => *slot = value,
        None => entries.push((key, value)),
    }
}

/// The value under `key`, appended as an empty map when absent.
fn take_or_insert<'a>(entries: &'a mut Vec<(String, Node)>, key: &str) -> &'a mut Node {
    let index = match entries.iter().position(|(k, _)| k == key) {
        Some(index) => index,
        None => {
            entries.push((key.to_owned(), Node::Null));
            entries.len() - 1
        }
    };
    &mut entries[index].1
}

/// Targets as a set: a list, a single slug, or the legacy comma-separated
/// `target` string.
fn target_set(value: &Node) -> BTreeSet<String> {
    match value {
        Node::Seq(items) => items
            .iter()
            .filter_map(Node::as_str)
            .map(str::to_owned)
            .collect(),
        Node::String(text) => text
            .split(',')
            .map(|slug| slug.trim().to_owned())
            .filter(|slug| !slug.is_empty())
            .collect(),
        _ => BTreeSet::new(),
    }
}

/// What makes two entries of a list the same declaration: `(kind, name)`.
fn identity(location: &str, entry: &Node) -> (&'static str, String) {
    if location != "dependencies.apm" {
        // MCP and LSP servers are named, in the string form or by `name`.
        let name = entry
            .as_str()
            .or_else(|| entry.get("name").and_then(Node::as_str))
            .unwrap_or_default();
        return ("server", name.to_owned());
    }
    match entry {
        Node::String(text) => apm_identity(text, None),
        Node::Map(_) => {
            let field = |key: &str| entry.get(key).and_then(Node::as_str);
            if let Some(git) = field("git") {
                apm_identity(git, field("path"))
            } else if let Some(id) = field("id") {
                let path = field("path")
                    .map(|p| format!("/{}", p.trim_matches('/')))
                    .unwrap_or_default();
                ("registry", format!("{id}{path}"))
            } else if let Some(name) = field("marketplace") {
                (
                    "marketplace",
                    format!("{name}/{}", field("name").unwrap_or_default()),
                )
            } else if let Some(path) = field("path") {
                ("path", local_path(path))
            } else {
                ("other", yaml::render(entry))
            }
        }
        other => ("other", yaml::render(other)),
    }
}

/// A string-form or `git:` reference without its ref, its scheme, `.git`, or
/// the default host, so every spelling of one dependency compares equal.
fn apm_identity(text: &str, subpath: Option<&str>) -> (&'static str, String) {
    let without_ref = text.split('#').next().unwrap_or_default();
    if ["./", "../", "/", "~/", ".\\", "..\\", "~\\"]
        .iter()
        .any(|prefix| without_ref.starts_with(prefix))
    {
        return ("path", local_path(without_ref));
    }
    let mut rest = without_ref;
    for scheme in ["https://", "http://", "ssh://git@", "git@"] {
        if let Some(stripped) = rest.strip_prefix(scheme) {
            rest = stripped;
        }
    }
    let rest = rest.replacen(':', "/", usize::from(without_ref.starts_with("git@")));
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let segments: Vec<&str> = rest.split('/').collect();
    let has_host = segments.len() > 2 && segments[0].contains('.');
    let (host, path) = if has_host {
        (segments[0].to_ascii_lowercase(), &segments[1..])
    } else {
        ("github.com".to_owned(), &segments[..])
    };
    let mut identity = if host == "github.com" {
        // GitHub owners and repositories are case-insensitive; paths are not.
        path.iter()
            .enumerate()
            .map(|(i, s)| {
                if i < 2 {
                    s.to_ascii_lowercase()
                } else {
                    (*s).to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("/")
    } else {
        format!("{host}/{}", path.join("/"))
    };
    if let Some(subpath) = subpath {
        identity.push('/');
        identity.push_str(subpath.trim_matches('/'));
    }
    ("git", identity)
}

fn local_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.strip_prefix("./").unwrap_or(&path);
    path.trim_end_matches('/').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> BTreeSet<String> {
        BTreeSet::new()
    }

    const COMPILED: &str = "name: shelf\nversion: \"0.0.0\"\ntargets:\n  - claude\ndependencies:\n  apm:\n    \
        - o/r/skills/a#v2\n    - ./vendor/p\n  mcp:\n    - io.github.x/y\n";

    #[test]
    fn a_repository_without_declarations_takes_the_compiled_ones() {
        let merged = merge(
            "name: my-app\nversion: 1.2.0\n",
            COMPILED,
            &none(),
            OnConflict::Fail,
        )
        .unwrap();
        assert_eq!(
            merged.text,
            "name: my-app\nversion: \"1.2.0\"\ntargets:\n  - claude\ndependencies:\n  apm:\n    \
             - o/r/skills/a#v2\n    - ./vendor/p\n  mcp:\n    - io.github.x/y\n"
        );
        assert!(merged.conflicts.is_empty());
    }

    #[test]
    fn merging_twice_changes_nothing() {
        let once = merge(
            "name: my-app\nversion: 1.2.0\n",
            COMPILED,
            &none(),
            OnConflict::Fail,
        )
        .unwrap();
        let twice = merge(&once.text, COMPILED, &none(), OnConflict::Fail).unwrap();
        assert_eq!(once.text, twice.text);
        assert_eq!(
            merge(COMPILED, COMPILED, &none(), OnConflict::Fail)
                .unwrap()
                .text,
            COMPILED
        );
    }

    #[test]
    fn local_declarations_and_keys_are_kept_in_order() {
        let existing = "name: my-app\nversion: 1.2.0\nscripts:\n  lint: x\ndependencies:\n  apm:\n    \
            - acme/standards\nexecutables:\n  allow:\n    - ./vendor/p\n";
        let merged = merge(existing, COMPILED, &none(), OnConflict::Fail).unwrap();
        assert_eq!(
            merged.text,
            "name: my-app\nversion: \"1.2.0\"\nscripts:\n  lint: x\ndependencies:\n  apm:\n    - acme/standards\n    \
             - o/r/skills/a#v2\n    - ./vendor/p\n  mcp:\n    - io.github.x/y\nexecutables:\n  allow:\n    \
             - ./vendor/p\ntargets:\n  - claude\n"
        );
    }

    #[test]
    fn the_same_dependency_at_another_ref_is_a_conflict() {
        let existing = "name: my-app\nversion: 1.2.0\ndependencies:\n  apm:\n    - https://github.com/O/R/skills/a#v1\n";
        let Err(MergeError::Conflicts(conflicts)) =
            merge(existing, COMPILED, &none(), OnConflict::Fail)
        else {
            panic!("fail should stop the merge");
        };
        assert_eq!(conflicts, vec!["`dependencies.apm` entry `o/r/skills/a`"]);

        let shelf = merge(existing, COMPILED, &none(), OnConflict::ShelfWins).unwrap();
        assert!(shelf.text.contains("- o/r/skills/a#v2\n"), "{}", shelf.text);
        assert!(!shelf.text.contains("#v1"), "{}", shelf.text);

        let local = merge(existing, COMPILED, &none(), OnConflict::LocalWins).unwrap();
        assert!(local.text.contains("#v1"), "{}", local.text);
        assert!(!local.text.contains("#v2"), "{}", local.text);
        assert_eq!(local.conflicts.len(), 1);
    }

    #[test]
    fn servers_conflict_by_name_and_targets_as_a_set() {
        let existing = "name: a\nversion: 1.0.0\ntarget: claude, copilot\ndependencies:\n  mcp:\n    \
            - name: io.github.x/y\n      tools: [a]\n";
        let Err(MergeError::Conflicts(conflicts)) =
            merge(existing, COMPILED, &none(), OnConflict::Fail)
        else {
            panic!("expected conflicts");
        };
        assert_eq!(
            conflicts,
            vec!["`targets`", "`dependencies.mcp` entry `io.github.x/y`"]
        );
        let shelf = merge(existing, COMPILED, &none(), OnConflict::ShelfWins).unwrap();
        assert!(
            shelf
                .text
                .starts_with("name: a\nversion: \"1.0.0\"\ntargets:\n  - claude\n"),
            "{}",
            shelf.text
        );
        assert!(!shelf.text.contains("target:"), "{}", shelf.text);

        let same = "name: a\nversion: 1.0.0\ntargets: [claude]\n";
        assert!(merge(same, COMPILED, &none(), OnConflict::Fail).is_ok());
    }

    #[test]
    fn a_dropped_package_leaves_only_when_shelfkit_owns_it() {
        // Named like the profile's packages but not marked as ShelfKit's: kept.
        let existing =
            "name: a\nversion: 1.0.0\ndependencies:\n  apm:\n    - ./vendor/p--plugin-old\n";
        let kept = merge(existing, COMPILED, &none(), OnConflict::Fail).unwrap();
        assert!(kept.text.contains("p--plugin-old"), "{}", kept.text);
    }

    #[test]
    fn a_vendored_package_the_compile_dropped_leaves_with_it() {
        let existing = "name: a\nversion: 1.0.0\ndependencies:\n  apm:\n    - ./vendor/p--plugin-old\n    \
            - ./vendor/other\n    - ./vendor/p\n";
        let owned = BTreeSet::from(["vendor/p--plugin-old".to_owned(), "vendor/p".to_owned()]);
        let merged = merge(existing, COMPILED, &owned, OnConflict::Fail).unwrap();
        assert!(!merged.text.contains("p--plugin-old"), "{}", merged.text);
        assert!(
            merged.text.contains("- ./vendor/other\n"),
            "{}",
            merged.text
        );
        assert_eq!(
            merged.text.matches("./vendor/p\n").count(),
            1,
            "{}",
            merged.text
        );
    }

    #[test]
    fn an_unreadable_manifest_is_refused() {
        assert!(matches!(
            merge("- a\n", COMPILED, &none(), OnConflict::Fail),
            Err(MergeError::Unreadable(_))
        ));
        assert!(matches!(
            merge("a: [\n", COMPILED, &none(), OnConflict::Fail),
            Err(MergeError::Unreadable(_))
        ));
    }

    #[test]
    fn compilation_settings_are_laid_over_the_repositorys_own() {
        let existing = "name: app\ncompilation:\n  output: AGENTS.md\n  agents_md:\n    mode: full\n    start_marker: \"<!-- a -->\"\n";
        let compiled = "name: shelf\ncompilation:\n  strategy: single-file\n  agents_md:\n    mode: managed_section\n";
        let merged = merge(existing, compiled, &none(), OnConflict::Fail).unwrap();
        assert_eq!(
            merged.text,
            "name: app\ncompilation:\n  output: AGENTS.md\n  agents_md:\n    mode: managed_section\n    start_marker: \"<!-- a -->\"\n  strategy: single-file\n"
        );
        assert!(merged.conflicts.is_empty());
    }
}
