//! The hosted service's client: `shelfkit login`, `logout`, `open`, `push`,
//! and `fetch` (`docs/PRD.md` sections 4.1 and 10.3).
//!
//! A deployment is addressed by its URL. `login` asks for a key created in
//! the web UI (or the owner key `moon run worker:setup` printed), checks it,
//! and keeps it in the OS keychain under the service `shelfkit` with the URL
//! as the account; it also remembers the URL as the default. Every other
//! command reads the key from `SHELFKIT_KEY` when it is set (for CI and
//! agents), else from the keychain. A key is never printed, logged, or put
//! in an error.
//!
//! `push` uploads every file of the shelf to `/raw/{shelf}/objects/{sha256}`,
//! commits them as the shelf's snapshot over GraphQL, and publishes each
//! profile to the deployment's OpenAPM registry with the same deterministic
//! packaging `serve` uses. `fetch` writes the hosted snapshot back into a
//! directory. All network access goes through [`System::http`].

use super::system::{HttpRequest, HttpResponse, System};
use super::{Context, Failure, Outcome, absolute};
use crate::engine::{Request, inventory, package_profile};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shelfkit_core::{DirSource, Errors};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The environment variable a key is read from before the keychain.
pub const KEY_ENV: &str = "SHELFKIT_KEY";
/// The environment variable the deployment's URL is read from before the
/// remembered default.
pub const URL_ENV: &str = "SHELFKIT_URL";

/// The directories of a shelf the format reads, besides `shelf.json`.
const SHELF_DIRECTORIES: [&str; 3] = ["items", "bundles", "profiles"];

/// Check and normalize a deployment's URL to its origin: `https://`, or plain
/// `http://` only for a loopback host (a local `wrangler dev`).
pub fn normalize_url(text: &str) -> Result<String, String> {
    let trimmed = text.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| format!("`{trimmed}` is not a URL: use https://<host>"))?;
    let host = rest.split('/').next().unwrap_or_default();
    if host.is_empty() || host.contains('@') || rest.contains('?') || rest.contains('#') {
        return Err(format!(
            "`{trimmed}` is not a deployment URL: use https://<host>"
        ));
    }
    let hostname = host
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map_or(host, |(name, _)| name);
    let loopback = matches!(hostname, "localhost" | "127.0.0.1" | "[::1]");
    match scheme.to_ascii_lowercase().as_str() {
        "https" => Ok(format!("https://{}", host.to_ascii_lowercase())),
        "http" if loopback => Ok(format!("http://{}", host.to_ascii_lowercase())),
        _ => Err(format!(
            "`{trimmed}`: a deployment is reached over https (plain http only on loopback)"
        )),
    }
}

/// The remembered default deployment: `<config>/shelfkit/config.json`.
fn config_file(system: &dyn System) -> Option<PathBuf> {
    system
        .config_dir()
        .map(|dir| dir.join("shelfkit").join("config.json"))
}

fn remembered_url(system: &dyn System) -> Option<String> {
    let text = std::fs::read_to_string(config_file(system)?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("url")?.as_str().map(str::to_owned)
}

fn remember_url(system: &dyn System, url: &str) -> Result<(), String> {
    let Some(file) = config_file(system) else {
        return Ok(());
    };
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    }
    let text = format!("{}\n", pretty(&json!({ "url": url })));
    std::fs::write(&file, text).map_err(|error| format!("{}: {error}", file.display()))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// The deployment a command talks to: `--url`, else `SHELFKIT_URL`, else the
/// one `login` remembered.
pub(super) fn deployment(system: &dyn System, url: Option<&str>) -> Result<String, String> {
    let chosen = url
        .map(str::to_owned)
        .or_else(|| system.var(URL_ENV))
        .or_else(|| remembered_url(system))
        .ok_or_else(|| {
            format!(
                "which deployment? Pass `--url https://<host>`, set {URL_ENV}, or run `shelfkit login <url>`"
            )
        })?;
    normalize_url(&chosen)
}

/// A deployment and the key to use with it.
pub struct Remote<'a> {
    system: &'a dyn System,
    url: String,
    key: String,
}

