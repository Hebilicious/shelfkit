//! A resolved profile, compiled to `apm.yml` plus the files to vendor.
//!
//! [`compile`] is the one renderer behind `shelfkit compile --dry-run`, the
//! composer's preview, and the MCP `shelf.compile.plan` capability. It reads
//! a loaded [`Shelf`] and a [`ResolvedProfile`] and touches nothing else: no
//! filesystem, no network, no process. It never writes a lockfile, never
//! materializes skills into harness directories, and never runs APM.
//!
//! How each kind compiles (`docs/PRD.md` sections 3.1, 5.2, and 6):
//!
//! - An item with an upstream coordinate (`source.repo`, or a registry
//!   source) stays a reference in `dependencies.apm`, pinned per `pin`.
//! - An item whose content is in the shelf, and every `hook`, compiles into a
//!   vendored package under `vendor/` (see [`crate::vendor`]).
//! - `mcp` compiles to `dependencies.mcp`; a `hosted` server is reached
//!   through ShelfKit's `/mcp` and compiles to nothing.
//! - `lsp` compiles to `dependencies.lsp`, which the published v0.1 schema
//!   does not define, and says so in a note.

use crate::coordinate::{self, Upstream};
use crate::docs;
use crate::vendor;
use crate::yaml::{self, Node};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use shelfkit_core::item::{Lsp, LspTransport, Mcp, RemoteTransport};
use shelfkit_core::revision::normalize_line_endings;
use shelfkit_core::secret::SecretValue;
use shelfkit_core::{
    Error, ErrorKind, Errors, ItemKind, LoadedItem, NoticeCode, Payload, ResolvedProfile, Revision,
    Shelf,
};
use std::collections::BTreeMap;

/// The version written into a compiled manifest. A profile revision is a
/// hash, not a semver (`docs/PRD.md` section 13, question 1); a repository
/// that already has an `apm.yml` keeps its own version when compile merges.
pub const MANIFEST_VERSION: &str = "0.0.0";

/// The directory every vendored package is written under.
pub const VENDOR_DIR: &str = "vendor";

/// The result of compiling a profile.
///
/// This is the single object rendered by `shelfkit compile --dry-run`, by the
/// composer's manifest preview, and by the MCP `shelf.compile.plan` capability,
/// so three surfaces cannot drift. It serializes exactly to
/// `CompilePlanSchema` in `packages/schema/src/capabilities.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledManifest {
    pub profile: String,
    pub profile_revision: Revision,
    /// The rendered `apm.yml`.
    pub apm_yml: String,
    /// `sha256:<hex>` over the bytes of `apm_yml`.
    pub apm_yml_digest: String,
    /// The vendored files, paths relative to the repository root, sorted.
    pub files: Vec<VendorFile>,
    /// The command the user runs next. Printed, never executed by `compile`.
    pub install_command: String,
    /// What the user must be told, sorted by path, then code, then message.
    pub notes: Vec<Note>,
}

impl CompiledManifest {
    /// The plan as JSON text: two-space indentation and a trailing line feed.
    /// `compile --dry-run --json` prints exactly this, and the WASM engine
    /// returns exactly this, so the two can be compared byte for byte.
    pub fn to_json(&self) -> String {
        // A struct of strings and lists always serializes.
        let mut text = serde_json::to_string_pretty(self).unwrap_or_default();
        text.push('\n');
        text
    }
}

/// A file the compiler wants written into the target repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VendorFile {
    pub path: String,
    /// The text, or base64 when `encoding` says so.
    pub contents: String,
    #[serde(default, skip_serializing_if = "Encoding::is_utf8")]
    pub encoding: Encoding,
}

impl VendorFile {
    fn new(path: String, bytes: Vec<u8>) -> Self {
        match String::from_utf8(bytes) {
            Ok(contents) => Self {
                path,
                contents,
                encoding: Encoding::Utf8,
            },
            Err(error) => Self {
                path,
                contents: crate::base64::encode(error.as_bytes()),
                encoding: Encoding::Base64,
            },
        }
    }

    /// The bytes to write.
    pub fn bytes(&self) -> Result<Vec<u8>, String> {
        match self.encoding {
            Encoding::Utf8 => Ok(self.contents.clone().into_bytes()),
            Encoding::Base64 => crate::base64::decode(&self.contents)
                .ok_or_else(|| format!("{}: contents are not valid base64", self.path)),
        }
    }
}

