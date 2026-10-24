//! Profile resolution (`docs/PRD.md` section 5.3).
//!
//! 1. Each profile's own entries are its `items`, then the items of its
//!    `bundles` in order: bundles expand before `extends`.
//! 2. `extends` composes profiles breadth-first from the profile being
//!    resolved, and the first profile in that order to select an item, or to
//!    set a compile setting, wins. Children come before parents, so children
//!    win.
//! 3. `requires` pulls each selected item's requirements in, transitively.
//! 4. Items that would produce the same compiled output conflict, and a
//!    conflict is an error rather than a last-writer-wins.
//!
//! The result does not depend on the order of `items`, of files on disk, or
//! of map iteration: items come out sorted by id, and the profile revision is
//! a hash of that sorted list and the resolved compile settings.

use crate::error::{Error, ErrorKind};
use crate::item::{ItemKind, Payload};
use crate::profile::{ItemRef, OnConflict, Pin, Profile};
use crate::revision::Revision;
use crate::shelf::{Notice, NoticeCode, Shelf};
use crate::target::{self, TargetClass};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// A profile with `bundles`, `extends`, and `requires` expanded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProfile {
    pub id: String,
    /// The profile file, relative to the shelf root.
    pub path: String,
    /// A hash of `compile` and of every item's id and revision, sorted.
    /// Title and description are not part of it: they change no output.
    pub revision: Revision,
    pub compile: CompileSettings,
    /// Sorted by id.
    pub items: Vec<ResolvedItem>,
    /// What the compiler must pass on to the user for this profile.
    pub notices: Vec<Notice>,
}

/// Compile settings after `extends`, with defaults filled in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileSettings {
    pub name: String,
    /// Sorted. Empty means the manifest leaves `targets` out and APM
    /// detects them.
    pub targets: Vec<String>,
    pub pin: Pin,
    pub on_conflict: OnConflict,
    pub vendor_authored: bool,
    pub allow_nonconformant_targets: bool,
}

/// One item in a resolved profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedItem {
    pub id: String,
    pub kind: ItemKind,
    /// The revision this profile compiles. A pin must name the revision the
    /// source holds (the load checks it), so this is the content compiled
    /// whether the item is pinned or not, and the profile revision covers it.
    pub revision: Revision,
    /// The item's revision in the shelf as loaded. Equal to `revision` for a
    /// shelf loaded from files; a source that serves older snapshots could
    /// make them differ.
    pub current: Revision,
    pub pinned: bool,
    pub origin: Origin,
}

/// Why an item is in a resolved profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "via", rename_all = "kebab-case")]
pub enum Origin {
    /// Listed in `items` of this profile or one it extends.
    Profile { profile: String },
    /// Listed in a bundle that profile names.
    Bundle { profile: String, bundle: String },
    /// Required by another selected item.
    Requires { item: String },
}

impl Origin {
    /// The file that put the item in the profile.
    pub fn declared_in(&self) -> String {
        match self {
            Self::Profile { profile } => format!("profiles/{profile}.json"),
            Self::Bundle { bundle, .. } => format!("bundles/{bundle}.json"),
            Self::Requires { item } => format!("<item {item}>"),
        }
    }
}

