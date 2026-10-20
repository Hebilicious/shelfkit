//! The registry conformance suite, as data, and a runner for it.
//!
//! The cases are `conformance/cases.json` beside this crate: scenarios of
//! requests and the responses they must get, written for any host. Its
//! archives are files in `conformance/archives/`, which [`archives`]
//! generates and a test keeps in step. Two runners read the same file:
//! [`run`] here (over [`crate::host::Registry`] in process, and over a
//! running `shelfkit serve`), and `@shelfkit/engine/conformance` in
//! TypeScript, which the Worker's tests use.
//!
//! # The format
//!
//! The file names the `owner` every scenario's shelf serves under. Each
//! scenario sets whether that shelf is `public`, the `keys` it knows (a
//! name, the key itself, and its scopes), and `steps`. A step's `request`
//! has a `method`, a `path` relative to the base URL, optional `headers`,
//! an optional `auth` (`{ "bearer": <key name> }`, `{ "basic": <key name>
//! }`, or `{ "raw": <Authorization value> }`), and an optional `body`
//! (`{ "archive": <name> }`). Its `expect` has a `status`, and optionally:
//!
//! - `headers`: each value is matched exactly, or by media type when the
//!   response adds parameters (`application/json` matches
//!   `application/json; charset=utf-8`); `null` means absent.
//! - `json`: the body parses as JSON and contains this: objects match the
//!   keys they list, arrays match element by element and in length.
//! - `problem`: the body is an RFC 7807 problem: `application/problem+json`
//!   with a string `title` and a `status` equal to the response's.
//! - `body`: `{ "archive": <name> }`, the exact bytes of that archive.
//!
//! In request headers, and in expected `headers` and `json`, a string value may be a token: `$any` (present,
//! any value), `$digest:<archive>`, `$etag:<archive>` (the digest, quoted),
//! `$rfc3230:<archive>` (`sha256=<base64>`), and `$size:<archive>` (a
//! number in JSON, decimal text in a header).

use crate::archive::pack;
use crate::host::{HttpResponse, Request};
use serde::Deserialize;
use std::collections::BTreeMap;

