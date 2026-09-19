use crate::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The ten item kinds. Seven map one-to-one onto APM primitives; `lsp` is an
/// unratified APM surface; `library` and `stack` are the shelf's own
/// vocabulary and compile into APM instructions. See `docs/PRD.md` section 5.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    Skill,
    Prompt,
    Instructions,
    Agent,
    Hook,
    Plugin,
    Mcp,
    Lsp,
    Library,
    Stack,
}

impl ItemKind {
    /// The directory under `items/` that holds this kind.
    pub const fn directory(self) -> &'static str {
        match self {
            Self::Skill => "skills",
            Self::Prompt => "prompts",
            Self::Instructions => "instructions",
            Self::Agent => "agents",
            Self::Hook => "hooks",
            Self::Plugin => "plugins",
            Self::Mcp => "mcp",
            Self::Lsp => "lsp",
            Self::Library => "libraries",
            Self::Stack => "stacks",
        }
    }

    /// `hook` cannot be pinned as an APM virtual-file dependency, because APM
    /// classifies virtual files only by `.prompt.md`, `.instructions.md`, and
    /// `.agent.md`. Hooks therefore always compile into the vendored package.
    pub const fn apm_virtual_extension(self) -> Option<&'static str> {
        match self {
            Self::Prompt => Some(".prompt.md"),
            Self::Instructions => Some(".instructions.md"),
            Self::Agent => Some(".agent.md"),
            _ => None,
        }
    }
}

/// One addressable primitive in a shelf.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
}

impl Item {
    /// Item ids are kebab-case and may not contain `__`, which is what makes
    /// the MCP namespace separator in the PRD's section 8 unambiguous.
    pub fn validate_id(id: &str) -> Result<()> {
        let invalid = |message: &str| crate::Error::Invalid {
            path: "<item>".into(),
            message: format!("item id `{id}`: {message}"),
        };

        if id.is_empty() {
            return Err(invalid("must not be empty"));
        }
        if id.contains("__") {
            return Err(invalid(
                "must not contain `__` (reserved for MCP namespacing)",
            ));
        }
        if !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(invalid("must be lowercase kebab-case"));
        }
        if id.starts_with('-') || id.ends_with('-') {
            return Err(invalid("must not start or end with a hyphen"));
        }
        Ok(())
    }
}

/// Why a profile compiles the way it does when the target already has a
/// conflicting declaration. Not a merge: a half-applied convention is worse
/// than either whole one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnConflict {
    #[default]
    Fail,
    ShelfWins,
    LocalWins,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Pin {
    #[default]
    Revision,
    Latest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileOptions {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default)]
    pub pin: Pin,
    #[serde(default)]
    pub on_conflict: OnConflict,
    #[serde(default = "default_true")]
    pub vendor_authored: bool,
}

fn default_true() -> bool {
    true
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            name: None,
            targets: Vec::new(),
            pin: Pin::Revision,
            on_conflict: OnConflict::Fail,
            vendor_authored: true,
        }
    }
}

/// A named selection of items. A profile is what a user installs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub items: Vec<String>,
    /// Named item groups, expanded before `extends`. A bundle has no compile
    /// settings and is not itself installable.
    #[serde(default)]
    pub bundles: Vec<String>,
    #[serde(default)]
    pub extends: Vec<String>,
    #[serde(default)]
    pub compile: CompileOptions,
}

/// A loaded shelf: the manifest plus its items and profiles.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shelf {
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub default_profile: Option<String>,
    #[serde(default)]
    pub items: BTreeMap<String, Item>,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}
