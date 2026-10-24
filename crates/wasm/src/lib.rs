//! The shelf engine as a WebAssembly module: load, resolve, and compile one
//! profile, the same code `shelfkit compile --dry-run` runs.
//!
//! Built for `wasm32-unknown-unknown` with no bindings generator: the module
//! imports nothing and exports a handful of plain functions, so the Worker
//! and the browser instantiate it with an empty import object, and
//! `@shelfkit/engine` is the one typed port over it.
//!
//! # The ABI
//!
//! JSON in, JSON out, through two buffers the module owns:
//!
//! 1. `shelfkit_input(len) -> ptr` sizes the input buffer to `len` bytes and
//!    returns where it starts. The host writes the request there.
//! 2. `shelfkit_plan() -> status` reads the request and leaves its answer in
//!    the output buffer.
//! 3. `shelfkit_output_ptr()` and `shelfkit_output_len()` locate the answer.
//!
//! A pointer is good until the next call into the module; a null one means
//! the input is larger than [`MAX_INPUT`] or memory ran out. The request is
//! `{ "files": [{ "path", "contents", "encoding"? } | { "path", "symlink":
//! true }], "profile"?, "overrideProfile"? }`, with `encoding` `utf-8` (the
//! default) or `base64`. A `symlink` entry is a symbolic link the host found
//! while reading the shelf: the loader reports it exactly as it does when it
//! reads a directory itself.
//!
//! No `RefCell` borrow is held while the module allocates or computes: each
//! buffer is taken out, used, and put back. A trap in the middle (memory
//! exhaustion) therefore leaves no borrow behind to poison the next call.
//! A host should still treat a trapped instance as spent and instantiate
//! again, as `@shelfkit/engine` does.
//! The status is [`Status`]: on success the output is the plan exactly as
//! `compile --dry-run --json` prints it; otherwise it is `{ "errors": [{
//! "path", "message" }] }`.
//!
//! More calls use the same buffers, each answering with status `0`
//! (or `2` for a malformed request):
//!
//! - `shelfkit_package()`: the same request as `shelfkit_plan`; the output is
//!   the profile packaged for a registry, as `crate::package` describes,
//!   with the archive in base64 (`archive`), or `1` and the errors.
//! - `shelfkit_inventory()`: `{ "files" }`; the output is the whole shelf
//!   indexed (`shelfkit_compiler::engine::Inventory`: the manifest, every
//!   item with its revision, file paths, and coordinate, every bundle, and
//!   every profile with its resolution), or `1` and the errors.
//! - `shelfkit_resolve()`: the same request as `shelfkit_plan`; the output
//!   is the profile's resolution, or `1` and the errors.
//! - `shelfkit_recommend()`: `{ "files", "markers": { "files"?,
//!   "dependencies"?, "packageManager"? } }`; the output is what `shelfkit
//!   recommend --json` prints, or `1` and the errors.
//! - `shelfkit_output()`: `{ "plan", "onConflict"?, "repo" }`, where `plan` is
//!   a plan as `shelfkit_plan` answers it (only `profile`, `apmYml`, and
//!   `files` are read), `onConflict` is `fail` (the default), `shelf-wins`,
//!   or `local-wins`, and `repo` is the repository as
//!   `shelfkit_compiler::output::Snapshot` describes it: `{ "apmYml"?,
//!   "vendor": [{ "name", "apmYml"?, "files": [path relative to the
//!   package] }], "links"?: [path], "undecodable"?: [path] }`. The output
//!   is what `shelfkit compile --repo` would do: `{ "write": [{ "path",
//!   "contents", "encoding" }], "remove": [path], "prune": [directory],
//!   "conflicts": [declaration], "refused": [reason] }`, where `prune` lists
//!   the directories to remove, deepest first and only if empty, after
//!   `remove`. When `refused` is not empty, nothing may be written, and
//!   `write`, `remove`, and `prune` are empty. A plan file outside
//!   `vendor/<package>/` is refused. An `apm.yml` that is not a manifest, or that
//!   conflicts under `fail`, is `1` and one error on `apm.yml`, worded as the
//!   CLI words it.
//! - `shelfkit_registry_prepare()`: `{ "method", "path", "mount"?,
//!   "authorization"? }`, where `path` is the whole request path and `mount`
//!   the part the registry's base URL adds (`/apm`; empty by default).
//!   The output is `{ "respond": <response> }` when the registry answers by
//!   itself, or `{ "route": <route>, "credential": { "kind": "none" |
//!   "unreadable" } | { "kind": "key", "key" } }` for the host to resolve.
//! - `shelfkit_registry_respond()`: `{ "method", "path", "mount"?, "access", "context",
//!   "contentType"?, "ifNoneMatch"?, "body"? (base64), "now" }`, where
//!   `access` is `shelfkit_registry::Access` and `context` is
//!   `shelfkit_registry::Context`. The output is `{ "response", "publish"? }`.
//!
//! A response is `{ "status", "headers": [[name, value]], "body": { "kind":
//! "empty" } | { "kind": "json", "text" } | { "kind": "archive", "package",
//! "version" } }`; `archive` means the host sends the stored bytes of that
//! version. See `shelfkit_registry::protocol` for the two steps.
//!
//! Three calls push a shelf's files to its Git repository (an Artifacts
//! remote, SHA-1, receive-pack over smart HTTP, protocol v1), the encoding
//! being `shelfkit_git`'s; the host sends the bytes and does nothing else:
//!
//! - `shelfkit_git_commit()`: `{ "parent"?, "base": [{ "path", "mode",
//!   "id" }], "files": [{ "path", "mode"?, "id" } | { "path", "mode"?,
//!   "contents", "encoding"? }], "ref"?, "author": { "name", "email",
//!   "time", "offset" }, "committer"?, "message" }`, where `parent` is the
//!   commit `ref` (default `refs/heads/main`) points at, absent for a root
//!   commit, `base` is every file of that commit, `files` is every file of
//!   the new one (an `id` names a blob of `base`), `mode` is `100644` (the
//!   default), `100755`, or `120000`, `encoding` is `utf-8` (the default) or
//!   `base64`, `time` is Unix seconds, and `offset` minutes east of UTC. The
//!   output is `{ "commit", "tree", "unchanged", "objects", "files": [{
//!   "path", "mode", "id" }], "request" }`: `request` is the body of the
//!   `POST /git-receive-pack`, in base64, its pack holding only the objects
//!   `base` does not, and `objects` counts them. When the tree is the
//!   parent's, `unchanged` is true and `commit` and `request` are null. A
//!   bad path, mode, reference, or signature, or an `id` not in `base`, is
//!   `1` and the errors, each on its path.
//! - `shelfkit_git_report()`: `{ "body" }`, the receive-pack response in
//!   base64; the output is `{ "unpack": { "ok": true } | { "ok": false,
//!   "message" }, "refs": [{ "name", "ok", "reason"? }] }`, or `1` and the
//!   error when the body is not a report (or a side-band one ending in a
//!   fatal error, on `<remote>`).
//! - `shelfkit_git_receive()`: `{ "body" }`, a receive-pack request in
//!   base64, read as a server does, for test doubles. The output is `{
//!   "updates": [{ "old", "new", "name" }], "capabilities": [string],
//!   "objects": [object] }`, each object `{ "id", "kind" }` and, by kind:
//!   a blob or tag `contents` (base64); a tree `entries: [{ "name", "mode",
//!   "id" }]`; a commit `tree`, `parents`, `author` and `committer` (`{
//!   "name", "email" }`), `authoredAt` and `committedAt` (Unix seconds), and
//!   `message`. A request or pack that does not read is `1` and the error.
//!
//! `shelfkit_abi_version()` changes whenever any of this does.