/// How a vendored file's `contents` are written. Text is the default and is
/// left out of the JSON; a file that is not UTF-8 (an image in a skill) is
/// base64.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

impl Encoding {
    fn is_utf8(&self) -> bool {
        *self == Self::Utf8
    }
}

/// Something the user must be told about a compile.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Note {
    /// The file the note is about, relative to the shelf root.
    pub path: String,
    pub code: NoteCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoteCode {
    /// The profile opted into a target outside the OpenAPM v0.1 producer set.
    ProducerNonconformantTarget,
    /// The profile compiles to `dependencies.lsp`, absent from the v0.1 schema.
    UnratifiedLsp,
    /// The profile vendors a hook, which APM gates behind approval.
    HookApproval,
    /// A `hosted` MCP server is relayed by ShelfKit's `/mcp` and compiles to
    /// no `dependencies.mcp` entry.
    HostedMcp,
    /// A `dependencies.mcp` entry uses the object form APM documents, which
    /// the published v0.1 JSON Schema rejects (see [`crate::schema`]).
    McpSchemaMismatch,
    /// A skill's `SKILL.md` frontmatter deviates from agentskills.io.
    SkillFrontmatter,
}

impl NoteCode {
    /// Every code, for the test that keeps the schema package's list in step.
    pub const ALL: [Self; 6] = [
        Self::ProducerNonconformantTarget,
        Self::UnratifiedLsp,
        Self::HookApproval,
        Self::HostedMcp,
        Self::McpSchemaMismatch,
        Self::SkillFrontmatter,
    ];
}

impl From<NoticeCode> for NoteCode {
    fn from(code: NoticeCode) -> Self {
        match code {
            NoticeCode::ProducerNonconformantTarget => Self::ProducerNonconformantTarget,
            NoticeCode::UnratifiedLsp => Self::UnratifiedLsp,
            NoticeCode::SkillFrontmatter => Self::SkillFrontmatter,
        }
    }
}

/// Compile a resolved profile. Every problem is returned, each carrying the
/// file it came from.
pub fn compile(shelf: &Shelf, resolved: &ResolvedProfile) -> Result<CompiledManifest, Errors> {
    let rendered = render(shelf, resolved, &Shape::Repository)?;
    let apm_yml = yaml::render(&rendered.manifest);
    let install_command = if rendered.uses_registry {
        // APM's registry client is behind an experimental flag.
        "apm experimental enable registries && apm install".to_owned()
    } else {
        "apm install".to_owned()
    };
    Ok(CompiledManifest {
        profile: resolved.id.clone(),
        profile_revision: resolved.revision.clone(),
        apm_yml_digest: digest(apm_yml.as_bytes()),
        apm_yml,
        files: rendered
            .files
            .into_iter()
            .map(|(path, bytes)| VendorFile::new(path, bytes))
            .collect(),
        install_command,
        notes: rendered.notes,
    })
}

/// What a profile compiles into.
pub(crate) enum Shape {
    /// A repository's `apm.yml`, with shelf-authored items vendored under
    /// `vendor/` as local packages.
    Repository,
    /// A registry package: the profile is the package, so its `apm.yml` is
    /// the package's own (`name`, `version`, `description`), and the
    /// shelf-authored items are its own `.apm/` primitives at the root. A
    /// registry package cannot declare local-path dependencies (APM refuses
    /// them from a registry parent), so an item that needs a package of its
    /// own (a plugin, or one restricted to some targets) cannot be published.
    Package {
        name: String,
        version: String,
        description: String,
    },
}

/// A compiled profile, before it is serialized.
pub(crate) struct Rendered {
    /// The root `apm.yml`.
    pub manifest: Node,
    /// Files other than the root `apm.yml`, by path, sorted.
    pub files: BTreeMap<String, Vec<u8>>,
    pub notes: Vec<Note>,
    /// Whether the manifest routes dependencies through a registry.
    pub uses_registry: bool,
}

pub(crate) fn render(
    shelf: &Shelf,
    resolved: &ResolvedProfile,
    shape: &Shape,
) -> Result<Rendered, Errors> {
    let mut compiler = Compiler {
        shelf,
        resolved,
        errors: Errors::new(),
        upstream: Vec::new(),
        registries: BTreeMap::new(),
        packages: BTreeMap::new(),
        mcp: Vec::new(),
        lsp: Vec::new(),
        docs: BTreeMap::new(),
        notes: resolved
            .notices
            .iter()
            .map(|notice| Note {
                path: notice.path.clone(),
                code: notice.code.into(),
                message: notice.message.clone(),
            })
            .collect(),
    };
    for item in &resolved.items {
        if let Some(loaded) = shelf.items.get(&item.id) {
            compiler.item(loaded);
        }
    }
    compiler.finish(shape)
}

