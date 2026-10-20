//! `shelfkit doctor`'s drift check: whether each imported item's upstream has
//! moved since the item was pinned. It reads upstream and writes nothing.
//!
//! The rules are the hosted importer's (`packages/importers`), so the two
//! agree on what "moved" means, and the requests are the same ones, which is
//! what lets the tests replay the importer's recorded responses:
//!
//! - **Git** (GitHub): the artifact's Git object id at the pinned commit
//!   against the same path at the ref's head. A commit that changed other
//!   files does not move the item. A ref that is a commit is compared with the
//!   default branch.
//! - **ClawHub**: the skill's latest version against the pinned one.
//! - **MCP registry**: the server's latest version, then the digest of its
//!   `server` document (`sha256:` over canonical JSON) when the item has one.
//! - **ShelfKit instance**: a profile's newest published version on the
//!   instance's registry; an item's revision there.
//! - **APM registry**: the package's newest published version.
//!
//! A request goes through [`System::http`], one at a time, with no async
//! runtime. A GitHub token is read from `GITHUB_TOKEN` and sent to
//! `api.github.com` only.

use super::system::{HttpRequest, System};
use serde_json::Value;
use sha2::{Digest, Sha256};
use shelfkit_core::profile::{ShelfSource, SourceKind};
use shelfkit_core::{Payload, Shelf, Source};
use std::fmt::Write as _;

const GITHUB_API: &str = "https://api.github.com";
const OFFICIAL_MCP_REGISTRY: &str = "https://registry.modelcontextprotocol.io";

/// The queries the hosted importer sends a ShelfKit instance, byte for byte.
const ITEM_REVISION_QUERY: &str = "query ItemRevision($shelf: ID!, $item: ID!) {\n  shelf(id: $shelf) { item(id: $item) { revision } }\n}";

/// Where an imported item's upstream is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Current,
    Moved,
    Gone,
    /// Not checked, or the check failed; the message says why.
    Error(String),
}

impl Status {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Moved => "moved",
            Self::Gone => "gone",
            Self::Error(_) => "error",
        }
    }
}

/// One imported item's drift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drift {
    pub item: String,
    pub status: Status,
    /// What the item is pinned to.
    pub pinned: String,
    /// What upstream is at now, when that was learned.
    pub latest: Option<String>,
}