use serde::{Deserialize, Serialize};
use shelfkit_compiler::VendorFile;
use shelfkit_compiler::engine::{
    Request, inventory, package_profile, plan, recommend_markers, resolution,
};
use shelfkit_compiler::output::{self, Plan, Refusal, Snapshot};
use shelfkit_core::OnConflict;
use shelfkit_core::item::Markers;
use shelfkit_core::{Error, ErrorKind, Errors, FileSource, Listing, MemorySource};
use shelfkit_registry::protocol::{self, Payload, Prepared};
use shelfkit_registry::{Access, Context, Credential};
use std::cell::RefCell;

pub mod git;

/// What `shelfkit_plan` returns.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// The output is the plan.
    Planned = 0,
    /// The shelf or the profile does not compile; the output lists why.
    Failed = 1,
    /// The request itself is malformed; the output says how.
    BadRequest = 2,
}

/// The ABI's version, for a host to check before it calls anything else.
pub const ABI_VERSION: u32 = 7;

/// The largest request the module accepts, in bytes.
pub const MAX_INPUT: u32 = 512 * 1024 * 1024;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_abi_version() -> u32 {
    ABI_VERSION
}

/// Size the input buffer to `len` bytes, zeroed, and return its address, or
/// null when `len` is over [`MAX_INPUT`] or the memory cannot be reserved.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_input(len: u32) -> *mut u8 {
    // Release the old buffer first, then build the new one outside any borrow.
    drop(INPUT.take());
    if len > MAX_INPUT {
        return std::ptr::null_mut();
    }
    let mut input = Vec::new();
    if input.try_reserve_exact(len as usize).is_err() {
        return std::ptr::null_mut();
    }
    input.resize(len as usize, 0);
    let pointer = input.as_mut_ptr();
    INPUT.set(input);
    pointer
}