/// One vendored package: a directory under `vendor/`, the targets its items
/// are restricted to, and its files relative to the package root.
#[derive(Default)]
struct Package {
    targets: Option<Vec<String>>,
    files: BTreeMap<String, Vec<u8>>,
    /// The items in it, for messages.
    items: Vec<String>,
}

struct Compiler<'a> {
    shelf: &'a Shelf,
    resolved: &'a ResolvedProfile,
    errors: Errors,
    /// `dependencies.apm` references and their item targets, in item id order.
    upstream: Vec<(Upstream, Option<Vec<String>>)>,
    /// `registries`, by name: the URL.
    registries: BTreeMap<String, String>,
    /// Vendored packages by directory name.
    packages: BTreeMap<String, Package>,
    mcp: Vec<Node>,
    lsp: Vec<Node>,
    notes: Vec<Note>,
    /// The profile's docs, by their `path`.
    docs: BTreeMap<String, docs::Doc>,
}

impl Compiler<'_> {
    fn fail(&mut self, loaded: &LoadedItem, message: impl Into<String>) {
        self.errors.push(Error::new(
            loaded.item_json(),
            ErrorKind::Invalid(message.into()),
        ));
    }

    fn item(&mut self, loaded: &LoadedItem) {
        let item = &loaded.item;
        match &item.payload {
            Payload::Mcp(mcp) => self.mcp(loaded, mcp),
            Payload::Lsp(lsp) => self.lsp.push(lsp_entry(lsp)),
            Payload::Hook(_) => {
                self.notes.push(Note {
                    path: loaded.item_json(),
                    code: NoteCode::HookApproval,
                    message: format!(
                        "`{}` is a hook: it runs commands on harness lifecycle events. It compiles \
                         into the vendored package, and APM holds hooks from a dependency until \
                         `apm approve` allows them when its executable gate is on. Read it before \
                         installing.",
                        item.id
                    ),
                });
                self.vendor(loaded);
            }
            Payload::Library(_) | Payload::Stack(_) => self.vendor(loaded),
            Payload::Doc(doc) => self.doc(loaded, &doc.path),
            _ => {
                let source = item.source.as_ref();
                let found = source.map(|source| {
                    coordinate::upstream(
                        item.kind(),
                        source,
                        &self.shelf.manifest.sources,
                        self.resolved.compile.pin,
                    )
                });
                match found {
                    Some(Err(message)) => self.fail(loaded, message),
                    Some(Ok(Some(upstream))) => self.reference(loaded, &upstream),
                    Some(Ok(None)) | None if vendor::has_content(loaded) => self.vendor(loaded),
                    Some(Ok(None)) | None => self.fail(
                        loaded,
                        format!(
                            "`{}` has no upstream to reference (`source.repo`, or a registry \
                             source) and no content in the shelf to vendor",
                            item.id
                        ),
                    ),
                }
            }
        }
    }

    /// A doc goes into the profile's docs skill (`docs.rs`), by its path; two docs may not share one.
    fn doc(&mut self, loaded: &LoadedItem, path: &str) {
        let Some(bytes) = loaded.files.get("doc.md") else {
            self.fail(
                loaded,
                format!("`{}` has no doc.md to compile", loaded.item.id),
            );
            return;
        };
        if let Some(other) = self.docs.get(path) {
            let message = format!(
                "`{}` and `{}` are both the doc at `{path}`; a profile holds one doc per path",
                other.id, loaded.item.id
            );
            self.fail(loaded, message);
            return;
        }
        self.docs.insert(
            path.to_owned(),
            docs::Doc {
                bytes: normalize_line_endings(bytes),
                description: loaded.item.description.clone(),
                id: loaded.item.id.clone(),
                title: loaded.item.title.clone(),
            },
        );
    }

    /// Put the docs skill into the profile's own package, and point the instructions' links to a doc at its copy.
    fn place_docs(&mut self) {
        if self.docs.is_empty() {
            return;
        }
        let namespace = self
            .shelf
            .manifest
            .registry
            .as_ref()
            .map(|registry| registry.namespace.as_str());
        let skill = docs::skill_name(namespace, &self.resolved.id);
        let paths: Vec<String> = self.docs.keys().cloned().collect();
        let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
        for package in self.packages.values_mut() {
            for (path, bytes) in &mut package.files {
                if path.starts_with(vendor::INSTRUCTIONS_DIR)
                    && let Ok(text) = std::str::from_utf8(bytes)
                {
                    *bytes = docs::rewrite_links(text, &paths, &skill).into_bytes();
                }
            }
        }
        let own = self.packages.entry(self.resolved.id.clone()).or_default();
        own.files.extend(docs::skill_files(&skill, &self.docs));
        own.items
            .extend(self.docs.values().map(|doc| doc.id.clone()));
    }

    fn reference(&mut self, loaded: &LoadedItem, upstream: &Upstream) {
        if let Upstream::Registry(registry) = upstream {
            self.registries
                .insert(registry.registry.clone(), registry.url.clone());
        }
        self.upstream.push((upstream.clone(), item_targets(loaded)));
    }

    fn vendor(&mut self, loaded: &LoadedItem) {
        let profile = &self.resolved.id;
        let targets = item_targets(loaded);
        let (directory, files) = if loaded.kind() == ItemKind::Plugin {
            (
                format!("{profile}--plugin-{}", loaded.item.id),
                vendor::plugin_files(loaded),
            )
        } else {
            let directory = match &targets {
                None => profile.clone(),
                Some(targets) => format!("{profile}--only-{}", targets.join(".")),
            };
            (directory, vendor::primitive_files(loaded))
        };
        match files {
            Ok(files) => {
                let package = self.packages.entry(directory).or_default();
                package.targets = targets;
                package.files.extend(files);
                package.items.push(loaded.item.id.clone());
            }
            Err(message) => self.fail(loaded, message),
        }
    }

    fn mcp(&mut self, loaded: &LoadedItem, mcp: &Mcp) {
        let item_json = loaded.item_json();
        let id = &loaded.item.id;
        let entry = match mcp {
            Mcp::Hosted(_) => {
                self.notes.push(Note {
                    path: item_json,
                    code: NoteCode::HostedMcp,
                    message: format!(
                        "`{id}` is relayed by ShelfKit, so it compiles to no `dependencies.mcp` \
                         entry: an agent reaches its tools through the shelf's `/mcp` endpoint, \
                         as `{id}__<tool>`"
                    ),
                });
                return;
            }
            Mcp::Remote(remote) => {
                let name = remote.name.clone().unwrap_or_else(|| id.clone());
                match &remote.url {
                    // A server APM resolves from the MCP registry by name.
                    None if remote.headers.is_empty() && remote.tools.is_none() => {
                        self.mcp.push(Node::String(name));
                        return;
                    }
                    None => {
                        let mut entries = vec![("name".to_owned(), Node::String(name))];
                        push_secrets(&mut entries, "headers", &remote.headers);
                        push_tools(&mut entries, remote.tools.as_deref());
                        Node::Map(entries)
                    }
                    Some(url) => {
                        let transport = remote.transport.unwrap_or(RemoteTransport::Http);
                        let mut entries = vec![
                            ("name".to_owned(), Node::String(name)),
                            ("registry".to_owned(), Node::Bool(false)),
                            (
                                "transport".to_owned(),
                                Node::string(remote_transport(transport)),
                            ),
                            ("url".to_owned(), Node::string(url)),
                        ];
                        push_secrets(&mut entries, "headers", &remote.headers);
                        push_tools(&mut entries, remote.tools.as_deref());
                        Node::Map(entries)
                    }
                }
            }
            Mcp::Stdio(stdio) => {
                // `args` is always written, even empty: APM refuses a stdio
                // `command` with whitespace in it unless `args` is present.
                let mut entries = vec![
                    (
                        "name".to_owned(),
                        Node::string(stdio.name.clone().unwrap_or_else(|| id.clone())),
                    ),
                    ("registry".to_owned(), Node::Bool(false)),
                    ("transport".to_owned(), Node::string("stdio")),
                    ("command".to_owned(), Node::string(&stdio.command)),
                    ("args".to_owned(), Node::strings(&stdio.args)),
                ];
                push_secrets(&mut entries, "env", &stdio.env);
                if let Some(cwd) = &stdio.cwd {
                    entries.push(("cwd".to_owned(), Node::string(cwd)));
                }
                push_tools(&mut entries, stdio.tools.as_deref());
                Node::Map(entries)
            }
        };
        self.notes.push(Note {
            path: item_json,
            code: NoteCode::McpSchemaMismatch,
            message: format!(
                "`{id}` compiles to a `dependencies.mcp` object, the form APM documents, which the \
                 published OpenAPM v0.1 JSON Schema rejects for every MCP object; the spec's \
                 prose is authoritative, so the entry is validated against APM 0.33.0's own MCP \
                 entry rules (schemas/apm-mcp-entry.schema.json) instead"
            ),
        });
        self.mcp.push(entry);
    }

    fn finish(mut self, shape: &Shape) -> Result<Rendered, Errors> {
        self.place_docs();
        let profile_path = self.resolved.path.clone();
        let settings = &self.resolved.compile;

        if !settings.vendor_authored && !self.packages.is_empty() {
            let items: Vec<String> = self
                .packages
                .values()
                .flat_map(|package| package.items.iter().map(|id| format!("`{id}`")))
                .collect();
            self.errors.push(Error::invalid(
                &profile_path,
                format!(
                    "`compile.vendorAuthored` is false, but {} can only compile into the vendored \
                     package (they have no upstream to reference, or are hooks)",
                    items.join(", ")
                ),
            ));
        }

        // One registry per manifest: it is `registries.default`, which routes
        // `{ id, version }` entries without a `registry` key, the only
        // registry form the OpenAPM v0.1 schema accepts.
        if self.registries.len() > 1 {
            let names: Vec<String> = self.registries.keys().map(|n| format!("`{n}`")).collect();
            self.errors.push(Error::invalid(
                &profile_path,
                format!(
                    "the profile routes items through {} registries; a compiled manifest names \
                     one, as `registries.default`, because the OpenAPM v0.1 schema rejects a \
                     `registry` key beside `id`",
                    names.join(" and ")
                ),
            ));
        }
        let mut apm: Vec<Node> = self
            .upstream
            .iter()
            .map(|(upstream, targets)| upstream.entry(targets.as_deref()))
            .collect();
        let mut files = BTreeMap::new();
        match shape {
            Shape::Repository => {
                for (directory, package) in &self.packages {
                    let root = format!("{VENDOR_DIR}/{directory}");
                    let local = format!("./{root}");
                    apm.push(match &package.targets {
                        None => Node::String(local),
                        Some(targets) => Node::Map(vec![
                            ("path".to_owned(), Node::String(local)),
                            ("targets".to_owned(), Node::strings(targets)),
                        ]),
                    });
                    let manifest = package_manifest(directory, &self.resolved.id);
                    files.insert(
                        format!("{root}/apm.yml"),
                        yaml::render(&manifest).into_bytes(),
                    );
                    #[cfg(feature = "schema")]
                    if let Err(errors) = crate::schema::validate(&manifest) {
                        for message in errors {
                            self.errors.push(Error::invalid(
                                &profile_path,
                                format!(
                                    "the vendored {root}/apm.yml fails the OpenAPM v0.1 schema: {message}"
                                ),
                            ));
                        }
                    }
                    for (path, bytes) in &package.files {
                        files.insert(format!("{root}/{path}"), bytes.clone());
                    }
                }
            }
            Shape::Package { .. } => {
                let own = &self.resolved.id;
                for (directory, package) in &self.packages {
                    if directory == own {
                        files.extend(package.files.clone());
                        continue;
                    }
                    let why = if directory.starts_with(&format!("{own}--plugin-")) {
                        "is a plugin, which compiles into a package of its own"
                    } else {
                        "restricts its `targets`, so it compiles into a package of its own with \
                         per-dependency targets"
                    };
                    for id in &package.items {
                        self.errors.push(Error::invalid(
                            &profile_path,
                            format!(
                                "`{id}` {why}; a registry package cannot declare a local-path \
                                 dependency (APM refuses one from a registry package), so this \
                                 profile cannot be published until `{id}` has an upstream to \
                                 reference or reaches every target"
                            ),
                        ));
                    }
                }
            }
        }

        let mut root = match shape {
            Shape::Repository => vec![
                ("name".to_owned(), Node::string(&settings.name)),
                ("version".to_owned(), Node::string(MANIFEST_VERSION)),
            ],
            Shape::Package {
                name,
                version,
                description,
            } => vec![
                ("name".to_owned(), Node::string(name)),
                ("version".to_owned(), Node::string(version)),
                ("description".to_owned(), Node::string(description)),
            ],
        };
        // A package does not choose its consumer's targets. Docs are linked at their copy in `.agents/skills/`, so
        // some target must install skills there (`docs.rs`).
        if matches!(shape, Shape::Repository) && !settings.targets.is_empty() {
            let mut targets = settings.targets.clone();
            if !self.docs.is_empty()
                && !targets
                    .iter()
                    .any(|target| docs::DEPLOYING_TARGETS.contains(&target.as_str()))
            {
                targets.push("agent-skills".to_owned());
            }
            root.push(("targets".to_owned(), Node::strings(&targets)));
        }
        // APM 0.33.0 refuses any key in a registry entry but `url`.
        if let Some((name, url)) = self.registries.iter().next() {
            let entry = vec![("url".to_owned(), Node::string(url))];
            root.push((
                "registries".to_owned(),
                Node::Map(vec![
                    (name.clone(), Node::Map(entry)),
                    ("default".to_owned(), Node::string(name)),
                ]),
            ));
        }
        let mut dependencies = Vec::new();
        for (key, list) in [("apm", apm), ("mcp", self.mcp), ("lsp", self.lsp)] {
            if !list.is_empty() {
                dependencies.push((key.to_owned(), Node::Seq(list)));
            }
        }
        if !dependencies.is_empty() {
            root.push(("dependencies".to_owned(), Node::Map(dependencies)));
        }
        // Vendored instructions reach the agents through AGENTS.md, which `apm compile` writes (`vendor.rs`).
        let instructions = self.packages.values().any(|package| {
            package
                .files
                .keys()
                .any(|path| path.starts_with(vendor::INSTRUCTIONS_DIR))
        });
        if matches!(shape, Shape::Repository) && instructions {
            root.push(("compilation".to_owned(), compilation()));
        }
        let manifest = Node::Map(root);

        #[cfg(feature = "schema")]
        if let Err(errors) = crate::schema::validate(&manifest) {
            for message in errors {
                self.errors.push(Error::invalid(
                    &profile_path,
                    format!("the compiled apm.yml fails the OpenAPM v0.1 schema: {message}"),
                ));
            }
        }

        if !self.errors.is_empty() {
            return Err(self.errors.sorted());
        }

        let mut notes = self.notes;
        notes.sort();
        notes.dedup();
        Ok(Rendered {
            manifest,
            files,
            notes,
            uses_registry: !self.registries.is_empty(),
        })
    }
}

