//! Items: the ten kinds, their common fields, provenance, and per-kind
//! payloads. See `docs/PRD.md` section 5.2.
//!
//! An item lives in `items/<kind directory>/<id>/item.json`. The JSON object
//! holds the common fields and the kind's own fields side by side, as the PRD
//! examples show, and unknown keys are refused so a typo cannot silently drop
//! a convention. Content files (`SKILL.md`, `prompt.md`, ...) sit beside it.

use crate::error::ErrorKind;
use crate::secret::SecretValue;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

/// The ten item kinds. Seven map one-to-one onto APM primitives; `lsp` is an
/// unratified APM surface; `library` and `stack` are the shelf's own
/// vocabulary and compile into APM instructions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
    Doc,
}

impl ItemKind {
    pub const ALL: [Self; 11] = [
        Self::Skill,
        Self::Prompt,
        Self::Instructions,
        Self::Agent,
        Self::Hook,
        Self::Plugin,
        Self::Mcp,
        Self::Lsp,
        Self::Library,
        Self::Stack,
        Self::Doc,
    ];

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
            Self::Doc => "docs",
        }
    }

    pub fn from_directory(directory: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.directory() == directory)
    }

    /// The kind as it is spelled in `item.json`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Prompt => "prompt",
            Self::Instructions => "instructions",
            Self::Agent => "agent",
            Self::Hook => "hook",
            Self::Plugin => "plugin",
            Self::Mcp => "mcp",
            Self::Lsp => "lsp",
            Self::Library => "library",
            Self::Stack => "stack",
            Self::Doc => "doc",
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

    /// The content file an authored item of this kind must carry, if any.
    pub const fn content_file(self) -> Option<&'static str> {
        match self {
            Self::Skill => Some("SKILL.md"),
            Self::Prompt => Some("prompt.md"),
            Self::Agent => Some("agent.md"),
            Self::Hook => Some("hook.json"),
            Self::Plugin => Some("plugin.json"),
            Self::Doc => Some("doc.md"),
            Self::Instructions | Self::Mcp | Self::Lsp | Self::Library | Self::Stack => None,
        }
    }
}

impl std::fmt::Display for ItemKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The longest item id. MCP tool names are at most 128 characters and a
/// relayed tool is `<item>__<tool>`, so an id leaves the tool name room.
pub const MAX_ID_LENGTH: usize = 64;

/// Item ids are kebab-case and may not contain `__`, which is what makes the
/// MCP namespace separator in the PRD's section 8 unambiguous. Kebab-case has
/// no underscore at all, so the separator can never occur inside an id.
pub fn validate_id(id: &str) -> Result<(), ErrorKind> {
    let invalid = |message: &str| Err(ErrorKind::Invalid(format!("id `{id}` {message}")));

    if id.is_empty() {
        return invalid("must not be empty");
    }
    if id.len() > MAX_ID_LENGTH {
        return invalid(&format!("must be at most {MAX_ID_LENGTH} characters"));
    }
    if id.contains("__") {
        return invalid("must not contain `__` (reserved for MCP namespacing)");
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return invalid("must be lowercase kebab-case");
    }
    if id.starts_with('-') || id.ends_with('-') || id.contains("--") {
        return invalid("must not start or end with a hyphen or repeat one");
    }
    Ok(())
}

/// A doc's `path`: relative to a repository's root, with `/` separators, no `.` or `..` segment, no empty segment,
/// and nothing a link could not name plainly (whitespace, `#`, `?`, `\\`, or a `:` that reads as a scheme).
pub fn validate_doc_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() || path.starts_with('/') {
        return Err("must be a path relative to the repository's root");
    }
    if path
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '#' | '?' | '\\' | ':'))
    {
        return Err("must not contain whitespace, `#`, `?`, `\\`, or `:`");
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("must not have an empty, `.`, or `..` segment");
    }
    Ok(())
}