/// Plan the request in the input buffer; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_plan() -> u32 {
    exchange(respond)
}

/// Package a profile for a registry; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_package() -> u32 {
    exchange(package)
}

/// Index a whole shelf; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_inventory() -> u32 {
    exchange(index)
}

/// Resolve one profile; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_resolve() -> u32 {
    exchange(resolve)
}

/// Recommend from a repository's markers; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_recommend() -> u32 {
    exchange(recommend)
}

/// Plan what compiling into a repository writes; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_output() -> u32 {
    exchange(repository_output)
}

/// Step 1 of a registry request; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_registry_prepare() -> u32 {
    exchange(registry_prepare)
}

/// Step 2 of a registry request; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_registry_respond() -> u32 {
    exchange(registry_respond)
}

/// Plan a commit and the request that pushes it; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_git_commit() -> u32 {
    exchange(git::commit)
}

/// Read a receive-pack report; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_git_report() -> u32 {
    exchange(git::report)
}

/// Read a receive-pack request as a server does; see the crate documentation.
#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_git_receive() -> u32 {
    exchange(git::receive)
}

/// Run `call` on the input buffer and leave its answer in the output buffer,
/// holding no borrow of either while it runs.
fn exchange(call: fn(&[u8]) -> (Status, Vec<u8>)) -> u32 {
    drop(OUTPUT.take());
    let input = INPUT.take();
    let (status, output) = call(&input);
    drop(input);
    OUTPUT.set(output);
    status as u32
}

#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_output_ptr() -> *const u8 {
    OUTPUT.with_borrow(|output| output.as_ptr())
}

#[allow(unsafe_code)] // Exporting the symbol; there is no unsafe block.
#[unsafe(no_mangle)]
pub extern "C" fn shelfkit_output_len() -> u32 {
    OUTPUT.with_borrow(|output| u32::try_from(output.len()).unwrap_or(u32::MAX))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanInput {
    files: Vec<FileInput>,
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    override_profile: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileInput {
    path: String,
    #[serde(default)]
    contents: Option<String>,
    #[serde(default)]
    encoding: Encoding,
    /// A symbolic link the host found, which the shelf refuses.
    #[serde(default)]
    symlink: bool,
}

/// A shelf in memory, plus the symbolic links its host found. Listing a
/// directory reports each link under it as the loader's `DirSource` does.
struct HostShelf {
    files: MemorySource,
    links: Vec<String>,
}

impl FileSource for HostShelf {
    fn list(&self, dir: &str) -> Listing {
        let mut listing = self.files.list(dir);
        let prefix = format!("{}/", dir.trim_end_matches('/'));
        for link in self.links.iter().filter(|link| link.starts_with(&prefix)) {
            listing.errors.push(Error::new(
                link.clone(),
                ErrorKind::Path("symbolic links are not allowed in a shelf".into()),
            ));
        }
        listing
    }

    fn read(&self, path: &str) -> shelfkit_core::Result<Vec<u8>> {
        self.files.read(path)
    }
}

#[derive(Deserialize, Default, PartialEq, Eq)]
enum Encoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

#[derive(Serialize)]
struct Failure {
    errors: Vec<Problem>,
}

#[derive(Serialize)]
struct Problem {
    path: String,
    message: String,
}

/// Answer one plan request: the status and the bytes of the output. Plain
/// Rust, so the native tests drive exactly what the exports run.
pub fn respond(input: &[u8]) -> (Status, Vec<u8>) {
    let (source, plan_request) = match shelf_request(input) {
        Ok(parsed) => parsed,
        Err(answer) => return answer,
    };
    match plan(&source, &plan_request) {
        Ok(compiled) => (Status::Planned, compiled.to_json().into_bytes()),
        Err(errors) => (Status::Failed, failure(errors)),
    }
}

/// Package a profile: the output of `shelfkit_package`.
pub fn package(input: &[u8]) -> (Status, Vec<u8>) {
    let (source, request) = match shelf_request(input) {
        Ok(parsed) => parsed,
        Err(answer) => return answer,
    };
    match package_profile(&source, &request) {
        Ok(packaged) => {
            let mut value = serde_json::to_value(&packaged).unwrap_or_default();
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "archive".to_owned(),
                    serde_json::Value::String(shelfkit_registry::base64::encode(&packaged.archive)),
                );
            }
            (
                Status::Planned,
                serde_json::to_vec(&value).unwrap_or_default(),
            )
        }
        Err(errors) => (Status::Failed, failure(errors)),
    }
}