/// The kind of source an item came from: the `shelf.json` source its
/// `source.id` names, else what its own `source` shows.
pub fn source_kind(source: &Source, declared: &[ShelfSource]) -> Option<SourceKind> {
    if let Some(found) = source
        .id
        .as_ref()
        .and_then(|id| declared.iter().find(|s| &s.id == id))
    {
        return Some(found.kind);
    }
    if source.repo.is_some() {
        return Some(SourceKind::Git);
    }
    let url = source.url.as_deref()?;
    if catalog_of(url).is_some() {
        return Some(SourceKind::Catalog);
    }
    source
        .path
        .as_deref()
        .filter(|path| path.contains('/'))
        .map(|_| SourceKind::Shelfkit)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Catalog {
    ClawHub,
    McpRegistry,
}

fn origin(url: &str) -> &str {
    let rest = url.find("://").map_or(0, |i| i + 3);
    url[rest..]
        .find('/')
        .map_or(url, |slash| &url[..rest + slash])
}

fn host(url: &str) -> &str {
    let origin = origin(url);
    origin.find("://").map_or(origin, |i| &origin[i + 3..])
}

fn catalog_of(url: &str) -> Option<Catalog> {
    if !url.starts_with("https://") || host(url).contains('@') {
        return None;
    }
    let host = host(url);
    if host == "clawhub.ai" || host.ends_with(".clawhub.ai") {
        return Some(Catalog::ClawHub);
    }
    let path = &url[origin(url).len()..];
    (origin(url) == OFFICIAL_MCP_REGISTRY || path.starts_with("/v0"))
        .then_some(Catalog::McpRegistry)
}

/// Check every imported item of a shelf, in id order.
pub fn check(system: &dyn System, shelf: &Shelf) -> Vec<Drift> {
    let reader = Reader {
        system,
        token: system.var("GITHUB_TOKEN"),
    };
    shelf
        .items
        .values()
        .filter_map(|loaded| {
            let source = loaded.item.source.as_ref()?;
            let kind = source_kind(source, &shelf.manifest.sources);
            let mcp_name = match &loaded.item.payload {
                Payload::Mcp(mcp) => mcp.name().map(str::to_owned),
                _ => None,
            };
            let declared = source
                .id
                .as_ref()
                .and_then(|id| shelf.manifest.sources.iter().find(|s| &s.id == id));
            let (status, latest) = match kind {
                Some(SourceKind::Git) => reader.git(source),
                Some(SourceKind::Catalog) => match source.url.as_deref().and_then(catalog_of) {
                    Some(Catalog::ClawHub) => reader.clawhub(source),
                    Some(Catalog::McpRegistry) => reader.mcp_registry(source, mcp_name.as_deref()),
                    None => (
                        Status::Error("the item's URL is not a catalog ShelfKit reads".into()),
                        None,
                    ),
                },
                Some(SourceKind::Shelfkit) => reader.shelfkit(source, declared),
                Some(SourceKind::ApmRegistry) => {
                    let url = declared.and_then(|s| s.url.clone());
                    reader.registry_package(source, url.as_deref())
                }
                Some(SourceKind::Path) => return None,
                Some(SourceKind::Marketplace) | None => (
                    Status::Error("ShelfKit does not check this kind of source yet".into()),
                    None,
                ),
            };
            Some(Drift {
                item: loaded.item.id.clone(),
                status,
                pinned: pinned(source),
                latest,
            })
        })
        .collect()
}

/// What an item is pinned to, for the report.
fn pinned(source: &Source) -> String {
    if let Some(commit) = &source.resolved_commit {
        return short(commit);
    }
    if let Some(version) = &source.version {
        return version.clone();
    }
    source
        .digest
        .as_deref()
        .map_or_else(|| "nothing".to_owned(), short_digest)
}

fn short(commit: &str) -> String {
    commit.chars().take(7).collect()
}

fn short_digest(digest: &str) -> String {
    let hex = digest.strip_prefix("sha256:").unwrap_or(digest);
    format!("sha256:{}", hex.chars().take(12).collect::<String>())
}

/// Write the report: a summary line, then one line per item that is not current.
pub fn report(drifts: &[Drift]) -> String {
    let count = |label: &str| drifts.iter().filter(|d| d.status.label() == label).count();
    let mut out = format!(
        "drift       {} imported item(s): {} current, {} moved, {} gone, {} not checked\n",
        drifts.len(),
        count("current"),
        count("moved"),
        count("gone"),
        count("error"),
    );
    for drift in drifts.iter().filter(|d| d.status != Status::Current) {
        let detail = match (&drift.status, &drift.latest) {
            (Status::Error(message), _) => message.clone(),
            (_, Some(latest)) => format!("pinned {}, upstream {latest}", drift.pinned),
            (_, None) => format!("pinned {}", drift.pinned),
        };
        let _ = writeln!(
            out,
            "            {:<7} {}: {detail}",
            drift.status.label(),
            drift.item
        );
    }
    out
}

/// Reads upstream through the machine's one HTTP door.
struct Reader<'a> {
    system: &'a dyn System,
    token: Option<String>,
}

/// An answer: `Ok(None)` for 404 or 410, which drift reads as "not there".
type Answer = Result<Option<Value>, String>;