/// The lines of AGENTS.md between which `apm compile` writes the instructions, leaving the rest of the file as it is.
pub const AGENTS_MD_MARKERS: (&str, &str) = ("<!-- apm:start -->", "<!-- apm:end -->");

/// The `compilation` settings of a repository whose instructions go into AGENTS.md: every instruction in the one
/// root file (a scoped one as a section naming its files, not a file of its own in a source directory), written
/// between [`AGENTS_MD_MARKERS`] so a hand-written AGENTS.md keeps everything outside them, with their links left
/// as links.
pub fn compilation() -> Node {
    Node::Map(vec![
        ("strategy".to_owned(), Node::string("single-file")),
        (
            "agents_md".to_owned(),
            Node::Map(vec![("mode".to_owned(), Node::string("managed_section"))]),
        ),
        // On, `apm compile` pastes every linked document it finds into AGENTS.md; the links are for the agent.
        ("resolve_links".to_owned(), Node::Bool(false)),
    ])
}

/// `sha256:<lowercase hex>`, the digest form the registry and `shelf.report` use.
pub fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut text = String::with_capacity(7 + 64);
    text.push_str("sha256:");
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(text, "{byte:02x}");
    }
    text
}

/// The key in a vendored package's `apm.yml` that says ShelfKit wrote the
/// package, for which profile. A vendor extension (`x-`), which OpenAPM
/// reserves for exactly this and APM ignores. `compile` replaces or removes
/// files only inside a package that carries it for the profile it compiles.
pub const OWNER_KEY: &str = "x-shelfkit-vendored-for";