/// The suite file.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Suite {
    #[serde(rename = "$comment", default)]
    pub comment: Vec<String>,
    pub owner: String,
    /// Archive name to its file (relative to the suite) and digest.
    pub archives: BTreeMap<String, ArchiveFile>,
    pub scenarios: Vec<Scenario>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveFile {
    pub file: String,
    pub digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub name: String,
    pub public: bool,
    #[serde(default)]
    pub keys: Vec<Key>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub name: String,
    pub key: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub name: String,
    pub request: StepRequest,
    pub expect: Expect,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub auth: Option<Auth>,
    #[serde(default)]
    pub body: Option<ArchiveRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
pub enum Auth {
    Bearer(String),
    Basic(String),
    Raw(String),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveRef {
    pub archive: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub json: Option<serde_json::Value>,
    #[serde(default)]
    pub problem: bool,
    #[serde(default)]
    pub body: Option<ArchiveRef>,
}

impl Suite {
    pub fn parse(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|error| format!("conformance/cases.json: {error}"))
    }
}

/// Run every scenario. `start` makes a fresh registry for a scenario and
/// returns the function that sends it one request. Every failure is
/// returned, as `scenario / step: what differed`.
pub fn run<F>(
    suite: &Suite,
    archives: &BTreeMap<String, Vec<u8>>,
    mut start: impl FnMut(&Scenario) -> F,
) -> Vec<String>
where
    F: FnMut(&Request) -> HttpResponse,
{
    let mut failures = Vec::new();
    for scenario in &suite.scenarios {
        let mut send = start(scenario);
        for step in &scenario.steps {
            let label = format!("{} / {}", scenario.name, step.name);
            match request(scenario, step, archives) {
                Ok(request) => {
                    let response = send(&request);
                    for problem in check(&step.expect, &response, archives) {
                        failures.push(format!("{label}: {problem}"));
                    }
                }
                Err(problem) => failures.push(format!("{label}: {problem}")),
            }
        }
    }
    failures
}

fn request(
    scenario: &Scenario,
    step: &Step,
    archives: &BTreeMap<String, Vec<u8>>,
) -> Result<Request, String> {
    let mut headers = Vec::new();
    for (name, value) in &step.request.headers {
        headers.push((name.clone(), token_text(value, archives)?));
    }
    let key = |name: &str| {
        scenario
            .keys
            .iter()
            .find(|key| key.name == name)
            .map(|key| key.key.clone())
            .ok_or_else(|| format!("the scenario has no key `{name}`"))
    };
    match &step.request.auth {
        None => {}
        Some(Auth::Bearer(name)) => {
            headers.push(("Authorization".to_owned(), format!("Bearer {}", key(name)?)));
        }
        Some(Auth::Basic(name)) => {
            let credentials = format!("conformance:{}", key(name)?);
            headers.push((
                "Authorization".to_owned(),
                format!("Basic {}", crate::base64::encode(credentials.as_bytes())),
            ));
        }
        Some(Auth::Raw(value)) => headers.push(("Authorization".to_owned(), value.clone())),
    }
    let body = match &step.request.body {
        Some(reference) => archives
            .get(&reference.archive)
            .cloned()
            .ok_or_else(|| format!("no archive `{}`", reference.archive))?,
        None => Vec::new(),
    };
    Ok(Request {
        method: step.request.method.clone(),
        path: step.request.path.clone(),
        headers,
        body,
    })
}

fn check(
    expect: &Expect,
    response: &HttpResponse,
    archives: &BTreeMap<String, Vec<u8>>,
) -> Vec<String> {
    let mut problems = Vec::new();
    let body_text = String::from_utf8_lossy(&response.body);
    if response.status != expect.status {
        problems.push(format!(
            "status {} instead of {} (body: {body_text})",
            response.status, expect.status
        ));
        return problems;
    }
    for (name, expected) in &expect.headers {
        let actual = response.header(name);
        match (expected, actual) {
            (None, None) => {}
            (None, Some(actual)) => {
                problems.push(format!("header {name} is `{actual}`, expected absent"))
            }
            (Some(_), None) => problems.push(format!("header {name} is missing")),
            (Some(expected), Some(actual)) => {
                let wanted = match token_text(expected, archives) {
                    Ok(wanted) => wanted,
                    Err(problem) => {
                        problems.push(problem);
                        continue;
                    }
                };
                let media = actual.split(';').next().unwrap_or_default().trim();
                if wanted != "$any" && actual != wanted && media != wanted {
                    problems.push(format!("header {name} is `{actual}`, expected `{wanted}`"));
                }
            }
        }
    }
    let parsed: Option<serde_json::Value> = serde_json::from_slice(&response.body).ok();
    if let Some(expected) = &expect.json {
        match &parsed {
            Some(actual) => matches_json(expected, actual, "$", archives, &mut problems),
            None => problems.push(format!("the body is not JSON: {body_text}")),
        }
    }
    if expect.problem {
        let media = response
            .header("content-type")
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if media != Some("application/problem+json") {
            problems.push(format!(
                "a problem's Content-Type is {media:?}, not application/problem+json"
            ));
        }
        let title = parsed.as_ref().and_then(|body| body.get("title")?.as_str());
        let status = parsed
            .as_ref()
            .and_then(|body| body.get("status")?.as_u64());
        if title.is_none() || status != Some(u64::from(response.status)) {
            problems.push(format!(
                "a problem needs a string `title` and `status` {}: {body_text}",
                response.status
            ));
        }
    }
    if let Some(reference) = &expect.body {
        match archives.get(&reference.archive) {
            Some(bytes) if *bytes == response.body => {}
            Some(_) => problems.push(format!(
                "the body is not the bytes of `{}` ({} bytes, digest {})",
                reference.archive,
                response.body.len(),
                crate::digest(&response.body)
            )),
            None => problems.push(format!("no archive `{}`", reference.archive)),
        }
    }
    problems
}

fn matches_json(
    expected: &serde_json::Value,
    actual: &serde_json::Value,
    at: &str,
    archives: &BTreeMap<String, Vec<u8>>,
    problems: &mut Vec<String>,
) {
    use serde_json::Value;
    match expected {
        Value::String(text) if text.starts_with('$') => match token_json(text, archives) {
            Ok(None) => {}
            Ok(Some(wanted)) if wanted == *actual => {}
            Ok(Some(wanted)) => problems.push(format!("{at} is {actual}, expected {wanted}")),
            Err(problem) => problems.push(problem),
        },
        Value::Object(fields) => {
            let Some(object) = actual.as_object() else {
                problems.push(format!("{at} is {actual}, expected an object"));
                return;
            };
            for (key, value) in fields {
                match object.get(key) {
                    Some(found) => {
                        matches_json(value, found, &format!("{at}.{key}"), archives, problems)
                    }
                    None => problems.push(format!("{at}.{key} is missing")),
                }
            }
        }
        Value::Array(items) => {
            let Some(found) = actual.as_array() else {
                problems.push(format!("{at} is {actual}, expected an array"));
                return;
            };
            if found.len() != items.len() {
                problems.push(format!(
                    "{at} has {} elements, expected {}: {actual}",
                    found.len(),
                    items.len()
                ));
                return;
            }
            for (index, (item, value)) in items.iter().zip(found).enumerate() {
                matches_json(item, value, &format!("{at}[{index}]"), archives, problems);
            }
        }
        other if other == actual => {}
        other => problems.push(format!("{at} is {actual}, expected {other}")),
    }
}

/// A token's JSON value; `None` for `$any`.
fn token_json(
    token: &str,
    archives: &BTreeMap<String, Vec<u8>>,
) -> Result<Option<serde_json::Value>, String> {
    if token == "$any" {
        return Ok(None);
    }
    if let Some(name) = token.strip_prefix("$size:") {
        let bytes = archives
            .get(name)
            .ok_or_else(|| format!("no archive `{name}`"))?;
        return Ok(Some(serde_json::json!(bytes.len())));
    }
    token_text(token, archives).map(|text| Some(serde_json::Value::String(text)))
}

/// A token's text, or the string itself when it is no token.
fn token_text(token: &str, archives: &BTreeMap<String, Vec<u8>>) -> Result<String, String> {
    let Some((kind, name)) = token
        .strip_prefix('$')
        .and_then(|rest| rest.split_once(':'))
    else {
        return Ok(token.to_owned());
    };
    let bytes = archives
        .get(name)
        .ok_or_else(|| format!("no archive `{name}`"))?;
    let digest = crate::digest(bytes);
    Ok(match kind {
        "digest" => digest,
        "etag" => format!("\"{digest}\""),
        "size" => bytes.len().to_string(),
        "rfc3230" => {
            let hex = digest.trim_start_matches("sha256:");
            let raw: Vec<u8> = (0..32)
                .filter_map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok())
                .collect();
            format!("sha256={}", crate::base64::encode(&raw))
        }
        _ => return Err(format!("unknown token `{token}`")),
    })
}