/// Index a shelf: the output of `shelfkit_inventory`.
pub fn index(input: &[u8]) -> (Status, Vec<u8>) {
    let (source, request) = match shelf_request(input) {
        Ok(parsed) => parsed,
        Err(answer) => return answer,
    };
    if request.profile.is_some() || request.override_profile.is_some() {
        return bad_request("an inventory request takes `files` only".to_owned());
    }
    match inventory(&source) {
        Ok(found) => (
            Status::Planned,
            serde_json::to_vec(&found).unwrap_or_default(),
        ),
        Err(errors) => (Status::Failed, failure(errors)),
    }
}

/// Resolve a profile: the output of `shelfkit_resolve`.
pub fn resolve(input: &[u8]) -> (Status, Vec<u8>) {
    let (source, request) = match shelf_request(input) {
        Ok(parsed) => parsed,
        Err(answer) => return answer,
    };
    match resolution(&source, &request) {
        Ok(resolved) => (
            Status::Planned,
            serde_json::to_vec(&resolved).unwrap_or_default(),
        ),
        Err(errors) => (Status::Failed, failure(errors)),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecommendInput {
    files: Vec<FileInput>,
    markers: Markers,
}

/// Recommend from markers: the output of `shelfkit_recommend`.
pub fn recommend(input: &[u8]) -> (Status, Vec<u8>) {
    let request: RecommendInput = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a recommend request: {error}")),
    };
    let source = match host_shelf(request.files) {
        Ok(source) => source,
        Err(answer) => return answer,
    };
    match recommend_markers(&source, &request.markers) {
        Ok(found) => (
            Status::Planned,
            serde_json::to_vec(&found).unwrap_or_default(),
        ),
        Err(errors) => (Status::Failed, failure(errors)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputInput {
    plan: OutputPlan,
    #[serde(default)]
    on_conflict: OnConflict,
    repo: Snapshot,
}

/// The parts of a plan that decide what is written; the rest is ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputPlan {
    profile: String,
    apm_yml: String,
    files: Vec<VendorFile>,
}

#[derive(Serialize)]
struct WriteFile {
    path: String,
    contents: String,
    encoding: &'static str,
}

#[derive(Serialize, Default)]
struct OutputAnswer {
    write: Vec<WriteFile>,
    remove: Vec<String>,
    prune: Vec<String>,
    conflicts: Vec<String>,
    refused: Vec<String>,
}

/// What compiling into a repository writes: the output of `shelfkit_output`.
pub fn repository_output(input: &[u8]) -> (Status, Vec<u8>) {
    let request: OutputInput = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not an output request: {error}")),
    };
    if let Err(why) = request.repo.validate() {
        return bad_request(format!("repo: {why}"));
    }
    let plan = Plan {
        profile: &request.plan.profile,
        apm_yml: &request.plan.apm_yml,
        files: &request.plan.files,
    };
    let answer = match output::output(plan, &request.repo, request.on_conflict) {
        Ok(out) => OutputAnswer {
            write: out
                .files
                .into_iter()
                .map(|(path, bytes)| match String::from_utf8(bytes) {
                    Ok(contents) => WriteFile {
                        path,
                        contents,
                        encoding: "utf-8",
                    },
                    Err(error) => WriteFile {
                        path,
                        contents: shelfkit_compiler::base64::encode(error.as_bytes()),
                        encoding: "base64",
                    },
                })
                .collect(),
            remove: out.remove,
            prune: out.prune,
            conflicts: out.conflicts,
            refused: Vec::new(),
        },
        Err(Refusal::Refused(refused)) => OutputAnswer {
            refused,
            ..OutputAnswer::default()
        },
        Err(Refusal::Plan(why)) => return bad_request(format!("plan: {why}")),
        Err(refusal) => {
            let body = Failure {
                errors: vec![Problem {
                    path: output::APM_YML.to_owned(),
                    message: refusal.message("the repository", output::APM_YML),
                }],
            };
            return (
                Status::Failed,
                serde_json::to_vec(&body).unwrap_or_default(),
            );
        }
    };
    (
        Status::Planned,
        serde_json::to_vec(&answer).unwrap_or_default(),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PrepareInput {
    method: String,
    path: String,
    /// The path the registry's base URL adds, as `/apm`; empty at the root.
    #[serde(default)]
    mount: String,
    #[serde(default)]
    authorization: Option<String>,
}

/// Step 1 of a registry request: the output of `shelfkit_registry_prepare`.
pub fn registry_prepare(input: &[u8]) -> (Status, Vec<u8>) {
    let request: PrepareInput = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a prepare request: {error}")),
    };
    let output = match protocol::prepare(
        &request.method,
        &request.path,
        &request.mount,
        request.authorization.as_deref(),
    ) {
        Prepared::Respond(response) => serde_json::json!({ "respond": response }),
        Prepared::Route { route, credential } => {
            let credential = match credential {
                Credential::None => serde_json::json!({ "kind": "none" }),
                Credential::Unreadable(_) => serde_json::json!({ "kind": "unreadable" }),
                Credential::Key(key) => serde_json::json!({ "kind": "key", "key": key }),
            };
            let package = route.package();
            serde_json::json!({
                "route": route,
                "packageKey": package.key(),
                "ownerKey": package.owner_key(),
                "credential": credential,
            })
        }
    };
    (
        Status::Planned,
        serde_json::to_vec(&output).unwrap_or_default(),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RespondInput {
    method: String,
    path: String,
    #[serde(default)]
    mount: String,
    access: Access,
    context: Context,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    if_none_match: Option<String>,
    /// The request body, base64.
    #[serde(default)]
    body: Option<String>,
    now: String,
}

/// Step 2 of a registry request: the output of `shelfkit_registry_respond`.
pub fn registry_respond(input: &[u8]) -> (Status, Vec<u8>) {
    let request: RespondInput = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return bad_request(format!("not a respond request: {error}")),
    };
    let body = match request.body.as_deref() {
        None => Vec::new(),
        Some(text) => match shelfkit_registry::base64::decode(text) {
            Some(bytes) => bytes,
            None => return bad_request("`body` is not valid base64".to_owned()),
        },
    };
    let route = match protocol::prepare(&request.method, &request.path, &request.mount, None) {
        Prepared::Route { route, .. } => route,
        Prepared::Respond(response) => {
            let output = serde_json::json!({ "response": response });
            return (
                Status::Planned,
                serde_json::to_vec(&output).unwrap_or_default(),
            );
        }
    };
    let payload = Payload {
        content_type: request.content_type.as_deref(),
        if_none_match: request.if_none_match.as_deref(),
        body: &body,
    };
    let outcome = protocol::respond(
        &route,
        &request.path,
        &request.access,
        &request.context,
        payload,
        &request.now,
    );
    (
        Status::Planned,
        serde_json::to_vec(&outcome).unwrap_or_default(),
    )
}

/// Read a shelf request (`shelfkit_plan`, `shelfkit_package`).
fn shelf_request(input: &[u8]) -> Result<(HostShelf, Request), (Status, Vec<u8>)> {
    let request: PlanInput = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return Err(bad_request(format!("not a plan request: {error}"))),
    };
    let source = host_shelf(request.files)?;
    let plan_request = Request {
        profile: request.profile,
        override_profile: request.override_profile,
        ..Request::default()
    };
    Ok((source, plan_request))
}

/// The shelf a request's `files` describe.
fn host_shelf(files: Vec<FileInput>) -> Result<HostShelf, (Status, Vec<u8>)> {
    let mut source = HostShelf {
        files: MemorySource::new(),
        links: Vec::new(),
    };
    for file in files {
        if file.symlink {
            source.links.push(file.path);
            continue;
        }
        let Some(contents) = file.contents else {
            return Err(bad_request(format!(
                "{}: a file needs `contents`",
                file.path
            )));
        };
        let bytes = match file.encoding {
            Encoding::Utf8 => contents.into_bytes(),
            Encoding::Base64 => match shelfkit_compiler::base64::decode(&contents) {
                Some(bytes) => bytes,
                None => {
                    return Err(bad_request(format!(
                        "{}: contents are not valid base64",
                        file.path
                    )));
                }
            },
        };
        source.files.insert(file.path, bytes);
    }
    Ok(source)
}

fn failure(errors: Errors) -> Vec<u8> {
    let errors = errors
        .into_iter()
        .map(|error| Problem {
            path: error.path,
            message: error.kind.to_string(),
        })
        .collect();
    serde_json::to_vec(&Failure { errors }).unwrap_or_default()
}

fn bad_request(message: String) -> (Status, Vec<u8>) {
    let body = Failure {
        errors: vec![Problem {
            path: "<request>".to_owned(),
            message,
        }],
    };
    (
        Status::BadRequest,
        serde_json::to_vec(&body).unwrap_or_default(),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn request(files: &[(&str, &str)], profile: Option<&str>) -> Vec<u8> {
        let files: Vec<serde_json::Value> = files
            .iter()
            .map(|(path, contents)| serde_json::json!({ "path": path, "contents": contents }))
            .collect();
        serde_json::to_vec(&serde_json::json!({ "files": files, "profile": profile })).unwrap()
    }

    #[test]
    fn plans_through_the_buffers() {
        let body = request(
            &[
                ("shelf.json", r#"{ "name": "t" }"#),
                (
                    "profiles/p.json",
                    r#"{ "id": "p", "title": "P", "items": [] }"#,
                ),
            ],
            Some("p"),
        );
        let len = u32::try_from(body.len()).unwrap();
        let ptr = shelfkit_input(len);
        assert!(!ptr.is_null());
        INPUT.with_borrow_mut(|input| input.copy_from_slice(&body));
        assert_eq!(shelfkit_plan(), Status::Planned as u32);
        let output = OUTPUT.with_borrow(Clone::clone);
        assert_eq!(shelfkit_output_len() as usize, output.len());
        let plan: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(plan["apmYml"], "name: p\nversion: \"0.0.0\"\n");
    }

    #[test]
    fn a_shelf_that_does_not_load_is_a_failure_with_paths() {
        let (status, output) = respond(&request(&[("profiles/p.json", "{")], Some("p")));
        assert_eq!(status, Status::Failed);
        let body: serde_json::Value = serde_json::from_slice(&output).unwrap();
        let paths: Vec<&str> = body["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"shelf.json"), "{paths:?}");
        assert!(paths.contains(&"profiles/p.json"), "{paths:?}");
    }

    #[test]
    fn an_oversized_input_is_refused_and_the_next_call_still_works() {
        assert!(shelfkit_input(u32::MAX).is_null());
        assert!(shelfkit_input(MAX_INPUT + 1).is_null());
        let body = request(
            &[
                ("shelf.json", r#"{ "name": "t" }"#),
                (
                    "profiles/p.json",
                    r#"{ "id": "p", "title": "P", "items": [] }"#,
                ),
            ],
            Some("p"),
        );
        let ptr = shelfkit_input(u32::try_from(body.len()).unwrap());
        assert!(!ptr.is_null());
        INPUT.with_borrow_mut(|input| input.copy_from_slice(&body));
        assert_eq!(shelfkit_plan(), Status::Planned as u32);
        // No borrow is left behind by either call.
        assert!(
            INPUT
                .try_with(|cell| cell.try_borrow_mut().is_ok())
                .unwrap()
        );
        assert!(
            OUTPUT
                .try_with(|cell| cell.try_borrow_mut().is_ok())
                .unwrap()
        );
    }

    #[test]
    fn a_symlink_the_host_found_fails_the_load_as_on_disk() {
        let body = serde_json::json!({
            "files": [
                { "path": "shelf.json", "contents": "{ \"name\": \"t\" }" },
                { "path": "profiles/p.json", "contents": "{ \"id\": \"p\", \"title\": \"P\", \"items\": [] }" },
                { "path": "items/prompts/x/link.md", "symlink": true }
            ],
            "profile": "p"
        });
        let (status, output) = respond(&serde_json::to_vec(&body).unwrap());
        assert_eq!(status, Status::Failed);
        let body: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(body["errors"][0]["path"], "items/prompts/x/link.md");
        assert_eq!(
            body["errors"][0]["message"],
            "invalid path: symbolic links are not allowed in a shelf"
        );
    }

    #[test]
    fn a_malformed_request_is_a_bad_request() {
        assert_eq!(respond(b"[]").0, Status::BadRequest);
        let bad = br#"{ "files": [{ "path": "a", "contents": "!", "encoding": "base64" }] }"#;
        assert_eq!(respond(bad).0, Status::BadRequest);
        assert_eq!(
            respond(br#"{ "files": [], "extra": 1 }"#).0,
            Status::BadRequest
        );
    }

    fn shelf_files() -> serde_json::Value {
        serde_json::json!({
            "files": [
                { "path": "shelf.json", "contents": "{ \"name\": \"t\", \"registry\": { \"namespace\": \"acme\", \"public\": true } }" },
                { "path": "items/prompts/hi/item.json", "contents": "{ \"id\": \"hi\", \"kind\": \"prompt\", \"title\": \"Hi\" }" },
                { "path": "items/prompts/hi/prompt.md", "contents": "Say hi.\n" },
                { "path": "profiles/p.json", "contents": "{ \"id\": \"p\", \"title\": \"P\", \"items\": [\"hi\"] }" }
            ],
            "profile": "p"
        })
    }

    #[test]
    fn packages_a_profile_with_the_archive_in_base64() {
        let (status, output) = package(&serde_json::to_vec(&shelf_files()).unwrap());
        assert_eq!(status, Status::Planned);
        let body: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(body["package"], "acme/p");
        let archive = shelfkit_registry::base64::decode(body["archive"].as_str().unwrap()).unwrap();
        assert_eq!(body["digest"], shelfkit_registry::digest(&archive));
        assert_eq!(body["sizeBytes"], archive.len());
    }

    #[test]
    fn indexes_a_shelf_with_revisions_and_resolutions() {
        let mut body = shelf_files();
        body.as_object_mut().unwrap().remove("profile");
        let (status, output) = index(&serde_json::to_vec(&body).unwrap());
        assert_eq!(status, Status::Planned);
        let found: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(found["manifest"]["registry"]["namespace"], "acme");
        assert_eq!(found["items"][0]["item"]["id"], "hi");
        assert_eq!(found["items"][0]["path"], "items/prompts/hi");
        assert_eq!(
            found["items"][0]["files"],
            serde_json::json!(["item.json", "prompt.md"])
        );
        assert_eq!(found["items"][0]["coordinate"]["kind"], "vendored");
        assert_eq!(found["profiles"][0]["profile"]["id"], "p");
        assert_eq!(
            found["profiles"][0]["resolution"]["items"][0]["revision"],
            found["items"][0]["revision"]
        );
        // A profile is a different request.
        assert_eq!(
            index(&serde_json::to_vec(&shelf_files()).unwrap()).0,
            Status::BadRequest
        );
    }

    #[test]
    fn resolves_an_unsaved_profile() {
        let mut body = shelf_files();
        let object = body.as_object_mut().unwrap();
        object.remove("profile");
        object.insert(
            "overrideProfile".to_owned(),
            serde_json::json!({ "id": "draft", "title": "Draft", "items": ["hi"] }),
        );
        let (status, output) = resolve(&serde_json::to_vec(&body).unwrap());
        assert_eq!(status, Status::Planned);
        let resolved: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(resolved["id"], "draft");
        assert_eq!(resolved["items"][0]["id"], "hi");
        assert_eq!(resolved["items"][0]["pinned"], false);
    }

    #[test]
    fn recommends_from_markers() {
        let body = serde_json::json!({
            "files": [
                { "path": "shelf.json", "contents": "{ \"name\": \"t\" }" },
                { "path": "items/stacks/vue/item.json", "contents": "{ \"id\": \"vue\", \"kind\": \"stack\", \"title\": \"Vue\", \"markers\": { \"dependencies\": [\"vue\"] } }" }
            ],
            "markers": { "dependencies": ["vue", "react"] }
        });
        let (status, output) = recommend(&serde_json::to_vec(&body).unwrap());
        assert_eq!(status, Status::Planned);
        let found: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(found["items"][0]["id"], "vue");
        assert_eq!(
            found["items"][0]["matched"]["dependencies"],
            serde_json::json!(["vue"])
        );
    }

    fn output_request(repo: serde_json::Value, on_conflict: &str) -> Vec<u8> {
        let (_, plan) = respond(&serde_json::to_vec(&shelf_files()).unwrap());
        let plan: serde_json::Value = serde_json::from_slice(&plan).unwrap();
        serde_json::to_vec(
            &serde_json::json!({ "plan": plan, "onConflict": on_conflict, "repo": repo }),
        )
        .unwrap()
    }

    #[test]
    fn plans_the_output_into_a_snapshot() {
        let repo = serde_json::json!({
            "vendor": [{
                "name": "p",
                "apmYml": "name: p\nx-shelfkit-vendored-for: p\n",
                "files": [".apm/old/stale.md"]
            }]
        });
        let (status, answer) = repository_output(&output_request(repo, "fail"));
        assert_eq!(status, Status::Planned);
        let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(answer["write"][0]["path"], "apm.yml");
        assert_eq!(answer["write"][0]["encoding"], "utf-8");
        assert_eq!(
            answer["remove"],
            serde_json::json!(["vendor/p/.apm/old/stale.md"])
        );
        assert_eq!(answer["refused"], serde_json::json!([]));
        assert_eq!(answer["prune"], serde_json::json!(["vendor/p/.apm/old"]));
    }

    #[test]
    fn a_conflicting_manifest_under_fail_is_an_error_on_apm_yml() {
        let repo = serde_json::json!({ "apmYml": "name: mine\ndependencies:\n  apm:\n    - ./vendor/p#v1\n" });
        let (status, answer) = repository_output(&output_request(repo.clone(), "fail"));
        assert_eq!(status, Status::Failed);
        let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(answer["errors"][0]["path"], "apm.yml");
        let (status, _) = repository_output(&output_request(repo, "local-wins"));
        assert_eq!(status, Status::Planned);
        let bad = output_request(serde_json::json!({ "links": ["../out"] }), "fail");
        assert_eq!(repository_output(&bad).0, Status::BadRequest);
    }

    #[test]
    fn a_crafted_plan_writes_nothing_outside_a_package() {
        let (_, plan) = respond(&serde_json::to_vec(&shelf_files()).unwrap());
        let mut plan: serde_json::Value = serde_json::from_slice(&plan).unwrap();
        let crafted = [
            "../outside.txt",
            "/etc/evil",
            "vendor/../.git/hooks/pre-commit",
            ".github/workflows/x.yml",
        ];
        let files = plan["files"].as_array_mut().unwrap();
        for path in crafted {
            files.push(serde_json::json!({ "path": path, "contents": "x" }));
        }
        let body = serde_json::json!({ "plan": plan, "repo": { "vendor": [] } });
        let (status, answer) = repository_output(&serde_json::to_vec(&body).unwrap());
        assert_eq!(status, Status::Planned);
        let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
        assert_eq!(answer["write"], serde_json::json!([]));
        let refused = answer["refused"].as_array().unwrap();
        assert_eq!(refused.len(), crafted.len());
        for path in crafted {
            assert!(
                refused
                    .iter()
                    .any(|line| line.as_str().unwrap().contains(&format!("`{path}`"))),
                "{path}"
            );
        }
    }

    #[test]
    fn a_registry_request_runs_in_two_steps() {
        let (_, prepared) = registry_prepare(
            br#"{ "method": "GET", "path": "/v1/packages/acme/p/versions", "authorization": "Bearer k" }"#,
        );
        let prepared: serde_json::Value = serde_json::from_slice(&prepared).unwrap();
        assert_eq!(prepared["route"]["operation"], "list");
        assert_eq!(prepared["packageKey"], "acme/p");
        assert_eq!(
            prepared["credential"],
            serde_json::json!({ "kind": "key", "key": "k" })
        );

        let (_, missing) = registry_prepare(br#"{ "method": "GET", "path": "/nothing" }"#);
        let missing: serde_json::Value = serde_json::from_slice(&missing).unwrap();
        assert_eq!(missing["respond"]["status"], 404);

        let request = serde_json::json!({
            "method": "GET",
            "path": "/v1/packages/acme/p/versions",
            "access": { "credential": "anonymous" },
            "context": { "shelf": { "public": false }, "versions": [] },
            "now": "2026-10-19T12:00:00Z"
        });
        let (_, output) = registry_respond(&serde_json::to_vec(&request).unwrap());
        let outcome: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(outcome["response"]["status"], 401);
        assert!(outcome.get("publish").is_none());
    }
}