/// The `apm.yml` of a vendored package. A local `.apm/` package works
/// without one, but naming it makes `apm deps` and the lockfile readable, and
/// it carries the ownership marker.
fn package_manifest(directory: &str, profile: &str) -> Node {
    Node::Map(vec![
        ("name".to_owned(), Node::string(directory)),
        ("version".to_owned(), Node::string(MANIFEST_VERSION)),
        (
            "description".to_owned(),
            Node::String(format!(
                "Shelf items of profile {profile}, vendored by ShelfKit. Generated: edit the shelf, not this package."
            )),
        ),
        (OWNER_KEY.to_owned(), Node::string(profile)),
    ])
}

/// The item's own `targets`, sorted, or `None` when it reaches every target
/// the install does (no `targets`, or `all`).
fn item_targets(loaded: &LoadedItem) -> Option<Vec<String>> {
    let mut targets = loaded.item.targets.clone();
    if targets.is_empty() || targets.iter().any(|t| t == "all") {
        return None;
    }
    targets.sort();
    targets.dedup();
    Some(targets)
}

/// A secret reference is written as APM's `${NAME}`, which each harness
/// resolves from the environment; the value never enters the manifest.
fn secret(value: &SecretValue) -> String {
    match value {
        SecretValue::Reference { secret } => format!("${{{secret}}}"),
        SecretValue::Literal(literal) => literal.clone(),
    }
}