impl Reader<'_> {
    fn send(&self, method: &'static str, url: &str, body: Vec<u8>) -> Answer {
        let mut headers = vec![
            ("accept".to_owned(), "application/json".to_owned()),
            ("user-agent".to_owned(), "shelfkit-doctor".to_owned()),
        ];
        if let Some(token) = self.token.as_ref().filter(|_| is_github_api(url)) {
            headers.push(("authorization".to_owned(), format!("Bearer {token}")));
        }
        if !body.is_empty() {
            headers.push(("content-type".to_owned(), "application/json".to_owned()));
        }
        let response = self
            .system
            .http(&HttpRequest {
                method,
                url: url.to_owned(),
                headers,
                body,
            })
            .map_err(|error| format!("{url}: {error}"))?;
        match response.status {
            404 | 410 => Ok(None),
            200..=299 => serde_json::from_slice(&response.body)
                .map(Some)
                .map_err(|_| format!("{url}: the answer is not JSON")),
            status => Err(format!("{url}: HTTP {status}")),
        }
    }

    fn get(&self, url: &str) -> Answer {
        self.send("GET", url, Vec::new())
    }

    fn git(&self, source: &Source) -> (Status, Option<String>) {
        match self.git_inner(source) {
            Ok(found) => found,
            Err(message) => (Status::Error(message), None),
        }
    }

    fn git_inner(&self, source: &Source) -> Result<(Status, Option<String>), String> {
        let repo = source.repo.as_deref().unwrap_or_default();
        let Some((owner, name)) = github_repository(repo) else {
            return Err(format!(
                "`{repo}` is not a github.com repository; only GitHub is checked"
            ));
        };
        let Some(pinned) = source.resolved_commit.as_deref() else {
            return Err("the item has no resolved commit to compare with".into());
        };
        let api = format!("{GITHUB_API}/repos/{owner}/{name}");
        let Some(info) = self.get(&api)? else {
            return Ok((Status::Gone, None));
        };
        let default_branch = info
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("main");
        let is_commit = |r: &str| r.len() == 40 && r.bytes().all(|b| b.is_ascii_hexdigit());
        let git_ref = source
            .git_ref
            .as_deref()
            .filter(|r| !is_commit(r))
            .unwrap_or(default_branch);
        let Some(commit) = self.get(&format!("{api}/commits/{}", encode(git_ref)))? else {
            return Ok((Status::Gone, Some(format!("the ref `{git_ref}` is gone"))));
        };
        let head = commit
            .get("sha")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let latest = Some(format!("{git_ref} at {}", short(&head)));
        if head == pinned {
            return Ok((Status::Current, latest));
        }
        let path = source.path.as_deref().unwrap_or("").trim_matches('/');
        if path.is_empty() {
            return Ok((Status::Moved, latest));
        }
        let Some(now) = self.entry(&api, &head, path)? else {
            return Ok((Status::Gone, latest));
        };
        let then = self.entry(&api, pinned, path)?;
        let status = if then.as_deref() == Some(now.as_str()) {
            Status::Current
        } else {
            Status::Moved
        };
        Ok((status, latest))
    }

    /// The Git object id at `path` in `commit`, one directory listing at a time.
    fn entry(&self, api: &str, commit: &str, path: &str) -> Result<Option<String>, String> {
        let mut tree = commit.to_owned();
        let segments: Vec<&str> = path.split('/').collect();
        for (index, segment) in segments.iter().enumerate() {
            let url = format!("{api}/git/trees/{tree}");
            let Some(listing) = self.get(&url)? else {
                return Ok(None);
            };
            let found = listing
                .get("tree")
                .and_then(Value::as_array)
                .and_then(|entries| {
                    entries
                        .iter()
                        .find(|entry| entry.get("path").and_then(Value::as_str) == Some(segment))
                });
            let Some(found) = found else {
                return Ok(None);
            };
            let sha = found
                .get("sha")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let is_tree = found.get("type").and_then(Value::as_str) == Some("tree");
            if index + 1 == segments.len() {
                return Ok(Some(sha));
            }
            if !is_tree {
                return Ok(None);
            }
            tree = sha;
        }
        Ok(None)
    }

    fn clawhub(&self, source: &Source) -> (Status, Option<String>) {
        let Some((owner, slug)) = source.path.as_deref().and_then(|p| p.split_once('/')) else {
            return (
                Status::Error("the item names no ClawHub skill".into()),
                None,
            );
        };
        let owner = owner.trim_start_matches('@');
        let url = format!(
            "https://clawhub.ai/api/v1/skills/{}?ownerHandle={}",
            encode(slug),
            encode(owner)
        );
        match self.get(&url) {
            Err(message) => (Status::Error(message), None),
            Ok(None) => (Status::Gone, None),
            Ok(Some(found)) => {
                let blocked = found
                    .pointer("/moderation/isMalwareBlocked")
                    .and_then(Value::as_bool)
                    == Some(true);
                let version = found
                    .pointer("/latestVersion/version")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if blocked {
                    return (Status::Gone, Some("blocked as malware on ClawHub".into()));
                }
                let status = if version.is_some() && version == source.version {
                    Status::Current
                } else {
                    Status::Moved
                };
                (status, version)
            }
        }
    }

    fn mcp_registry(&self, source: &Source, name: Option<&str>) -> (Status, Option<String>) {
        let (Some(url), Some(name)) = (source.url.as_deref(), name) else {
            return (
                Status::Error("the item names no registry server".into()),
                None,
            );
        };
        let latest_url = format!(
            "{}/v0.1/servers/{}/versions/latest",
            origin(url),
            encode(name)
        );
        match self.get(&latest_url) {
            Err(message) => (Status::Error(message), None),
            Ok(None) => (Status::Gone, None),
            Ok(Some(found)) => {
                let version = found
                    .pointer("/server/version")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let status_now = found
                    .pointer("/_meta/io.modelcontextprotocol.registry~1official/status")
                    .and_then(Value::as_str);
                if status_now == Some("deleted") {
                    return (Status::Gone, Some(format!("{version}, deleted")));
                }
                if Some(&version) != source.version.as_ref() {
                    return (Status::Moved, Some(version));
                }
                let digest = found.get("server").map(|server| {
                    format!(
                        "sha256:{}",
                        hex(&Sha256::digest(canonical_json(server).as_bytes()))
                    )
                });
                // The digest is the registry document's only when the item came
                // straight from the registry; one re-exported by another
                // ShelfKit instance carries that instance's revision instead.
                let from_registry = source.record_url.is_none() || source.record_url == source.url;
                let status = match (&source.digest, digest) {
                    (Some(pinned), Some(now)) if from_registry && *pinned != now => Status::Moved,
                    _ => Status::Current,
                };
                (status, Some(version))
            }
        }
    }

    fn shelfkit(
        &self,
        source: &Source,
        declared: Option<&ShelfSource>,
    ) -> (Status, Option<String>) {
        let instance = declared
            .and_then(|s| s.url.as_deref())
            .or(source.url.as_deref())
            .map(|url| url.trim_end_matches('/').to_owned());
        let (Some(instance), Some((shelf, name))) = (
            instance,
            source.path.as_deref().and_then(|p| p.split_once('/')),
        ) else {
            return (
                Status::Error("the item names no ShelfKit shelf".into()),
                None,
            );
        };
        if !instance.starts_with("https://") || host(&instance).contains('@') {
            return (
                Status::Error(format!(
                    "`{instance}` is not an https URL; an instance is read over https only"
                )),
                None,
            );
        }
        if source.version.is_some() {
            return self.registry_package(source, Some(&format!("{instance}/apm")));
        }
        let body = serde_json::json!({
            "query": ITEM_REVISION_QUERY,
            "variables": { "item": name, "shelf": shelf },
        });
        match self.send(
            "POST",
            &format!("{instance}/graphql"),
            body.to_string().into_bytes(),
        ) {
            Err(message) => (Status::Error(message), None),
            Ok(None) => (Status::Gone, None),
            Ok(Some(found)) => {
                if let Some(errors) = found.get("errors").and_then(Value::as_array)
                    && !errors.is_empty()
                {
                    let messages: Vec<&str> = errors
                        .iter()
                        .filter_map(|error| error.get("message").and_then(Value::as_str))
                        .collect();
                    return (
                        Status::Error(format!("{instance}/graphql: {}", messages.join("; "))),
                        None,
                    );
                }
                let Some(revision) = found
                    .pointer("/data/shelf/item/revision")
                    .and_then(Value::as_str)
                else {
                    return (Status::Gone, None);
                };
                let digest = revision.replacen("sha256-", "sha256:", 1);
                let status = if Some(&digest) == source.digest.as_ref() {
                    Status::Current
                } else {
                    Status::Moved
                };
                (status, Some(short_digest(&digest)))
            }
        }
    }

    /// An OpenAPM package's newest published version against the pinned one.
    fn registry_package(
        &self,
        source: &Source,
        registry: Option<&str>,
    ) -> (Status, Option<String>) {
        let (Some(registry), Some(package)) = (registry, source.path.as_deref()) else {
            return (
                Status::Error("the item names no registry package".into()),
                None,
            );
        };
        let url = format!(
            "{}/v1/packages/{package}/versions",
            registry.trim_end_matches('/')
        );
        match self.get(&url) {
            Err(message) => (Status::Error(message), None),
            Ok(None) => (Status::Gone, None),
            Ok(Some(found)) => {
                let newest = found
                    .get("versions")
                    .and_then(Value::as_array)
                    .and_then(|versions| {
                        versions.iter().max_by(|a, b| {
                            let at = |v: &Value| {
                                v.get("published_at")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned()
                            };
                            at(a).cmp(&at(b))
                        })
                    })
                    .and_then(|v| v.get("version").and_then(Value::as_str))
                    .map(str::to_owned);
                match newest {
                    None => (Status::Gone, None),
                    Some(version) if Some(&version) == source.version.as_ref() => {
                        (Status::Current, Some(version))
                    }
                    Some(version) => (Status::Moved, Some(version)),
                }
            }
        }
    }
}