/// Every archive the suite uses, by name, generated. The committed files
/// in `conformance/archives/` are these bytes.
pub fn archives() -> Result<BTreeMap<String, Vec<u8>>, String> {
    let manifest = |name: &str, version: &str| format!("name: {name}\nversion: \"{version}\"\n");
    let instructions =
        |text: &str| format!("---\ndescription: Conformance fixture\n---\n\n{text}\n").into_bytes();
    let packed = |files: &[(&str, Vec<u8>)]| {
        let files: BTreeMap<String, Vec<u8>> = files
            .iter()
            .map(|(path, bytes)| ((*path).to_owned(), bytes.clone()))
            .collect();
        pack(&files).map_err(|error| error.to_string())
    };
    let rule = ".apm/instructions/web.instructions.md";
    let mut out = BTreeMap::new();
    out.insert(
        "web-1.0.0".to_owned(),
        packed(&[
            ("apm.yml", manifest("web", "1.0.0").into_bytes()),
            (rule, instructions("Write tests first.")),
        ])?,
    );
    out.insert(
        "web-1.0.0-other".to_owned(),
        packed(&[
            ("apm.yml", manifest("web", "1.0.0").into_bytes()),
            (rule, instructions("Write tests last.")),
        ])?,
    );
    out.insert(
        "web-1.1.0".to_owned(),
        packed(&[
            ("apm.yml", manifest("web", "1.1.0").into_bytes()),
            (rule, instructions("Write tests first, and name them well.")),
        ])?,
    );
    out.insert(
        "web-2.0.0-declares-9.9.9".to_owned(),
        packed(&[("apm.yml", manifest("web", "9.9.9").into_bytes())])?,
    );
    out.insert(
        "web-1.0.0-no-manifest".to_owned(),
        packed(&[(rule, instructions("No manifest."))])?,
    );
    out.insert(
        "web-1.0.0-named-other".to_owned(),
        packed(&[("apm.yml", manifest("other", "1.0.0").into_bytes())])?,
    );
    let raw = |entries: &[(&str, u8, &[u8])]| {
        let mut tar = Vec::new();
        tar.extend(raw_entry(
            "apm.yml",
            b'0',
            manifest("web", "1.0.0").as_bytes(),
        ));
        for (name, kind, data) in entries {
            tar.extend(raw_entry(name, *kind, data));
        }
        tar.resize(tar.len() + 1024, 0);
        gzip(&tar)
    };
    out.insert(
        "web-1.0.0-absolute-path".to_owned(),
        raw(&[("/tmp/escape.md", b'0', b"x")]),
    );
    out.insert(
        "web-1.0.0-traversal".to_owned(),
        raw(&[("../escape.md", b'0', b"x")]),
    );
    out.insert(
        "web-1.0.0-symlink".to_owned(),
        raw(&[("link.md", b'2', b"")]),
    );
    let mut corrupt = out
        .get("web-1.0.0")
        .cloned()
        .ok_or("web-1.0.0 is missing")?;
    corrupt.truncate(corrupt.len() / 2);
    out.insert("web-1.0.0-truncated-gzip".to_owned(), corrupt);
    out.insert(
        "web-1.0.0-zip".to_owned(),
        zip("apm.yml", manifest("web", "1.0.0").as_bytes()),
    );
    out.insert(
        "web-1.0.0+build.1".to_owned(),
        packed(&[
            ("apm.yml", manifest("web", "1.0.0+build.1").into_bytes()),
            (rule, instructions("A build of 1.0.0.")),
        ])?,
    );
    smuggling(&mut out, &manifest("web", "1.0.0"));
    Ok(out)
}