/// Where an imported item came from, and what using it obliges.
///
/// Carried on the item rather than spread over its fields: one import from
/// one source shares one attribution obligation. Every field is optional,
/// because an item authored in the shelf has no source and an import records
/// what its source kind provides (a Git commit, a registry version, a catalog
/// record). Issue #8 populates these; it does not add to them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    /// The `id` of an entry in `shelf.json`'s `sources`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The upstream Git repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The upstream URL, for sources that are not Git (a registry, a catalog).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The path of the item inside the upstream repository or package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The ref the import asked for: a tag, a branch, or a commit.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// The commit `ref` resolved to when the item was imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_commit: Option<String>,
    /// The resolved version, for a registry source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The upstream digest, as `sha256:<hex>`, for a registry source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// The licence as the source states it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// The SPDX identifier of the licence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license_id: Option<String>,
    /// Whether the licence obliges derived work to carry the same licence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_alike: Option<bool>,
    /// The credit the source requires, as text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit_text: Option<String>,
    /// Where the credit links to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// The deep link to this item's record at the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_url: Option<String>,
}

/// One addressable primitive in a shelf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// `$schema`, kept so a load and save round-trips the file.
    pub schema: Option<String>,
    pub id: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub targets: Vec<String>,
    /// The explicit opt-in for CLI-only slugs in `targets`, as on a profile.
    /// `check` reports every item that uses it.
    pub allow_nonconformant_targets: bool,
    /// Items this one needs. Resolution pulls them into every profile that
    /// selects this item.
    pub requires: Vec<String>,
    /// Present when the item was imported; absent when it is authored here.
    pub source: Option<Source>,
    pub payload: Payload,
}

/// The common fields, as they appear in `item.json`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Common {
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    id: String,
    kind: ItemKind,
    title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    targets: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    allow_nonconformant_targets: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    requires: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<Source>,
}

const COMMON_KEYS: &[&str] = &[
    "$schema",
    "id",
    "kind",
    "title",
    "description",
    "tags",
    "targets",
    "allowNonconformantTargets",
    "requires",
    "source",
];

impl Item {
    pub fn kind(&self) -> ItemKind {
        self.payload.kind()
    }

    /// Parse an `item.json` document.
    pub fn from_json(bytes: &[u8]) -> Result<Self, ErrorKind> {
        let value: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|error| ErrorKind::Json(error.to_string()))?;
        Self::from_value(value)
    }

    pub fn from_value(value: serde_json::Value) -> Result<Self, ErrorKind> {
        let serde_json::Value::Object(map) = value else {
            return Err(ErrorKind::Invalid("an item must be a JSON object".into()));
        };
        let (common, payload): (serde_json::Map<_, _>, serde_json::Map<_, _>) = map
            .into_iter()
            .partition(|(key, _)| COMMON_KEYS.contains(&key.as_str()));

        let common: Common = serde_json::from_value(serde_json::Value::Object(common))
            .map_err(|error| ErrorKind::Invalid(error.to_string()))?;
        let payload = Payload::from_map(common.kind, payload)?;

        Ok(Self {
            schema: common.schema,
            id: common.id,
            title: common.title,
            description: common.description,
            tags: common.tags,
            targets: common.targets,
            allow_nonconformant_targets: common.allow_nonconformant_targets,
            requires: common.requires,
            source: common.source,
            payload,
        })
    }

    /// Write the item as `item.json`: two-space indentation, a trailing line
    /// feed, the common fields first, and empty optional fields left out.
    pub fn to_json(&self) -> String {
        // Serializing a struct of strings, vectors, and maps cannot fail.
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }
}

impl Serialize for Item {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Out<'a> {
            #[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
            schema: &'a Option<String>,
            id: &'a str,
            kind: ItemKind,
            title: &'a str,
            #[serde(skip_serializing_if = "str::is_empty")]
            description: &'a str,
            #[serde(skip_serializing_if = "<[String]>::is_empty")]
            tags: &'a [String],
            #[serde(skip_serializing_if = "<[String]>::is_empty")]
            targets: &'a [String],
            #[serde(
                rename = "allowNonconformantTargets",
                skip_serializing_if = "std::ops::Not::not"
            )]
            allow_nonconformant_targets: bool,
            #[serde(skip_serializing_if = "<[String]>::is_empty")]
            requires: &'a [String],
            #[serde(flatten)]
            payload: &'a Payload,
            #[serde(skip_serializing_if = "Option::is_none")]
            source: &'a Option<Source>,
        }

        Out {
            schema: &self.schema,
            id: &self.id,
            kind: self.kind(),
            title: &self.title,
            description: &self.description,
            tags: &self.tags,
            targets: &self.targets,
            allow_nonconformant_targets: self.allow_nonconformant_targets,
            requires: &self.requires,
            payload: &self.payload,
            source: &self.source,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Item {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Self::from_value(value).map_err(serde::de::Error::custom)
    }
}