impl<'a> Remote<'a> {
    /// Connect to the deployment with the key from `SHELFKIT_KEY` or the
    /// keychain.
    pub fn connect(system: &'a dyn System, url: Option<&str>) -> Result<Self, String> {
        let url = deployment(system, url)?;
        let key = match system.var(KEY_ENV) {
            Some(key) => key,
            None => system
                .keychain_get(&url)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    format!("no key for {url}: run `shelfkit login {url}`, or set {KEY_ENV}")
                })?,
        };
        Ok(Self { system, url, key })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    fn send(
        &self,
        method: &'static str,
        path: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Result<HttpResponse, String> {
        let mut headers = vec![("authorization".to_owned(), format!("Bearer {}", self.key))];
        if let Some(content_type) = content_type {
            headers.push(("content-type".to_owned(), content_type.to_owned()));
        }
        self.system
            .http(&HttpRequest {
                body,
                headers,
                method,
                url: format!("{}{path}", self.url),
            })
            .map_err(|error| format!("{method} {}{path}: {error}", self.url))
    }

    /// Run a GraphQL operation and return its `data`, or every error message.
    pub fn graphql(&self, query: &str, variables: Value) -> Result<Value, String> {
        let body = serde_json::to_vec(&json!({ "query": query, "variables": variables }))
            .unwrap_or_default();
        let response = self.send("POST", "/graphql", Some("application/json"), body)?;
        if response.status == 401 {
            return Err(format!(
                "{} refused the key: it is unknown or revoked. Run `shelfkit login {}` with a valid key",
                self.url, self.url
            ));
        }
        let value: Value = serde_json::from_slice(&response.body).map_err(|_| {
            format!(
                "{}/graphql answered {} with a body that is not JSON",
                self.url, response.status
            )
        })?;
        if let Some(errors) = value.get("errors").and_then(Value::as_array)
            && !errors.is_empty()
        {
            let messages: Vec<&str> = errors
                .iter()
                .filter_map(|error| error.get("message").and_then(Value::as_str))
                .collect();
            return Err(messages.join("; "));
        }
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `+` and anything else outside the URL path's unreserved set, escaped.
pub(super) fn encode_segment(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

const VIEWER: &str = "query Viewer { viewer { authenticated owner shelf keyName } }";

/// `shelfkit login [URL]`: check a key against the deployment and keep it in
/// the OS keychain.
pub(super) fn login(ctx: &mut Context<'_>, url: Option<&str>) -> Outcome {
    let url = deployment(ctx.system, url)?;
    let key = ctx
        .system
        .read_secret(&format!("Key for {url}: "))
        .map_err(|error| format!("reading the key: {error}"))?;
    if key.is_empty() {
        return Err("no key given".to_owned().into());
    }
    let remote = Remote {
        key,
        system: ctx.system,
        url: url.clone(),
    };
    let viewer = remote.graphql(VIEWER, json!({}))?;
    let viewer = &viewer["viewer"];
    if viewer["authenticated"] != Value::Bool(true) {
        return Err(format!("{url} does not know this key").into());
    }
    ctx.system
        .keychain_set(&url, &remote.key)
        .map_err(|error| error.to_string())?;
    remember_url(ctx.system, &url)?;
    let who = if viewer["owner"] == Value::Bool(true) {
        "the owner".to_owned()
    } else {
        format!(
            "a key of the shelf `{}`",
            viewer["shelf"].as_str().unwrap_or("?")
        )
    };
    let _ = writeln!(
        ctx.stdout,
        "Logged in to {url} as {who}. The key is in the OS keychain (service `{}`, account `{url}`), \
         and {url} is the default deployment.",
        super::system::KEYCHAIN_SERVICE
    );
    Ok(())
}

/// `shelfkit logout [URL]`: forget the key kept for a deployment.
pub(super) fn logout(ctx: &mut Context<'_>, url: Option<&str>) -> Outcome {
    let url = deployment(ctx.system, url)?;
    let removed = ctx
        .system
        .keychain_delete(&url)
        .map_err(|error| error.to_string())?;
    let _ = writeln!(
        ctx.stdout,
        "{}",
        if removed {
            format!("Removed the key for {url} from the OS keychain.")
        } else {
            format!("The OS keychain held no key for {url}.")
        }
    );
    Ok(())
}

const SIGN_IN_LINK: &str = "mutation SignInLink { createSignInLink { url expiresAt } }";

/// The program that opens a URL in the user's browser: `xdg-open` (Linux and the BSDs), `open` (macOS), or
/// `explorer` (Windows), and whether its exit status means anything. `explorer` exits 1 after opening a URL, so its
/// status is not read.
fn browser_opener(system: &dyn System) -> Option<(PathBuf, bool)> {
    let (candidates, meaningful): (&[&str], bool) = match system.platform() {
        super::system::Platform::Unix => (&["xdg-open", "open"], true),
        super::system::Platform::Windows => (&["explorer"], false),
    };
    candidates
        .iter()
        .find_map(|program| system.find(program))
        .map(|path| (path, meaningful))
}

/// The path a URL names after its host, as `/shelves/x` in `https://host/shelves/x`; `None` for the bare origin.
fn url_path(text: &str) -> Option<String> {
    let (_, rest) = text.trim().split_once("://")?;
    let path = rest[rest.find('/')?..].trim_end_matches('/');
    (!path.is_empty()).then(|| path.to_owned())
}

/// A sign-in link that goes on to `path` once used: the web UI reads `?next=`, and the token stays in the fragment.
fn continue_to(link: &str, path: &str) -> String {
    let (base, token) = link.split_once('#').unwrap_or((link, ""));
    format!("{base}?next={}#{token}", encode_segment(path))
}

/// `shelfkit open [URL]`: make a one-time sign-in link with the owner key and open it in the browser. The link is a
/// credential until used, so it is printed only with `--print`; without it, a failure to open says to use `--print`.
pub(super) fn open(ctx: &mut Context<'_>, url: Option<&str>, print: bool) -> Outcome {
    let remote = Remote::connect(ctx.system, url)?;
    if !print && browser_opener(ctx.system).is_none() {
        return Err(
            "found no browser opener (xdg-open, open, or explorer): run `shelfkit open --print` and open the link yourself"
                .to_owned()
                .into(),
        );
    }
    let data = remote.graphql(SIGN_IN_LINK, json!({})).map_err(|error| {
        format!(
            "{error}: `shelfkit open` needs the owner key, which signs the browser in as the owner"
        )
    })?;
    let link = data["createSignInLink"]["url"]
        .as_str()
        .ok_or_else(|| format!("{} answered with no sign-in link", remote.url()))?;
    let link = match url.and_then(url_path) {
        Some(path) => continue_to(link, &path),
        None => link.to_owned(),
    };
    if print {
        let _ = writeln!(ctx.stdout, "{link}");
        let _ = writeln!(
            ctx.stderr,
            "This link signs a browser in as the owner. It works once, within 15 minutes: open it, add a passkey \
             there, and let nobody else see it."
        );
        return Ok(());
    }
    let Some((program, meaningful)) = browser_opener(ctx.system) else {
        return Err("found no browser opener: run `shelfkit open --print`"
            .to_owned()
            .into());
    };
    let cwd = absolute(ctx, None);
    let code = ctx
        .system
        .run(&program, &[link], &cwd, &[])
        .map_err(|error| format!("opening the browser: {error}; run `shelfkit open --print`"))?;
    if meaningful && code != 0 {
        return Err(format!(
            "the browser opener exited {code}, so the link may not have opened; it was not printed. Run `shelfkit open \
             --print` for a new one"
        )
        .into());
    }
    let _ = writeln!(
        ctx.stdout,
        "Opened {} in your browser, signed in as the owner. Add a passkey there to sign in on that device without a \
         link; the link itself works once, within 15 minutes.",
        remote.url()
    );
    Ok(())
}

/// One file of a shelf on disk.
struct LocalFile {
    path: String,
    bytes: Vec<u8>,
    sha256: String,
}

/// Every file the shelf format reads, sorted by path, as `DirSource` reads
/// them. A symbolic link is an error, as it is for the loader.
fn local_files(root: &Path) -> Result<Vec<LocalFile>, Failure> {
    let mut paths = vec!["shelf.json".to_owned()];
    for directory in SHELF_DIRECTORIES {
        walk(root, &root.join(directory), &mut paths)?;
    }
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let bytes =
                std::fs::read(root.join(&path)).map_err(|error| format!("{path}: {error}"))?;
            Ok(LocalFile {
                sha256: hex(&bytes),
                bytes,
                path,
            })
        })
        .collect()
}

fn walk(root: &Path, dir: &Path, paths: &mut Vec<String>) -> Result<(), Failure> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if kind.is_symlink() {
            return Err(format!("{relative}: symbolic links are not allowed in a shelf").into());
        }
        if kind.is_dir() {
            walk(root, &path, paths)?;
        } else if kind.is_file() {
            paths.push(relative);
        }
    }
    Ok(())
}