/// A tar entry with any type and name, which [`pack`] would never write.
fn raw_entry(name: &str, kind: u8, data: &[u8]) -> Vec<u8> {
    raw_header_entry(name, kind, data, data.len(), "", true)
}

/// A tar entry with full control of the header: its recorded `size`, its
/// `ustar` prefix, and whether it carries the `ustar` magic at all.
fn raw_header_entry(
    name: &str,
    kind: u8,
    data: &[u8],
    size: usize,
    prefix: &str,
    ustar: bool,
) -> Vec<u8> {
    let mut header = [0u8; 512];
    header[..name.len()].copy_from_slice(name.as_bytes());
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].copy_from_slice(b"        ");
    header[156] = kind;
    if kind == b'2' {
        header[157..157 + 11].copy_from_slice(b"/etc/passwd");
    }
    if ustar {
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
    }
    header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    let mut entry = header.to_vec();
    entry.extend_from_slice(data);
    entry.resize(entry.len().div_ceil(512) * 512, 0);
    entry
}

/// The data of a PAX header: `<length> <key>=<value>\n` records, the length
/// counting the whole record, its own digits included.
fn pax_records(records: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (key, value) in records {
        let body = format!(" {key}={value}\n");
        let mut length = body.len() + 1;
        while format!("{length}{body}").len() != length {
            length += 1;
        }
        out.extend_from_slice(format!("{length}{body}").as_bytes());
    }
    out
}

