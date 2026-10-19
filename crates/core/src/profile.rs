//! Profiles, bundles, and the shelf manifest. See `docs/PRD.md` sections 5.1
//! and 5.3.

use crate::error::ErrorKind;
use crate::revision::Revision;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// An entry in a profile's or bundle's `items`: `id` (latest) or
/// `id@sha256-…` (pinned to a revision).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ItemRef {
    pub id: String,
    pub revision: Option<Revision>,
}

impl ItemRef {
    pub fn parse(value: &str) -> Result<Self, ErrorKind> {
        let (id, revision) = match value.split_once('@') {
            Some((id, revision)) => (id, Some(Revision::parse(revision)?)),
            None => (value, None),
        };
        crate::item::validate_id(id)?;
        Ok(Self {
            id: id.to_owned(),
            revision,
        })
    }
}

impl fmt::Display for ItemRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.revision {
            Some(revision) => write!(f, "{}@{revision}", self.id),
            None => f.write_str(&self.id),
        }
    }
}

impl Serialize for ItemRef {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ItemRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

/// What happens when the target repository already declares something
/// equivalent. Not a merge: a half-applied convention is worse than either
/// whole one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnConflict {
    #[default]
    Fail,
    ShelfWins,
    LocalWins,
}

/// `revision` compiles pinned refs and is the default; `latest` compiles
/// unpinned refs, for a personal shelf.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pin {
    #[default]
    Revision,
    Latest,
}

/// A profile's `compile` settings as written. Every field is optional so
/// `extends` can tell a setting a child made from one it left alone; the
/// resolved settings are [`crate::resolve::CompileSettings`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileOptions {
    /// The compiled package's `name`. Defaults to the profile id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// APM target slugs, verbatim. Empty means APM detects the harnesses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<Pin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_conflict: Option<OnConflict>,
    /// Compile shelf-authored items into a vendored `.apm/` package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor_authored: Option<bool>,
    /// The explicit opt-in for CLI-only targets, which make the manifest
    /// Producer-nonconformant. `check` reports every profile that uses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_nonconformant_targets: Option<bool>,
}

/// A named selection of items. A profile is what a user installs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// The semver this profile publishes as on a registry. A profile's
    /// identity is its revision; a version exists only for publishing, and
    /// without one the registry version is generated from the revision
    /// (`docs/PRD.md` section 13, question 1). It is not inherited through
    /// `extends`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub items: Vec<ItemRef>,
    /// Named item groups, expanded before `extends`.
    #[serde(default)]
    pub bundles: Vec<String>,
    /// Profiles composed breadth-first; children win.
    #[serde(default)]
    pub extends: Vec<String>,
    #[serde(default)]
    pub compile: CompileOptions,
}

/// A named item list with no compile settings, so several profiles can share
/// a cluster without repeating it. Not itself installable.
///
/// Bundles live in `bundles/<id>.json`, beside `profiles/`, one file each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub items: Vec<ItemRef>,
}

/// The kinds of place items can come from (`docs/PRD.md` section 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    Git,
    ApmRegistry,
    Shelfkit,
    Catalog,
    Marketplace,
    Path,
}

/// An entry in `shelf.json`'s `sources`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShelfSource {
    pub id: String,
    pub kind: SourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<u32>,
    /// For a `shelfkit` source: the profile to import.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

/// How the shelf appears as an OpenAPM registry. `namespace` is the
/// `{owner}` of every package the shelf publishes, one per profile, so a
/// profile is `{namespace}/{profile id}` on the registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub namespace: String,
    #[serde(default)]
    pub public: bool,
}

/// `shelf.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub owner: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<Registry>,
    #[serde(default)]
    pub sources: Vec<ShelfSource>,
}

/// Whether `text` is a semantic version 2.0.0: `MAJOR.MINOR.PATCH`, numbers
/// without leading zeros, then an optional `-pre.release` and `+build.meta`
/// of dot-separated identifiers. APM's registry client reads exactly these
/// as versions it can range-match and exact-match.
pub fn is_semver(text: &str) -> bool {
    let (rest, build) = match text.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (text, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let number = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    };
    let identifier = |part: &str| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| number(part))
        && pre.is_none_or(|pre| {
            pre.split('.').all(|part| {
                identifier(part) && (!part.bytes().all(|b| b.is_ascii_digit()) || number(part))
            })
        })
        && build.is_none_or(|build| build.split('.').all(identifier))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_is_the_2_0_0_grammar() {
        for good in [
            "0.0.0",
            "1.2.3",
            "10.20.30",
            "1.0.0-alpha.1",
            "1.0.0+sha256.abc",
            "1.0.0-rc.1+b.2",
            "1.0.0-0a",
        ] {
            assert!(is_semver(good), "{good}");
        }
        for bad in [
            "1.0",
            "01.0.0",
            "1.0.0-",
            "1.0.0+",
            "1.0.0-01",
            "v1.0.0",
            "1.0.0-a..b",
            "1.0.0+a_b",
            "",
        ] {
            assert!(!is_semver(bad), "{bad}");
        }
    }

    #[test]
    fn item_refs_parse_pins() {
        let pinned = ItemRef::parse(&format!("drizzle@sha256-{}", "0".repeat(64))).unwrap();
        assert_eq!(pinned.id, "drizzle");
        assert!(pinned.revision.is_some());
        assert_eq!(ItemRef::parse("drizzle").unwrap().revision, None);
        assert!(ItemRef::parse("drizzle@latest").is_err());
        assert!(ItemRef::parse("Bad@").is_err());
    }

    #[test]
    fn item_refs_round_trip_as_strings() {
        let text = format!("\"a@sha256-{}\"", "f".repeat(64));
        let parsed: ItemRef = serde_json::from_str(&text).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
    }
}