const HOSTED: &str = "query Hosted($id: ID!) { shelf(id: $id) { snapshot { digest origin } files { path sha256 size } } }";

/// The hosted shelf's snapshot and files, or `None` when there is none the key
/// can read.
struct Hosted {
    digest: String,
    origin: String,
    files: BTreeMap<String, (String, u64)>,
}

fn hosted(remote: &Remote<'_>, shelf: &str) -> Result<Option<Hosted>, String> {
    let data = remote.graphql(HOSTED, json!({ "id": shelf }))?;
    let found = &data["shelf"];
    let (Some(digest), Some(files)) = (
        found["snapshot"]["digest"].as_str(),
        found["files"].as_array(),
    ) else {
        return Ok(None);
    };
    let files = files
        .iter()
        .filter_map(|file| {
            Some((
                file["path"].as_str()?.to_owned(),
                (file["sha256"].as_str()?.to_owned(), file["size"].as_u64()?),
            ))
        })
        .collect();
    Ok(Some(Hosted {
        digest: digest.to_owned(),
        files,
        origin: found["snapshot"]["origin"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    }))
}

pub(super) struct PushOptions<'a> {
    pub url: Option<&'a str>,
    pub message: Option<&'a str>,
    pub publish: bool,
    pub force: bool,
}

const COMMIT: &str =
    "mutation Push($shelf: ID!, $files: [SnapshotFileInput!]!, $message: String, $parent: String) {
  commitSnapshot(shelf: $shelf, files: $files, message: $message, parent: $parent) {
    ok reason errors { path message } missing snapshot { digest fileCount }
  }
}";