/// Archives that a strict reader and Python's `tarfile`, which APM 0.33.0
/// extracts with, would read differently. Each starts with a valid `apm.yml`.
fn smuggling(out: &mut BTreeMap<String, Vec<u8>>, manifest: &str) {
    let archive = |entries: Vec<Vec<u8>>| {
        let mut tar = raw_entry("apm.yml", b'0', manifest.as_bytes());
        for entry in entries {
            tar.extend(entry);
        }
        tar.resize(tar.len() + 1024, 0);
        gzip(&tar)
    };
    // Two PAX headers before one entry: Python applies the first `path`.
    out.insert(
        "web-1.0.0-two-pax-paths".to_owned(),
        archive(vec![
            raw_entry(
                "PaxHeader/a",
                b'x',
                &pax_records(&[("path", "../escape.md")]),
            ),
            raw_entry("PaxHeader/b", b'x', &pax_records(&[("path", "ok.md")])),
            raw_entry("ok.md", b'0', b"ok"),
        ]),
    );
    // A global PAX header: Python merges its `path` into every later entry.
    out.insert(
        "web-1.0.0-global-pax-path".to_owned(),
        archive(vec![
            raw_entry(
                "GlobalHead",
                b'g',
                &pax_records(&[("path", "../global.md")]),
            ),
            raw_entry("PaxHeader/c", b'x', &pax_records(&[("comment", "hi")])),
            raw_entry("ok3.md", b'0', b"ok"),
        ]),
    );
    // Two PAX `size` overrides: the "data" of the file is, to Python, the
    // header of a symbolic link to /etc/passwd.
    let link = raw_entry("evil-link", b'2', b"");
    out.insert(
        "web-1.0.0-pax-size-smuggles-a-link".to_owned(),
        archive(vec![
            raw_entry("PaxHeader/d", b'x', &pax_records(&[("size", "0")])),
            raw_entry("PaxHeader/e", b'x', &pax_records(&[("size", "512")])),
            raw_header_entry("data.md", b'0', &link, link.len(), "", true),
        ]),
    );
    // No `ustar` magic, but a prefix: Python applies it, making `../evil.md`.
    out.insert(
        "web-1.0.0-prefix-without-magic".to_owned(),
        archive(vec![raw_header_entry(
            "evil.md", b'0', b"x", 1, "..", false,
        )]),
    );
}

fn gzip(tar: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .operating_system(255)
        .write(Vec::new(), flate2::Compression::best());
    let _ = encoder.write_all(tar);
    encoder.finish().unwrap_or_default()
}

/// A one-file zip with the file stored, what `apm publish` would upload.
fn zip(name: &str, data: &[u8]) -> Vec<u8> {
    let mut crc = flate2::Crc::new();
    crc.update(data);
    let crc = crc.sum();
    let size = u32::try_from(data.len()).unwrap_or(u32::MAX);
    let name_len = u16::try_from(name.len()).unwrap_or(u16::MAX);
    let mut out = Vec::new();
    let local = |out: &mut Vec<u8>| {
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(name.as_bytes());
    };
    local(&mut out);
    out.extend_from_slice(data);
    let central = out.len();
    out.extend_from_slice(b"PK\x01\x02");
    out.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&name_len.to_le_bytes());
    out.extend_from_slice(&[0; 12]);
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(name.as_bytes());
    let central_len = u32::try_from(out.len() - central).unwrap_or(u32::MAX);
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&[0, 0, 0, 0, 1, 0, 1, 0]);
    out.extend_from_slice(&central_len.to_le_bytes());
    out.extend_from_slice(&u32::try_from(central).unwrap_or(u32::MAX).to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    out
}
