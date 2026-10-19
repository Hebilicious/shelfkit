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
use crate::vendor;
use crate::yaml::{self, Node};
use serde::Serialize;
use sha2::{Digest, Sha256};
use shelfkit_core::item::{Lsp, LspTransport, Mcp, RemoteTransport};
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VendorFile {
    pub path: String,
    /// The text, or base64 when `encoding` says so.
    pub contents: String,
    #[serde(skip_serializing_if = "Encoding::is_utf8")]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Encoding {
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
}

impl From<NoticeCode> for NoteCode {
    fn from(code: NoticeCode) -> Self {
        match code {
            NoticeCode::ProducerNonconformantTarget => Self::ProducerNonconformantTarget,
            NoticeCode::UnratifiedLsp => Self::UnratifiedLsp,
        }
    }
}

/// Compile a resolved profile. Every problem is returned, each carrying the
/// file it came from.
pub fn compile(shelf: &Shelf, resolved: &ResolvedProfile) -> Result<CompiledManifest, Errors> {
    let mut compiler = Compiler {
        shelf,
        resolved,
        errors: Errors::new(),
        upstream: Vec::new(),
        registries: BTreeMap::new(),
        packages: BTreeMap::new(),
        mcp: Vec::new(),
        lsp: Vec::new(),
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
    compiler.finish()
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
    /// `registries`, by name: the URL and whether it opted into http.
    registries: BTreeMap<String, (String, bool)>,
    /// Vendored packages by directory name.
    packages: BTreeMap<String, Package>,
    mcp: Vec<Node>,
    lsp: Vec<Node>,
    notes: Vec<Note>,
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

    fn reference(&mut self, loaded: &LoadedItem, upstream: &Upstream) {
        if let Upstream::Registry(registry) = upstream {
            self.registries.insert(
                registry.registry.clone(),
                (registry.url.clone(), registry.insecure),
            );
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
                 prose is authoritative, so it is checked against APM's own rules instead"
            ),
        });
        self.mcp.push(entry);
    }

    fn finish(mut self) -> Result<CompiledManifest, Errors> {
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
        let explicit_git = !self.registries.is_empty();
        let mut apm: Vec<Node> = self
            .upstream
            .iter()
            .map(|(upstream, targets)| upstream.entry(targets.as_deref(), explicit_git))
            .collect();
        let mut files = Vec::new();
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
            files.push(VendorFile::new(
                format!("{root}/apm.yml"),
                yaml::render(&manifest).into_bytes(),
            ));
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
                files.push(VendorFile::new(format!("{root}/{path}"), bytes.clone()));
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));

        let mut root = vec![
            ("name".to_owned(), Node::string(&settings.name)),
            ("version".to_owned(), Node::string(MANIFEST_VERSION)),
        ];
        if !settings.targets.is_empty() {
            root.push(("targets".to_owned(), Node::strings(&settings.targets)));
        }
        if let Some((name, (url, insecure))) = self.registries.iter().next() {
            let mut entry = vec![("url".to_owned(), Node::string(url))];
            if *insecure {
                entry.push(("insecure".to_owned(), Node::Bool(true)));
            }
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

        let apm_yml = yaml::render(&manifest);
        let install_command = if self.registries.is_empty() {
            "apm install".to_owned()
        } else {
            // APM's registry client is behind an experimental flag.
            "apm experimental enable registries && apm install".to_owned()
        };
        let mut notes = self.notes;
        notes.sort();
        notes.dedup();
        Ok(CompiledManifest {
            profile: self.resolved.id.clone(),
            profile_revision: self.resolved.revision.clone(),
            apm_yml_digest: digest(apm_yml.as_bytes()),
            apm_yml,
            files,
            install_command,
            notes,
        })
    }
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

/// The `apm.yml` of a vendored package. A local `.apm/` package works
/// without one, but naming it makes `apm deps` and the lockfile readable.
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
