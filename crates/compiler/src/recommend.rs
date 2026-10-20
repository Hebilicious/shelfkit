//! `shelfkit recommend`: propose items and profiles from a repository's stack
//! markers (`docs/PRD.md` sections 4.1 and 5.2).
//!
//! A stack's `markers`, a library's `detect`, and an instructions item's
//! `markers` are matched against what the repository shows: files at its
//! root, package names in its dependency manifests, and its package manager.
//! An item matches when any one marker does. A matched stack brings the items
//! it `recommends`. A profile is proposed when it selects a recommended item.

use serde::Serialize;
use shelfkit_core::item::Markers;
use shelfkit_core::{ItemKind, Payload, Shelf};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    /// Sorted by id.
    pub items: Vec<RecommendedItem>,
    /// Sorted by id.
    pub profiles: Vec<RecommendedProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedItem {
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    /// The repository's markers this item matched; empty when it is only
    /// recommended by a stack.
    pub matched: Markers,
    /// The matched stacks that recommend it.
    pub recommended_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendedProfile {
    pub id: String,
    pub title: String,
    /// The recommended items the profile selects.
    pub items: Vec<String>,
}

pub fn recommend(shelf: &Shelf, repository: &Markers) -> Recommendation {
    let mut found: BTreeMap<String, (Markers, BTreeSet<String>)> = BTreeMap::new();
    for (id, loaded) in &shelf.items {
        let markers = match &loaded.item.payload {
            Payload::Stack(stack) => Some(&stack.markers),
            Payload::Library(library) => library.detect.as_ref(),
            Payload::Instructions(instructions) => instructions.markers.as_ref(),
            _ => None,
        };
        let Some(matched) = markers
            .map(|m| matched(m, repository))
            .filter(|m| !m.is_empty())
        else {
            continue;
        };
        found.entry(id.clone()).or_default().0 = matched;
        if let Payload::Stack(stack) = &loaded.item.payload {
            for recommended in &stack.recommends {
                found
                    .entry(recommended.clone())
                    .or_default()
                    .1
                    .insert(id.clone());
            }
        }
    }

    let items: Vec<RecommendedItem> = found
        .into_iter()
        .filter_map(|(id, (matched, by))| {
            let loaded = shelf.items.get(&id)?;
            Some(RecommendedItem {
                kind: loaded.kind(),
                title: loaded.item.title.clone(),
                id,
                matched,
                recommended_by: by.into_iter().collect(),
            })
        })
        .collect();
    let wanted: BTreeSet<&str> = items.iter().map(|item| item.id.as_str()).collect();

    let profiles = shelf
        .profiles
        .iter()
        .filter_map(|(id, profile)| {
            let resolved = shelf.resolve(id).ok()?;
            let selected: Vec<String> = resolved
                .items
                .iter()
                .filter(|item| wanted.contains(item.id.as_str()))
                .map(|item| item.id.clone())
                .collect();
            (!selected.is_empty()).then(|| RecommendedProfile {
                id: id.clone(),
                title: profile.title.clone(),
                items: selected,
            })
        })
        .collect();

    Recommendation { items, profiles }
}

/// The markers of `item` the repository shows.
fn matched(item: &Markers, repository: &Markers) -> Markers {
    let common = |a: &[String], b: &[String]| -> Vec<String> {
        a.iter().filter(|x| b.contains(x)).cloned().collect()
    };
    // `pnpm@11.8.0` in `packageManager` is the manager `pnpm`.
    let manager = |m: &Option<String>| {
        m.as_deref()
            .map(|m| m.split('@').next().unwrap_or(m).to_owned())
    };
    Markers {
        files: common(&item.files, &repository.files),
        dependencies: common(&item.dependencies, &repository.dependencies),
        package_manager: manager(&item.package_manager)
            .filter(|m| manager(&repository.package_manager).as_ref() == Some(m)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shelfkit_core::{DirSource, load};
    use std::path::Path;

    #[test]
    fn a_matched_stack_brings_what_it_recommends() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/all-kinds");
        let shelf = load(&DirSource::new(root)).unwrap();
        let repository = Markers {
            files: vec!["wrangler.jsonc".into()],
            dependencies: vec!["vue".into()],
            package_manager: Some("pnpm@11.8.0".into()),
        };
        let found = recommend(&shelf, &repository);
        let ids: Vec<&str> = found.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            ["context7", "drizzle", "vue-cloudflare", "vue-sfc-patterns"]
        );
        let stack = &found.items[2];
        assert_eq!(stack.matched.package_manager.as_deref(), Some("pnpm"));
        assert_eq!(found.items[1].recommended_by, ["vue-cloudflare"]);
        assert!(
            found.items[1].matched.is_empty(),
            "drizzle-orm is not a dependency here"
        );
        let profiles: Vec<&str> = found.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(profiles, ["base", "full"]);
    }
}