pub(crate) fn resolve(shelf: &Shelf, id: &str) -> Result<ResolvedProfile, Vec<Error>> {
    let Some(root) = shelf.profiles.get(id) else {
        return Err(vec![Shelf::unknown_profile(id)]);
    };
    let path = format!("profiles/{id}.json");

    let order = breadth_first(&shelf.profiles, id);

    // Selected items, first profile in breadth-first order wins.
    let mut chosen: BTreeMap<String, (Option<Revision>, Origin)> = BTreeMap::new();
    for profile_id in &order {
        let Some(profile) = shelf.profiles.get(profile_id) else {
            continue;
        };
        let own = profile
            .items
            .iter()
            .map(|entry| {
                let origin = Origin::Profile {
                    profile: profile_id.clone(),
                };
                (entry, origin)
            })
            .chain(profile.bundles.iter().flat_map(|bundle_id| {
                shelf
                    .bundles
                    .get(bundle_id)
                    .map(|bundle| bundle.items.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .map(move |entry| {
                        let origin = Origin::Bundle {
                            profile: profile_id.clone(),
                            bundle: bundle_id.clone(),
                        };
                        (entry, origin)
                    })
            }));
        for (ItemRef { id, revision }, origin) in own {
            chosen
                .entry(id.clone())
                .or_insert_with(|| (revision.clone(), origin));
        }
    }

    // `requires`, transitively, in sorted order so the origin recorded for an
    // item required twice does not depend on iteration order.
    let mut queue: VecDeque<String> = chosen.keys().cloned().collect();
    while let Some(item_id) = queue.pop_front() {
        let Some(loaded) = shelf.items.get(&item_id) else {
            continue;
        };
        let mut requires = loaded.item.requires.clone();
        requires.sort();
        for required in requires {
            if !chosen.contains_key(&required) {
                chosen.insert(
                    required.clone(),
                    (
                        None,
                        Origin::Requires {
                            item: item_id.clone(),
                        },
                    ),
                );
                queue.push_back(required);
            }
        }
    }

    let compile = settings(&shelf.profiles, id);

    let mut items = Vec::new();
    let mut notices = Vec::new();
    for (item_id, (pin, origin)) in chosen {
        let Some(loaded) = shelf.items.get(&item_id) else {
            continue;
        };
        if loaded.kind() == ItemKind::Lsp {
            notices.push(Notice {
                path: path.clone(),
                code: NoticeCode::UnratifiedLsp,
                message: format!(
                    "`{item_id}` compiles to `dependencies.lsp`, which is absent from the \
                     published OpenAPM v0.1 schema: it passes validation without being defined by it"
                ),
            });
        }
        notices.extend(crate::skill::notices(loaded));
        items.push(ResolvedItem {
            id: item_id,
            kind: loaded.kind(),
            current: loaded.revision.clone(),
            pinned: pin.is_some(),
            revision: pin.unwrap_or_else(|| loaded.revision.clone()),
            origin,
        });
    }

    for slug in &compile.targets {
        if target::classify(slug) == Ok(TargetClass::CliOnly) {
            notices.push(Notice {
                path: path.clone(),
                code: NoticeCode::ProducerNonconformantTarget,
                message: format!(
                    "target `{slug}` is outside the OpenAPM v0.1 producer set, so this \
                     profile's manifest is Producer-nonconformant (opted in)"
                ),
            });
        }
    }
    notices.sort();

    let conflicts = conflicts(shelf, &path, &items);
    if !conflicts.is_empty() {
        return Err(conflicts);
    }

    Ok(ResolvedProfile {
        id: root.id.clone(),
        revision: profile_revision(&compile, &items),
        path,
        compile,
        items,
        notices,
    })
}

/// The profile itself, then its parents level by level, each once.
fn breadth_first(profiles: &BTreeMap<String, Profile>, id: &str) -> Vec<String> {
    let mut order = Vec::new();
    let mut seen = BTreeSet::from([id.to_owned()]);
    let mut queue = VecDeque::from([id.to_owned()]);
    while let Some(current) = queue.pop_front() {
        if let Some(profile) = profiles.get(&current) {
            for parent in &profile.extends {
                if seen.insert(parent.clone()) {
                    queue.push_back(parent.clone());
                }
            }
        }
        order.push(current);
    }
    order
}

/// A profile's compile settings after `extends`: each setting from the first
/// profile in breadth-first order that sets it, then the defaults.
pub(crate) fn settings(profiles: &BTreeMap<String, Profile>, id: &str) -> CompileSettings {
    let options: Vec<_> = breadth_first(profiles, id)
        .iter()
        .filter_map(|profile| profiles.get(profile))
        .map(|profile| &profile.compile)
        .collect();
    macro_rules! first {
        ($field:ident) => {
            options.iter().find_map(|o| o.$field.clone())
        };
    }
    // Sorted and deduplicated: the order targets are listed in changes
    // nothing APM does, so it must not change a revision either.
    let mut targets = first!(targets).unwrap_or_default();
    targets.sort();
    targets.dedup();
    CompileSettings {
        name: first!(name).unwrap_or_else(|| id.to_owned()),
        targets,
        pin: first!(pin).unwrap_or_default(),
        on_conflict: first!(on_conflict).unwrap_or_default(),
        vendor_authored: first!(vendor_authored).unwrap_or(true),
        allow_nonconformant_targets: first!(allow_nonconformant_targets).unwrap_or(false),
    }
}

/// The compiled outputs an item claims, for conflict detection. Ids are
/// unique, so vendored files (named by id) and relayed MCP tools
/// (`<item>__<tool>`) cannot collide; what can collide is a name the item
/// declares, and an upstream it references.
fn outputs(shelf: &Shelf, id: &str) -> Vec<String> {
    let Some(loaded) = shelf.items.get(id) else {
        return Vec::new();
    };
    let mut claims = Vec::new();
    match &loaded.item.payload {
        Payload::Mcp(mcp) => {
            if let Some(name) = mcp.name() {
                claims.push(format!("the MCP server `{name}`"));
            }
        }
        Payload::Lsp(lsp) => claims.push(format!("the LSP server `{}`", lsp.name)),
        _ => {}
    }
    if let Some(source) = &loaded.item.source
        && let (Some(upstream), Some(path)) = (
            source.repo.as_ref().or(source.url.as_ref()),
            source.path.as_ref(),
        )
    {
        claims.push(format!(
            "the upstream `{}/{}`",
            upstream.trim_end_matches('/'),
            path.trim_start_matches('/')
        ));
    }
    claims
}

fn conflicts(shelf: &Shelf, path: &str, items: &[ResolvedItem]) -> Vec<Error> {
    let mut claimed: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for item in items {
        let item_json = shelf
            .items
            .get(&item.id)
            .map(|loaded| loaded.item_json())
            .unwrap_or_default();
        for output in outputs(shelf, &item.id) {
            claimed
                .entry(output)
                .or_default()
                .push((item.id.clone(), item_json.clone()));
        }
    }
    claimed
        .into_iter()
        .filter(|(_, items)| items.len() > 1)
        .map(|(output, items)| Error::new(path, ErrorKind::Conflict { output, items }))
        .collect()
}

fn profile_revision(compile: &CompileSettings, items: &[ResolvedItem]) -> Revision {
    #[derive(Serialize)]
    struct Canonical<'a> {
        compile: &'a CompileSettings,
        items: Vec<(&'a str, &'a Revision)>,
    }
    let canonical = Canonical {
        compile,
        items: items
            .iter()
            .map(|item| (item.id.as_str(), &item.revision))
            .collect(),
    };
    // A struct of strings and lists always serializes.
    let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    Revision::compute([("profile.json", bytes.as_slice())])
}

