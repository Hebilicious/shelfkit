//! The hosted service's client: `shelfkit login`, `logout`, `open`, and
//! `publish` (`docs/PRD.md` sections 4.1 and 10.3).
//!
//! A deployment is addressed by its URL. `login` signs the CLI in through
//! the browser: it starts a login at `/auth/cli/start`, opens the page that
//! approves it, and polls `/auth/cli/poll` until the person signed in there
//! approves it, which hands the CLI a key that acts as them. With `--key`, or
//! without a terminal (CI), it asks for a key created in the web UI (or the
//! owner key `moon run worker:setup` printed) instead. Either way it checks
//! the key and keeps it in the OS keychain under the service `shelfkit` with
//! the URL as the account; it also remembers the URL as the default. Every other
//! command reads the key from `SHELFKIT_KEY` when it is set (for CI and
//! agents), else from the keychain. A key is never printed, logged, or put
//! in an error.
//!
//! A shelf's files reach the service only through Git: each hosted shelf is
//! the repository `<deployment>/git/<shelf>.git`, pushed to and pulled from
//! with plain git. `publish` packages each profile with the same
//! deterministic packaging `serve` uses and publishes it to the deployment's
//! OpenAPM registry, as APM's registry client would. All network access goes
//! through [`System::http`].

use super::system::{HttpRequest, HttpResponse, System};
use super::{Context, Failure, Outcome, absolute};
use crate::engine::{Request, inventory, package_profile};
use crate::package::PackagedProfile;
use serde_json::{Value, json};
use shelfkit_core::{DirSource, Errors};
use std::path::{Path, PathBuf};

/// The environment variable a key is read from before the keychain.
pub const KEY_ENV: &str = "SHELFKIT_KEY";
/// The environment variable the deployment's URL is read from before the
/// remembered default.
pub const URL_ENV: &str = "SHELFKIT_URL";

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

const VIEWER: &str = "query Viewer { viewer { authenticated owner name shelf keyName } }";