/// The fields one kind adds to the common ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Payload {
    /// A directory with `SKILL.md`; nothing in `item.json` beyond the common
    /// fields. The frontmatter is checked against agentskills.io at load.
    Skill(Empty),
    Prompt(Prompt),
    Instructions(Instructions),
    /// `agent.md`.
    Agent(Empty),
    /// `hook.json`.
    Hook(Empty),
    /// `plugin.json`, an Agent Plugins v1 package.
    Plugin(Empty),
    Mcp(Mcp),
    Lsp(Lsp),
    Library(Library),
    Stack(Stack),
    /// `doc.md`: a reference document instructions link to by `path`.
    Doc(Doc),
}

impl Payload {
    pub fn kind(&self) -> ItemKind {
        match self {
            Self::Skill(_) => ItemKind::Skill,
            Self::Prompt(_) => ItemKind::Prompt,
            Self::Instructions(_) => ItemKind::Instructions,
            Self::Agent(_) => ItemKind::Agent,
            Self::Hook(_) => ItemKind::Hook,
            Self::Plugin(_) => ItemKind::Plugin,
            Self::Mcp(_) => ItemKind::Mcp,
            Self::Lsp(_) => ItemKind::Lsp,
            Self::Library(_) => ItemKind::Library,
            Self::Stack(_) => ItemKind::Stack,
            Self::Doc(_) => ItemKind::Doc,
        }
    }

    fn from_map(
        kind: ItemKind,
        map: serde_json::Map<String, serde_json::Value>,
    ) -> Result<Self, ErrorKind> {
        fn parse<T: serde::de::DeserializeOwned>(
            kind: ItemKind,
            map: serde_json::Map<String, serde_json::Value>,
        ) -> Result<T, ErrorKind> {
            serde_json::from_value(serde_json::Value::Object(map))
                .map_err(|error| ErrorKind::Invalid(format!("{kind} item: {error}")))
        }

        Ok(match kind {
            ItemKind::Skill => Self::Skill(parse(kind, map)?),
            ItemKind::Prompt => Self::Prompt(parse(kind, map)?),
            ItemKind::Instructions => Self::Instructions(parse(kind, map)?),
            ItemKind::Agent => Self::Agent(parse(kind, map)?),
            ItemKind::Hook => Self::Hook(parse(kind, map)?),
            ItemKind::Plugin => Self::Plugin(parse(kind, map)?),
            ItemKind::Mcp => Self::Mcp(parse(kind, map)?),
            ItemKind::Lsp => Self::Lsp(parse(kind, map)?),
            ItemKind::Library => Self::Library(parse(kind, map)?),
            ItemKind::Stack => Self::Stack(parse(kind, map)?),
            ItemKind::Doc => Self::Doc(parse(kind, map)?),
        })
    }
}

/// A kind whose `item.json` carries only the common fields.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// Markdown plus variables. APM treats prompts and commands as one
/// primitive, so `asCommand` surfaces the prompt as a slash command on the
/// harnesses that have them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prompt {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub as_command: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<PromptVariable>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptVariable {
    pub name: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One heading and its body: an instructions section or a stack convention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub heading: String,
    pub body: String,
}

/// What makes a stack or library detectable by `recommend`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Markers {
    /// Files whose presence at the repository root is a marker.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Package names in the repository's dependency manifests.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_manager: Option<String>,
}

impl Markers {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.dependencies.is_empty() && self.package_manager.is_none()
    }
}

/// Project conventions as structured `sections`, an `AGENTS.fragment.md`
/// file, or both, plus `markers` that make a stack detectable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instructions {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<Section>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markers: Option<Markers>,
}

/// An MCP server, in one of three flavours (`docs/PRD.md` sections 5.2 and 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "flavour", rename_all = "kebab-case")]
pub enum Mcp {
    /// A server the client reaches directly. Compiles to a
    /// `dependencies.mcp` entry.
    Remote(RemoteMcp),
    /// A local process the agent runs. Compiles to a `dependencies.mcp`
    /// entry; ShelfKit never starts it.
    Stdio(StdioMcp),
    /// A remote server ShelfKit relays because its credential should live in
    /// one place. The fields describe the upstream; the agent reaches it
    /// through ShelfKit's `/mcp` with its tools namespaced `<item>__<tool>`.
    Hosted(HostedMcp),
}