/// `shelfkit push`: upload the shelf, make it the hosted snapshot, and publish
/// its profiles.
pub(super) fn push(ctx: &mut Context<'_>, root: &Path, options: &PushOptions<'_>) -> Outcome {
    let source = DirSource::new(root);
    let found = inventory(&source)?;
    let shelf = found
        .manifest
        .registry
        .as_ref()
        .map(|registry| registry.namespace.clone())
        .ok_or_else(|| {
            "shelf.json has no `registry.namespace`: a hosted shelf is addressed by it".to_owned()
        })?;
    let files = local_files(root)?;
    let remote = Remote::connect(ctx.system, options.url)?;
    let current = hosted(&remote, &shelf)?;

    if let Some(current) = &current {
        let same: BTreeMap<&str, &str> = files
            .iter()
            .map(|file| (file.path.as_str(), file.sha256.as_str()))
            .collect();
        let theirs: BTreeMap<&str, &str> = current
            .files
            .iter()
            .map(|(path, (sha, _))| (path.as_str(), sha.as_str()))
            .collect();
        if same != theirs && current.origin != "push" && !options.force {
            return Err(format!(
                "the hosted shelf `{shelf}` has changes made there (its snapshot {} came from `{}`). \
                 Run `shelfkit fetch` and commit them first, or push with `--force` to replace them",
                current.digest, current.origin
            )
            .into());
        }
    }

    let known: BTreeSet<&str> = current
        .as_ref()
        .map(|current| {
            current
                .files
                .values()
                .map(|(sha, _)| sha.as_str())
                .collect()
        })
        .unwrap_or_default();
    let mut uploaded = 0;
    let mut sent = BTreeSet::new();
    for file in &files {
        if known.contains(file.sha256.as_str()) || !sent.insert(file.sha256.clone()) {
            continue;
        }
        let response = remote.send(
            "PUT",
            &format!("/raw/{shelf}/objects/{}", file.sha256),
            Some("application/octet-stream"),
            file.bytes.clone(),
        )?;
        if response.status != 204 {
            return Err(format!(
                "uploading {} answered {}: {}",
                file.path,
                response.status,
                String::from_utf8_lossy(&response.body)
            )
            .into());
        }
        uploaded += 1;
    }

    let variables = json!({
        "shelf": shelf,
        "files": files.iter().map(|file| json!({ "path": file.path, "sha256": file.sha256, "size": file.bytes.len() })).collect::<Vec<_>>(),
        "message": options.message,
        "parent": current.as_ref().map(|current| current.digest.clone()),
    });
    let committed = remote.graphql(COMMIT, variables)?;
    let committed = &committed["commitSnapshot"];
    if committed["ok"] != Value::Bool(true) {
        for error in committed["errors"].as_array().into_iter().flatten() {
            let _ = writeln!(
                ctx.stderr,
                "{}: {}",
                error["path"].as_str().unwrap_or_default(),
                error["message"].as_str().unwrap_or_default()
            );
        }
        return Err(format!(
            "{} refused the snapshot ({})",
            remote.url(),
            committed["reason"].as_str().unwrap_or("unknown")
        )
        .into());
    }
    let _ = writeln!(
        ctx.stdout,
        "Pushed `{shelf}` to {}: {} files ({uploaded} uploaded), snapshot {}.",
        remote.url(),
        files.len(),
        committed["snapshot"]["digest"].as_str().unwrap_or_default()
    );

    if !options.publish {
        return Ok(());
    }
    let mut failed = false;
    for profile in &found.profiles {
        let id = &profile.profile.id;
        let request = Request {
            profile: Some(id.clone()),
            ..Request::default()
        };
        match package_profile(&source, &request) {
            Ok(packaged) => {
                let outcome = publish(
                    &remote,
                    &packaged.owner,
                    &packaged.repo,
                    &packaged.version,
                    &packaged.digest,
                    packaged.archive.clone(),
                )?;
                match outcome {
                    Published::Created => {
                        let _ = writeln!(
                            ctx.stdout,
                            "Published {}@{} ({}).",
                            packaged.package, packaged.version, packaged.digest
                        );
                    }
                    Published::Already => {
                        let _ = writeln!(
                            ctx.stdout,
                            "{}@{} is already published with these bytes.",
                            packaged.package, packaged.version
                        );
                    }
                    Published::Different => {
                        failed = true;
                        let _ = writeln!(
                            ctx.stderr,
                            "shelfkit: {}@{} is already published with other bytes, and a version is immutable: give the profile a new `version`",
                            packaged.package, packaged.version
                        );
                    }
                }
            }
            Err(errors) => {
                let _ = writeln!(
                    ctx.stdout,
                    "Not published: the profile `{id}` cannot be a registry package ({}).",
                    first_message(&errors)
                );
            }
        }
    }
    if failed {
        return Err(Failure::Reported);
    }
    Ok(())
}