/// `shelfkit login [URL]`: sign the CLI in through the browser, or with
/// `--key` (or without a terminal) read a key, then check it against the
/// deployment and keep it in the OS keychain.
pub(super) fn login(ctx: &mut Context<'_>, url: Option<&str>, paste: bool) -> Outcome {
    let url = deployment(ctx.system, url)?;
    let key = if paste || !ctx.system.stdin_is_terminal() {
        let key = ctx
            .system
            .read_secret(&format!("Key for {url}: "))
            .map_err(|error| format!("reading the key: {error}"))?;
        if key.is_empty() {
            return Err("no key given".to_owned().into());
        }
        key
    } else {
        browser_login(ctx, &url)?
    };
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
    } else if let Some(name) = viewer["name"].as_str() {
        name.to_owned()
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

/// What one of the deployment's plain routes answered: its JSON, or `429`
/// with the seconds to wait before asking again.
enum Posted {
    Json(Value),
    Limited(u64),
}

/// The longest the CLI waits when the deployment asks it to slow down, and
/// what it waits when the deployment does not say.
const MAX_RETRY_SECONDS: u64 = 60;
const DEFAULT_RETRY_SECONDS: u64 = 10;

/// POST JSON to one of the deployment's plain routes, without a key, and read
/// the JSON it answers.
fn post_json(system: &dyn System, url: &str, path: &str, body: &Value) -> Result<Posted, String> {
    let response = system
        .http(&HttpRequest {
            body: serde_json::to_vec(body).unwrap_or_default(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            method: "POST",
            url: format!("{url}{path}"),
        })
        .map_err(|error| format!("POST {url}{path}: {error}"))?;
    if response.status == 404 {
        return Err(format!(
            "{url} does not sign the CLI in through the browser: run `shelfkit login --key {url}` with a key made in \
             Settings"
        ));
    }
    if response.status == 429 {
        // `Retry-After` in seconds; its HTTP-date form, which the deployment never sends, waits the default.
        let seconds = response
            .header("retry-after")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_RETRY_SECONDS)
            .clamp(1, MAX_RETRY_SECONDS);
        return Ok(Posted::Limited(seconds));
    }
    if !(200..300).contains(&response.status) {
        return Err(format!("{url}{path} answered {}", response.status));
    }
    serde_json::from_slice(&response.body)
        .map(Posted::Json)
        .map_err(|_| format!("{url}{path} answered with a body that is not JSON"))
}

/// The longest the CLI waits between two polls, whatever the deployment asks.
const MAX_POLL_SECONDS: u64 = 30;

/// Sign the CLI in through the browser: start a login, show its code, open
/// the page that approves it, and poll until it is approved (its key),
/// denied, or expired. The device code is the CLI's secret and is never
/// printed; neither is the key.
fn browser_login(ctx: &mut Context<'_>, url: &str) -> Result<String, Failure> {
    let device = ctx
        .system
        .hostname()
        .unwrap_or_else(|| "a computer".to_owned());
    let started = match post_json(
        ctx.system,
        url,
        "/auth/cli/start",
        &json!({ "device": device }),
    )? {
        Posted::Json(started) => started,
        Posted::Limited(seconds) => {
            return Err(format!(
                "{url} has started too many logins from this address in the last minute: run `shelfkit login {url}` \
                 again in {seconds} seconds"
            )
            .into());
        }
    };
    let fields = (
        started["userCode"].as_str(),
        started["deviceCode"].as_str(),
        started["verificationUrl"].as_str(),
    );
    let (Some(code), Some(device_code), Some(page)) = fields else {
        return Err(format!("{url}/auth/cli/start answered without a code").into());
    };
    let (code, device_code, page) = (code.to_owned(), device_code.to_owned(), page.to_owned());
    let interval = started["interval"]
        .as_u64()
        .unwrap_or(2)
        .clamp(1, MAX_POLL_SECONDS);
    let expires_in = started["expiresIn"].as_u64().unwrap_or(600);
    let _ = writeln!(
        ctx.stderr,
        "To sign this computer in, approve the login in your browser:\n\n  {page}\n\nCheck that the page shows the \
         code {code}, the same as here. Approve only a code you see in your own terminal."
    );
    let opened = browser_opener(ctx.system).is_some_and(|(program, meaningful)| {
        let cwd = absolute(ctx, None);
        ctx.system
            .run(&program, std::slice::from_ref(&page), &cwd, &[])
            .is_ok_and(|exit| !meaningful || exit == 0)
    });
    let _ = writeln!(
        ctx.stderr,
        "{}Waiting for approval (Ctrl-C to stop)…",
        if opened {
            "Opened the page in your browser. "
        } else {
            "Open the page in a browser. "
        }
    );
    // One poll more than the login lasts, so its expiry is the deployment's answer, not a guess.
    // A poll the deployment refuses as too frequent (`429`) waits its `Retry-After` and polls again; it still counts
    // as a poll, so the loop only ever lasts longer than the login.
    let polls = expires_in / interval + 2;
    let mut wait = interval;
    let mut slowed = false;
    for _ in 0..polls {
        ctx.system.sleep(std::time::Duration::from_secs(wait));
        wait = interval;
        let answer = match post_json(
            ctx.system,
            url,
            "/auth/cli/poll",
            &json!({ "deviceCode": device_code }),
        )? {
            Posted::Json(answer) => answer,
            Posted::Limited(seconds) => {
                if !slowed {
                    slowed = true;
                    let _ = writeln!(
                        ctx.stderr,
                        "{url} asked this computer to poll less often; still waiting for approval…"
                    );
                }
                wait = seconds;
                continue;
            }
        };
        match answer["status"].as_str() {
            Some("pending") => {}
            Some("approved") => {
                return answer["key"]
                    .as_str()
                    .filter(|key| !key.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{url} approved the login but sent no key").into());
            }
            Some("denied") => {
                return Err(format!(
                    "the login was denied in the browser, so this computer is not signed in. Run `shelfkit login \
                     {url}` to try again"
                )
                .into());
            }
            _ => {
                return Err(expired(url).into());
            }
        }
    }
    Err(expired(url).into())
}

fn expired(url: &str) -> String {
    format!(
        "the login expired before it was approved: run `shelfkit login {url}` again, and approve it within 10 minutes"
    )
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
            "{error}: `shelfkit open` needs the owner key, or a key from signing the CLI in through the browser"
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
            "This link signs a browser in as you. It works once, within 15 minutes: open it, add a passkey \
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
        "Opened {} in your browser, signed in as you. Add a passkey there to sign in on that device without a \
         link; the link itself works once, within 15 minutes.",
        remote.url()
    );
    Ok(())
}

/// `shelfkit publish`: package every profile and publish it to the
/// deployment's registry, which also commits it to the profile's Git
/// repository. A version already published with the same bytes is reported
/// and left; one published with other bytes fails the command, after every
/// profile has been tried. Ends with how APM installs one of them, both ways.
pub(super) fn publish(ctx: &mut Context<'_>, root: &Path, url: Option<&str>) -> Outcome {
    let source = DirSource::new(root);
    let found = inventory(&source)?;
    let remote = Remote::connect(ctx.system, url)?;
    let mut failed = false;
    let mut installable = Vec::new();
    for profile in &found.profiles {
        let id = &profile.profile.id;
        let request = Request {
            profile: Some(id.clone()),
            ..Request::default()
        };
        let packaged = match package_profile(&source, &request) {
            Ok(packaged) => packaged,
            Err(errors) => {
                let _ = writeln!(
                    ctx.stdout,
                    "Not published: the profile `{id}` cannot be a registry package ({}).",
                    first_message(&errors)
                );
                continue;
            }
        };
        let outcome = publish_version(
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
                installable.push(packaged);
            }
            Published::Already => {
                let _ = writeln!(
                    ctx.stdout,
                    "{}@{} is already published with these bytes.",
                    packaged.package, packaged.version
                );
                installable.push(packaged);
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
    let default = found.manifest.default_profile.as_deref();
    let example = installable
        .iter()
        .find(|packaged| Some(packaged.repo.as_str()) == default)
        .or_else(|| installable.first());
    if let Some(packaged) = example {
        let _ = write!(ctx.stdout, "\n{}", install_snippets(remote.url(), packaged));
    }
    if failed {
        return Err(Failure::Reported);
    }
    Ok(())
}

/// The two `apm.yml` dependencies that install a published profile, each
/// following its minor versions: from the profile's Git repository, or from
/// the registry with APM's experimental registry client. Both install the
/// same files.
fn install_snippets(url: &str, packaged: &PackagedProfile) -> String {
    let PackagedProfile {
        owner,
        repo,
        version,
        ..
    } = packaged;
    format!(
        "To install {owner}/{repo} with APM, add to apm.yml, from its Git repository:\n\n\
         dependencies:\n  apm:\n    - git: {url}/git/{owner}/{repo}.git\n      ref: \"^{version}\"\n\n\
         or from the registry, after `apm experimental enable registries` once:\n\n\
         registries:\n  shelfkit:\n    url: {url}/apm\n  default: shelfkit\n\
         dependencies:\n  apm:\n    - id: {owner}/{repo}\n      version: \"^{version}\"\n"
    )
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
fn publish_version(
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
}