impl Mcp {
    /// The `dependencies.mcp` name this server compiles to, when it has one.
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Remote(remote) => remote.name.as_deref(),
            Self::Stdio(stdio) => stdio.name.as_deref(),
            Self::Hosted(_) => None,
        }
    }
}

/// APM's remote MCP transports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteTransport {
    Http,
    Sse,
    StreamableHttp,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteMcp {
    /// The server's MCP registry name, as `io.github.upstash/context7`. With
    /// no `url`, APM resolves the server through the registry by this name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<RemoteTransport>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, SecretValue>,
    /// Restrict the tools the client exposes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StdioMcp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, SecretValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedMcp {
    /// The upstream server ShelfKit relays to.
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<RemoteTransport>,
    /// Headers ShelfKit injects upstream. Secrets are references to secrets
    /// the deployment holds; the caller never sees them.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, SecretValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LspTransport {
    Stdio,
    Socket,
}

/// A language server, in APM's `dependencies.lsp` shape (APM 0.33.0,
/// `apm_cli/models/dependency/lsp.py`). `lsp` is absent from the published
/// OpenAPM v0.1 schema, so `check` and the compiler both note it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lsp {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// File extension to LSP language id, as `{ ".ts": "typescript" }`.
    pub extension_to_language: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<LspTransport>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, SecretValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initialization_options: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_timeout: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shutdown_timeout: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_on_crash: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_restarts: Option<u64>,
}

/// A library or tool the shelf has opinions about. Not a dependency: what an
/// agent needs to use it correctly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Library {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detect: Option<Markers>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// A reference document: longer than an instruction, and read only when an instruction or a task points to it
/// (`docs/PRD.md` section 5.2). `path` is where it lives in the repository it was written for, which is how
/// instructions link to it (`docs/agents/domain.md`, `GLOSSARY.md`); a profile's docs keep those paths inside the
/// skill folder they install as, and the compiler points the instructions' links there.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Doc {
    pub path: String,
}

/// A tech stack: markers for detection plus the conventions that follow.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stack {
    pub markers: Markers,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conventions: Vec<Section>,
    /// Items to suggest alongside the stack. References, checked at load;
    /// not pulled into a profile.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recommends: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_kebab_case_without_double_underscore() {
        assert!(validate_id("pr-description").is_ok());
        assert!(validate_id("a1").is_ok());
        for bad in ["", "Pr", "a__b", "a_b", "-a", "a-", "a--b", &"a".repeat(65)] {
            assert!(validate_id(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn every_kind_has_a_directory_that_maps_back() {
        for kind in ItemKind::ALL {
            assert_eq!(ItemKind::from_directory(kind.directory()), Some(kind));
        }
    }

    #[test]
    fn unknown_payload_keys_are_refused() {
        let error =
            Item::from_json(br#"{ "id": "a", "kind": "prompt", "title": "A", "asComand": true }"#)
                .unwrap_err();
        assert!(error.to_string().contains("asComand"), "{error}");
    }

    #[test]
    fn mcp_flavour_selects_the_fields() {
        let item = Item::from_json(
            br#"{ "id": "ctx", "kind": "mcp", "title": "Ctx", "flavour": "stdio", "command": "npx", "args": ["-y", "ctx"] }"#,
        )
        .unwrap();
        let Payload::Mcp(Mcp::Stdio(stdio)) = &item.payload else {
            panic!("expected a stdio server, got {:?}", item.payload);
        };
        assert_eq!(stdio.command, "npx");

        let wrong = Item::from_json(
            br#"{ "id": "ctx", "kind": "mcp", "title": "Ctx", "flavour": "stdio", "url": "https://x" }"#,
        );
        assert!(wrong.is_err());
    }

    #[test]
    fn save_writes_kind_after_id_and_round_trips() {
        let text = br#"{"title":"P","kind":"prompt","id":"p","variables":[{"name":"x"}],"source":{"repo":"r","licenseId":"MIT","shareAlike":false}}"#;
        let item = Item::from_json(text).unwrap();
        let saved = item.to_json();
        assert!(
            saved.starts_with("{\n  \"id\": \"p\",\n  \"kind\": \"prompt\","),
            "{saved}"
        );
        assert_eq!(Item::from_json(saved.as_bytes()).unwrap(), item);
    }
}