#[cfg(test)]
mod tests {
    use crate::error::ErrorKind;
    use crate::{MemorySource, load};

    fn shelf_with(profiles: &[(&str, &str)]) -> MemorySource {
        let mut source: MemorySource = [
            ("shelf.json", r#"{ "name": "t" }"#),
            (
                "items/mcp/one/item.json",
                r#"{ "id": "one", "kind": "mcp", "title": "One", "flavour": "remote", "name": "io.example/ctx", "url": "https://a.example/mcp" }"#,
            ),
            (
                "items/mcp/two/item.json",
                r#"{ "id": "two", "kind": "mcp", "title": "Two", "flavour": "stdio", "name": "io.example/ctx", "command": "ctx" }"#,
            ),
            (
                "items/prompts/a/item.json",
                r#"{ "id": "a", "kind": "prompt", "title": "A", "source": { "repo": "https://github.com/o/r", "path": "p/x.prompt.md", "ref": "v1" } }"#,
            ),
            (
                "items/prompts/b/item.json",
                r#"{ "id": "b", "kind": "prompt", "title": "B", "source": { "repo": "https://github.com/o/r/", "path": "/p/x.prompt.md", "ref": "v2" } }"#,
            ),
        ]
        .into_iter()
        .collect();
        for (path, json) in profiles {
            source.insert(*path, *json);
        }
        source
    }

    #[test]
    fn two_items_with_one_mcp_name_conflict_in_a_profile() {
        let source = shelf_with(&[(
            "profiles/p.json",
            r#"{ "id": "p", "title": "P", "items": ["one", "two"] }"#,
        )]);
        let errors = load(&source).unwrap_err();
        let error = errors.iter().next().unwrap();
        assert_eq!(error.path, "profiles/p.json");
        assert!(matches!(error.kind, ErrorKind::Conflict { .. }));
        assert_eq!(
            error.to_string(),
            "profiles/p.json: items `one` (items/mcp/one/item.json) and `two` \
             (items/mcp/two/item.json) all compile to the MCP server `io.example/ctx`"
        );
    }

    #[test]
    fn a_conflict_reached_through_extends_names_the_profile_resolved() {
        let source = shelf_with(&[
            (
                "profiles/p.json",
                r#"{ "id": "p", "title": "P", "items": ["a"] }"#,
            ),
            (
                "profiles/q.json",
                r#"{ "id": "q", "title": "Q", "items": ["b"], "extends": ["p"] }"#,
            ),
        ]);
        let errors = load(&source).unwrap_err();
        let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert!(
            messages[0].starts_with("profiles/q.json: items `a`"),
            "{messages:?}"
        );
        assert!(messages[0].contains("the upstream `https://github.com/o/r/p/x.prompt.md`"));
    }

    #[test]
    fn items_that_never_share_a_profile_do_not_conflict() {
        let source = shelf_with(&[
            (
                "profiles/p.json",
                r#"{ "id": "p", "title": "P", "items": ["one", "a"] }"#,
            ),
            (
                "profiles/q.json",
                r#"{ "id": "q", "title": "Q", "items": ["two", "b"] }"#,
            ),
        ]);
        assert!(load(&source).is_ok());
    }
}