fn first_message(errors: &Errors) -> String {
    errors
        .iter()
        .next()
        .map(|error| format!("{}: {}", error.path, error.kind))
        .unwrap_or_default()
}

enum Published {
    Created,
    Already,
    Different,
}

/// Publish one package version, as APM's registry client would.
fn publish(
    remote: &Remote<'_>,
    owner: &str,
    repo: &str,
    version: &str,
    digest: &str,
    archive: Vec<u8>,
) -> Result<Published, String> {
    let versions = format!("/apm/v1/packages/{owner}/{repo}/versions");
    let response = remote.send(
        "PUT",
        &format!("{versions}/{}", encode_segment(version)),
        Some("application/gzip"),
        archive,
    )?;
    match response.status {
        201 => Ok(Published::Created),
        409 => {
            let listed = remote.send("GET", &versions, None, Vec::new())?;
            let value: Value = serde_json::from_slice(&listed.body).unwrap_or(Value::Null);
            let same = value["versions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|entry| {
                    entry["version"].as_str() == Some(version)
                        && entry["digest"].as_str() == Some(digest)
                });
            Ok(if same {
                Published::Already
            } else {
                Published::Different
            })
        }
        status => Err(format!(
            "publishing {owner}/{repo}@{version} answered {status}: {}",
            String::from_utf8_lossy(&response.body)
        )),
    }
}

