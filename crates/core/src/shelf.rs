//! A loaded shelf, and the notices `check` reports.

use crate::error::{Error, Errors};
use crate::item::{Item, ItemKind};
use crate::profile::{Bundle, Manifest, Profile};
use crate::resolve::ResolvedProfile;
use crate::revision::Revision;
use serde::Serialize;
use std::collections::BTreeMap;

/// A shelf that loaded and validated completely. There is no partially
/// loaded shelf: [`crate::load`] returns every error instead.
#[derive(Debug, Clone)]
pub struct Shelf {
    pub manifest: Manifest,
    /// Items by id.
    pub items: BTreeMap<String, LoadedItem>,
    /// Bundles by id.
    pub bundles: BTreeMap<String, Bundle>,
    /// Profiles by id.
    pub profiles: BTreeMap<String, Profile>,
}

/// An item, with the directory it was loaded from and its revision.
///
/// `files` are the bytes the source returned, keyed by path relative to the
/// item directory, and `revision` is [`Revision::of_files`] over exactly
/// those bytes. Both are computed once, at load, and everything downstream
/// (the compiler, `push`, the Worker) uses them rather than re-reading the
/// directory, so `compile` and `push` cannot disagree about a revision.
/// Content is stored as found; a consumer that emits it uses
/// [`crate::revision::normalize_line_endings`] for platform-independent bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedItem {
    pub item: Item,
    /// The item directory, relative to the shelf root: `items/prompts/x`.
    pub path: String,
    pub revision: Revision,
    pub files: BTreeMap<String, Vec<u8>>,
}

impl LoadedItem {
    /// The path of the item's `item.json`, for messages.
    pub fn item_json(&self) -> String {
        format!("{}/item.json", self.path)
    }

    pub fn kind(&self) -> ItemKind {
        self.item.kind()
    }
}

/// Something `check` reports that does not stop a load or a compile.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// The file the notice is about.
    pub path: String,
    pub code: NoticeCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeCode {
    /// A profile opted into a CLI-only target, so its manifest is
    /// Producer-nonconformant under OpenAPM v0.1.
    ProducerNonconformantTarget,
    /// A profile includes an `lsp` item, whose `dependencies.lsp` key is
    /// absent from the published OpenAPM v0.1 schema.
    UnratifiedLsp,
    /// A profile pins a revision that is not the item's current one.
    StalePin,
}

impl std::fmt::Display for Notice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl Shelf {
    /// Resolve one profile. Every profile already resolved once at load, so
    /// this fails only for an id the shelf does not have.
    pub fn resolve(&self, profile: &str) -> Result<ResolvedProfile, Errors> {
        crate::resolve::resolve(self, profile).map_err(|errors| {
            let mut all = Errors::new();
            all.extend(errors);
            all
        })
    }

    /// Everything `shelfkit check` reports beyond load errors, sorted.
    pub fn check(&self) -> Vec<Notice> {
        let mut notices: Vec<Notice> = self
            .profiles
            .keys()
            .filter_map(|id| crate::resolve::resolve(self, id).ok())
            .flat_map(|resolved| resolved.notices)
            .collect();
        notices.sort();
        notices.dedup();
        notices
    }

    pub(crate) fn unknown_profile(id: &str) -> Error {
        Error::invalid(format!("profiles/{id}.json"), format!("no profile `{id}`"))
    }
}