fn push_secrets(
    entries: &mut Vec<(String, Node)>,
    key: &str,
    values: &BTreeMap<String, SecretValue>,
) {
    if !values.is_empty() {
        let map = values
            .iter()
            .map(|(name, value)| (name.clone(), Node::String(secret(value))))
            .collect();
        entries.push((key.to_owned(), Node::Map(map)));
    }
}

fn push_tools(entries: &mut Vec<(String, Node)>, tools: Option<&[String]>) {
    if let Some(tools) = tools {
        entries.push(("tools".to_owned(), Node::strings(tools)));
    }
}

fn remote_transport(transport: RemoteTransport) -> &'static str {
    match transport {
        RemoteTransport::Http => "http",
        RemoteTransport::Sse => "sse",
        RemoteTransport::StreamableHttp => "streamable-http",
    }
}

/// APM's `dependencies.lsp` object form, camelCase as APM writes it.
fn lsp_entry(lsp: &Lsp) -> Node {
    let mut entries = vec![
        ("name".to_owned(), Node::string(&lsp.name)),
        ("command".to_owned(), Node::string(&lsp.command)),
    ];
    if !lsp.args.is_empty() {
        entries.push(("args".to_owned(), Node::strings(&lsp.args)));
    }
    entries.push((
        "extensionToLanguage".to_owned(),
        Node::Map(
            lsp.extension_to_language
                .iter()
                .map(|(extension, language)| (extension.clone(), Node::string(language)))
                .collect(),
        ),
    ));
    if let Some(transport) = lsp.transport {
        let transport = match transport {
            LspTransport::Stdio => "stdio",
            LspTransport::Socket => "socket",
        };
        entries.push(("transport".to_owned(), Node::string(transport)));
    }
    push_secrets(&mut entries, "env", &lsp.env);
    if let Some(options) = &lsp.initialization_options {
        entries.push(("initializationOptions".to_owned(), Node::from_json(options)));
    }
    if let Some(settings) = &lsp.settings {
        entries.push(("settings".to_owned(), Node::from_json(settings)));
    }
    if let Some(folder) = &lsp.workspace_folder {
        entries.push(("workspaceFolder".to_owned(), Node::string(folder)));
    }
    for (key, value) in [
        ("startupTimeout", lsp.startup_timeout),
        ("shutdownTimeout", lsp.shutdown_timeout),
        ("maxRestarts", lsp.max_restarts),
    ] {
        if let Some(value) = value {
            entries.push((key.to_owned(), Node::Number(value.to_string())));
        }
    }
    if let Some(restart) = lsp.restart_on_crash {
        entries.push(("restartOnCrash".to_owned(), Node::Bool(restart)));
    }
    entries.sort_by_key(|(key, _)| lsp_key_order(key));
    Node::Map(entries)
}

/// APM's documented field order for an LSP entry.
fn lsp_key_order(key: &str) -> usize {
    const ORDER: &[&str] = &[
        "name",
        "command",
        "args",
        "extensionToLanguage",
        "transport",
        "env",
        "initializationOptions",
        "settings",
        "workspaceFolder",
        "startupTimeout",
        "shutdownTimeout",
        "restartOnCrash",
        "maxRestarts",
    ];
    ORDER.iter().position(|k| *k == key).unwrap_or(ORDER.len())
}