pub(super) struct FetchOptions<'a> {
    pub url: Option<&'a str>,
    pub id: Option<&'a str>,
    pub out: Option<&'a Path>,
    pub force: bool,
}

const KNOWN: &str = "query Known($id: ID!, $sha256: [String!]!) { shelf(id: $id) { knownObjects(sha256: $sha256) } }";

/// The local shelf files a fetch would replace or remove whose content the
/// service has never had: work that exists only here.
fn unpushed(
    remote: &Remote<'_>,
    id: &str,
    dir: &Path,
    hosted: &Hosted,
) -> Result<Vec<String>, Failure> {
    let mut local = Vec::new();
    if dir.join("shelf.json").is_file() {
        local.push("shelf.json".to_owned());
    }
    for directory in SHELF_DIRECTORIES {
        walk(dir, &dir.join(directory), &mut local)?;
    }
    let mut changed: Vec<(String, String)> = Vec::new();
    for path in local {
        let bytes = std::fs::read(dir.join(&path)).map_err(|error| format!("{path}: {error}"))?;
        let sha256 = hex(&bytes);
        if hosted
            .files
            .get(&path)
            .is_some_and(|(theirs, _)| *theirs == sha256)
        {
            continue;
        }
        changed.push((path, sha256));
    }
    if changed.is_empty() {
        return Ok(Vec::new());
    }
    let mut known = BTreeSet::new();
    for chunk in changed.chunks(2000) {
        let hashes: Vec<&str> = chunk.iter().map(|(_, sha)| sha.as_str()).collect();
        let data = remote.graphql(KNOWN, json!({ "id": id, "sha256": hashes }))?;
        for found in data["shelf"]["knownObjects"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(sha) = found.as_str() {
                known.insert(sha.to_owned());
            }
        }
    }
    Ok(changed
        .into_iter()
        .filter(|(_, sha)| !known.contains(sha))
        .map(|(path, _)| path)
        .collect())
}

/// Whether a path from the service is one a shelf has: `shelf.json`, or a
/// relative path under `items/`, `bundles/`, or `profiles/` with no `.` or
/// `..` segment.
fn is_shelf_path(path: &str) -> bool {
    if path == "shelf.json" {
        return true;
    }
    let segments: Vec<&str> = path.split('/').collect();
    segments.len() > 1
        && SHELF_DIRECTORIES.contains(&segments[0])
        && segments.iter().all(|segment| {
            !segment.is_empty() && *segment != "." && *segment != ".." && !segment.contains('\\')
        })
}