/// Whether a URL is GitHub's API: `https`, the host exactly
/// `api.github.com`, no credentials, no port. A token goes nowhere else,
/// whatever an item's `source` says.
fn is_github_api(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority == "api.github.com"
}

/// `owner` and `repo` of a github.com repository URL or shorthand.
fn github_repository(repo: &str) -> Option<(String, String)> {
    let rest = repo
        .trim()
        .trim_start_matches("https://")
        .trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let segments: Vec<&str> = rest.split('/').collect();
    match segments.as_slice() {
        [host, owner, name] if host.eq_ignore_ascii_case("github.com") => {
            Some(((*owner).to_owned(), (*name).to_owned()))
        }
        [owner, name] => Some(((*owner).to_owned(), (*name).to_owned())),
        _ => None,
    }
}

/// Percent-encoding for one path segment or query value, as JavaScript's
/// `encodeURIComponent` writes it, so the URLs match the importer's.
fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// JSON with every object's keys sorted and no whitespace: the importer's
/// `canonicalJson`, so both compute the same digest of a document.
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let parts: Vec<String> = entries
                .into_iter()
                .map(|(key, value)| {
                    format!("{}:{}", Value::String(key.clone()), canonical_json(value))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_encoded_as_the_importer_encodes_them() {
        assert_eq!(
            encode("io.github.github/github-mcp-server"),
            "io.github.github%2Fgithub-mcp-server"
        );
        assert_eq!(encode("a b"), "a%20b");
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_depth() {
        let value: Value =
            serde_json::from_str(r#"{"b":1,"a":{"d":[{"z":1,"y":"é"}],"c":null}}"#).unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"a":{"c":null,"d":[{"y":"é","z":1}]},"b":1}"#
        );
    }

    #[test]
    fn the_source_kind_comes_from_shelf_json_then_from_the_item() {
        let item = |repo: Option<&str>, url: Option<&str>, path: Option<&str>| Source {
            repo: repo.map(str::to_owned),
            url: url.map(str::to_owned),
            path: path.map(str::to_owned),
            ..Source::default()
        };
        assert_eq!(
            source_kind(&item(Some("o/r"), None, None), &[]),
            Some(SourceKind::Git)
        );
        assert_eq!(
            source_kind(
                &item(None, Some("https://clawhub.ai/o/skills/s"), None),
                &[]
            ),
            Some(SourceKind::Catalog)
        );
        assert_eq!(
            source_kind(
                &item(None, Some("https://shelf.example"), Some("team/default")),
                &[]
            ),
            Some(SourceKind::Shelfkit)
        );
        assert_eq!(source_kind(&item(None, None, None), &[]), None);
    }
}