/// `shelfkit fetch`: write the hosted snapshot into a directory, and remove the
/// shelf files it no longer has.
pub(super) fn fetch(
    ctx: &mut Context<'_>,
    shelf_dir: Option<PathBuf>,
    options: &FetchOptions<'_>,
) -> Outcome {
    let remote = Remote::connect(ctx.system, options.url)?;
    let dir = match (options.out, shelf_dir) {
        (Some(out), _) => absolute(ctx, Some(out)),
        (None, Some(dir)) => absolute(ctx, Some(&dir)),
        (None, None) => ctx
            .cwd
            .ancestors()
            .find(|dir| dir.join("shelf.json").is_file())
            .map_or_else(|| ctx.cwd.clone(), Path::to_path_buf),
    };
    let id = match options.id {
        Some(id) => id.to_owned(),
        None => local_namespace(&dir)
            .or_else(|| {
                remote
                    .graphql(VIEWER, json!({}))
                    .ok()
                    .and_then(|data| data["viewer"]["shelf"].as_str().map(str::to_owned))
            })
            .ok_or_else(|| {
                "which shelf? Pass `--id <shelf>`, or fetch into a shelf whose shelf.json names its `registry.namespace`".to_owned()
            })?,
    };
    let hosted = hosted(&remote, &id)?
        .ok_or_else(|| format!("{} has no shelf `{id}` this key can read", remote.url()))?;
    if !options.force {
        let local_only = unpushed(&remote, &id, &dir, &hosted)?;
        if !local_only.is_empty() {
            for path in &local_only {
                let _ = writeln!(ctx.stderr, "{path}: changed here and never pushed");
            }
            return Err(format!(
                "fetching would replace or remove {} local file(s) the service has never had. Push them first, or \
                 fetch with `--force` to discard them",
                local_only.len()
            )
            .into());
        }
    }
    let mut written = 0;
    for (path, (sha256, _)) in &hosted.files {
        if !is_shelf_path(path) {
            return Err(format!("{} sent a file outside a shelf: `{path}`", remote.url()).into());
        }
        let target = dir.join(path);
        if std::fs::read(&target).is_ok_and(|bytes| hex(&bytes) == *sha256) {
            continue;
        }
        let response = remote.send(
            "GET",
            &format!("/raw/{id}/objects/{sha256}"),
            None,
            Vec::new(),
        )?;
        if response.status != 200 || hex(&response.body) != *sha256 {
            return Err(format!(
                "downloading {path} failed ({}), or its bytes are not {sha256}",
                response.status
            )
            .into());
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        std::fs::write(&target, &response.body)
            .map_err(|error| format!("{}: {error}", target.display()))?;
        written += 1;
    }
    let mut removed = 0;
    if dir.join("shelf.json").is_file() {
        let mut local = Vec::new();
        for directory in SHELF_DIRECTORIES {
            walk(&dir, &dir.join(directory), &mut local)?;
        }
        for path in local {
            if !hosted.files.contains_key(&path) {
                std::fs::remove_file(dir.join(&path))
                    .map_err(|error| format!("{path}: {error}"))?;
                remove_empty_parents(&dir, &dir.join(&path));
                removed += 1;
            }
        }
    }
    let _ = writeln!(
        ctx.stdout,
        "Fetched `{id}` from {} into {}: snapshot {}, {} files ({written} written, {removed} removed).",
        remote.url(),
        dir.display(),
        hosted.digest,
        hosted.files.len()
    );
    Ok(())
}

fn local_namespace(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("shelf.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["registry"]["namespace"].as_str().map(str::to_owned)
}

/// Remove the directories a removed file leaves empty, up to the shelf root.
fn remove_empty_parents(root: &Path, file: &Path) {
    let mut current = file.parent();
    while let Some(dir) = current {
        if dir == root || std::fs::remove_dir(dir).is_err() {
            return;
        }
        current = dir.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deployment_is_https_or_loopback_http() {
        assert_eq!(
            normalize_url("https://Shelf.Example.dev/").unwrap(),
            "https://shelf.example.dev"
        );
        assert_eq!(
            normalize_url("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_url("http://shelf.example.dev").is_err());
        assert!(normalize_url("https://user@shelf.example.dev").is_err());
        assert!(normalize_url("shelf.example.dev").is_err());
    }

    #[test]
    fn a_sign_in_link_goes_on_to_the_page_the_url_names() {
        assert_eq!(url_path("https://shelf.example.dev"), None);
        assert_eq!(url_path("https://shelf.example.dev/"), None);
        assert_eq!(
            url_path("https://shelf.example.dev/shelves/jarettes-box/"),
            Some("/shelves/jarettes-box".to_owned())
        );
        assert_eq!(
            continue_to("https://shelf.example.dev/link#ssl_abc", "/shelves/x"),
            "https://shelf.example.dev/link?next=%2Fshelves%2Fx#ssl_abc"
        );
    }

    #[test]
    fn a_version_is_escaped_as_a_path_segment() {
        assert_eq!(encode_segment("1.0.0+build.1"), "1.0.0%2Bbuild.1");
    }

    #[test]
    fn only_shelf_paths_are_written() {
        assert!(is_shelf_path("shelf.json"));
        assert!(is_shelf_path("items/prompts/x/prompt.md"));
        assert!(!is_shelf_path("items/../../etc/passwd"));
        assert!(!is_shelf_path("README.md"));
        assert!(!is_shelf_path("items"));
    }
}
