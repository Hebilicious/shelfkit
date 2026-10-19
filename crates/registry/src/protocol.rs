//! The registry's request handling, with no I/O: a host does the reading and
//! writing, and this module decides every status, header, and body.
//!
//! A request is handled in two steps, so a host whose storage is
//! asynchronous (the Worker's R2) can fetch between them:
//!
//! 1. [`prepare`] matches the route and reads the credential. It answers
//!    a path that is no route, or a malformed one, by itself.
//! 2. The host resolves the credential to an [`Access`], and loads the
//!    owner's shelf visibility and the package's versions into a
//!    [`Context`]. [`respond`] then decides the response, and for a
//!    successful publish, the [`VersionRecord`] the host must store with
//!    the request body, only if that version is still absent. When it
//!    is no longer absent, the host answers with [`conflict`].
//!
//! A download response carries [`Body::Archive`]: the host streams the
//! stored bytes of that version as the body, with the headers given.
//!
//! [`crate::host::Registry`] runs both steps over a synchronous store, which
//! is what `shelfkit serve` uses.

use crate::archive::{self, ArchiveError};
use crate::auth::{self, Access, Credential, Decision};
use crate::identity::{PackageId, Route, RouteError, check_version};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One published version, as `GET /versions` lists it (snake_case fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionRecord {
    pub version: String,
    /// `sha256:<64 lowercase hex>` over the archive bytes.
    pub digest: String,
    /// RFC 3339, UTC.
    pub published_at: String,
    pub size_bytes: u64,
}

/// What the host knows about the requested package.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    /// The owner's shelf, or `None` when the host has no shelf for the owner.
    #[serde(default)]
    pub shelf: Option<ShelfInfo>,
    /// The package's versions in the order they were published; empty when
    /// the package does not exist.
    #[serde(default)]
    pub versions: Vec<VersionRecord>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShelfInfo {
    /// Whether anonymous reads are served.
    pub public: bool,
}

/// What the client sent besides the route and the credential.
#[derive(Debug, Clone, Copy, Default)]
pub struct Payload<'a> {
    pub content_type: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
    pub body: &'a [u8],
}

/// A response for the host to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Response {
    pub status: u16,
    /// In the order to send them.
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Body {
    Empty,
    /// JSON text: a listing, a publish result, or a problem.
    Json {
        text: String,
    },
    /// The stored archive of this package version, by its storage key.
    Archive {
        package: String,
        version: String,
    },
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The result of [`prepare`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prepared {
    /// The registry has answered; the host sends this.
    Respond(Response),
    /// A route: the host resolves `credential` and loads the context.
    Route {
        route: Route,
        credential: Credential,
    },
}

/// The result of [`respond`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub response: Response,
    /// On a successful publish: store the request body as this version,
    /// only if the version is still absent, then send `response`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publish: Option<VersionRecord>,
}

/// Step 1: route the request and read its `Authorization` header. `path` is
/// the request's whole path, and `mount` the path the registry's base URL
/// adds (`""` at the root, `/apm` for the Worker): the three routes are
/// matched below it, and every URL a response carries (`instance`,
/// `Location`) is built from the whole path, so it is right under any mount.
pub fn prepare(method: &str, path: &str, mount: &str, authorization: Option<&str>) -> Prepared {
    let instance = path.split_once('?').map_or(path, |(path, _)| path);
    let mount = mount.trim_end_matches('/');
    let relative = match path.strip_prefix(mount) {
        Some(rest) if rest.starts_with('/') => rest,
        _ => "",
    };
    match crate::identity::route(method, relative) {
        Ok(route) => Prepared::Route {
            route,
            credential: Credential::from_header(authorization),
        },
        Err(RouteError::NotFound) => Prepared::Respond(problem(
            404,
            "not-found",
            "Not found",
            "this registry serves GET /v1/packages/{owner}/{repo}/versions, GET \
             /v1/packages/{owner}/{repo}/versions/{version}/download, and PUT \
             /v1/packages/{owner}/{repo}/versions/{version}",
            instance,
        )),
        Err(RouteError::MethodNotAllowed(allowed)) => {
            let mut response = problem(
                405,
                "method-not-allowed",
                "Method not allowed",
                &format!("this route takes {allowed}"),
                instance,
            );
            response
                .headers
                .push(("Allow".to_owned(), allowed.to_owned()));
            Prepared::Respond(response)
        }
        Err(RouteError::Invalid(detail)) => Prepared::Respond(problem(
            400,
            "invalid-path",
            "Invalid package path",
            &detail,
            instance,
        )),
    }
}

/// Step 2: decide the response. `instance` is the request's whole path, as
/// given to [`prepare`].
pub fn respond(
    route: &Route,
    instance: &str,
    access: &Access,
    context: &Context,
    payload: Payload<'_>,
    now: &str,
) -> Outcome {
    let instance = instance.split_once('?').map_or(instance, |(path, _)| path);
    let public = context.shelf.is_some_and(|shelf| shelf.public);
    match auth::decide(route, access, public) {
        Decision::Allow => {}
        Decision::Unauthenticated(detail) => {
            let mut response = problem(
                401,
                "unauthorized",
                "Authentication required",
                &detail,
                instance,
            );
            response.headers.push((
                "WWW-Authenticate".to_owned(),
                r#"Bearer realm="shelfkit", Basic realm="shelfkit""#.to_owned(),
            ));
            return answer(response);
        }
        Decision::Forbidden(scopes) => {
            let detail = format!(
                "the key lacks the scope this needs: one of {}",
                scopes
                    .iter()
                    .map(|scope| format!("`{scope}`"))
                    .collect::<Vec<_>>()
                    .join(" or ")
            );
            let mut response = problem(403, "forbidden", "Missing scope", &detail, instance);
            with_extensions(
                &mut response,
                serde_json::json!({ "required_scopes": scopes }),
            );
            return answer(response);
        }
    }

    let package = route.package();
    if context.shelf.is_none() {
        return answer(problem(
            404,
            "not-found",
            "Package not found",
            &format!(
                "this registry hosts no shelf for the owner `{}`",
                package.owner
            ),
            instance,
        ));
    }
    let cache = if public { "public" } else { "private" };
    match route {
        Route::List { package } => answer(list(package, context, cache, instance)),
        Route::Download { package, version } => answer(download(
            package, version, context, payload, cache, instance,
        )),
        Route::Publish { package, version } => {
            publish(package, version, context, payload, now, instance)
        }
    }
}

fn answer(response: Response) -> Outcome {
    Outcome {
        response,
        publish: None,
    }
}

fn list(package: &PackageId, context: &Context, cache: &str, instance: &str) -> Response {
    if context.versions.is_empty() {
        return missing_package(package, instance);
    }
    // Newest first: publish order, reversed.
    let versions: Vec<&VersionRecord> = context.versions.iter().rev().collect();
    let body = serde_json::json!({ "package": package.name(), "versions": versions });
    Response {
        status: 200,
        headers: vec![
            ("Content-Type".to_owned(), JSON.to_owned()),
            ("Cache-Control".to_owned(), format!("max-age=60, {cache}")),
        ],
        body: json(&body),
    }
}

fn download(
    package: &PackageId,
    version: &str,
    context: &Context,
    payload: Payload<'_>,
    cache: &str,
    instance: &str,
) -> Response {
    if context.versions.is_empty() {
        return missing_package(package, instance);
    }
    let Some(record) = context
        .versions
        .iter()
        .find(|record| record.version == version)
    else {
        return problem(
            404,
            "not-found",
            "Version not found",
            &format!("{} has no version `{version}`", package.name()),
            instance,
        );
    };
    let etag = format!("\"{}\"", record.digest);
    let mut headers = vec![
        ("ETag".to_owned(), etag.clone()),
        (
            "Cache-Control".to_owned(),
            format!("max-age=86400, immutable, {cache}"),
        ),
    ];
    let matches = payload.if_none_match.is_some_and(|value| {
        // RFC 9110 weak comparison: `W/"x"` matches `"x"`.
        value.split(',').any(|tag| {
            let tag = tag.trim();
            tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
        })
    });
    if matches {
        return Response {
            status: 304,
            headers,
            body: Body::Empty,
        };
    }
    headers.splice(
        0..0,
        [
            ("Content-Type".to_owned(), archive::CONTENT_TYPE.to_owned()),
            ("Content-Length".to_owned(), record.size_bytes.to_string()),
            ("Digest".to_owned(), rfc3230_digest(&record.digest)),
        ],
    );
    Response {
        status: 200,
        headers,
        body: Body::Archive {
            package: package.key(),
            version: record.version.clone(),
        },
    }
}

fn publish(
    package: &PackageId,
    version: &str,
    context: &Context,
    payload: Payload<'_>,
    now: &str,
    instance: &str,
) -> Outcome {
    // Immutability first: once a version exists, every PUT of it is a 409,
    // whatever its body.
    if let Some(existing) = context
        .versions
        .iter()
        .find(|record| record.version == version)
    {
        return answer(conflict(package, existing, instance));
    }

    let media_type = payload
        .content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    if media_type.as_deref() != Some(archive::CONTENT_TYPE) {
        let sent = media_type.map_or_else(|| "no Content-Type".to_owned(), |t| format!("`{t}`"));
        return answer(problem(
            415,
            "unsupported-media-type",
            "Unsupported archive type",
            &format!(
                "this registry stores tar.gz archives sent as `application/gzip` only, and got {sent}; \
                 the v0.1 consumer path ShelfKit serves is tar.gz, so a zip is refused rather than \
                 served to a client that may not read it"
            ),
            instance,
        ));
    }

    let files = match archive::read(payload.body) {
        Ok(files) => files,
        Err(ArchiveError::TooLarge(detail)) => {
            return answer(problem(
                413,
                "too-large",
                "Archive too large",
                &detail,
                instance,
            ));
        }
        Err(ArchiveError::Malformed(detail)) => {
            return answer(problem(
                400,
                "malformed-archive",
                "Malformed archive",
                &detail,
                instance,
            ));
        }
        Err(ArchiveError::Unsafe(detail)) => {
            return answer(invalid(vec![detail], instance));
        }
    };
    let errors = check_manifest(package, version, files.get("apm.yml").map(Vec::as_slice));
    if !errors.is_empty() {
        return answer(invalid(errors, instance));
    }

    let record = VersionRecord {
        version: version.to_owned(),
        digest: digest(payload.body),
        published_at: now.to_owned(),
        size_bytes: payload.body.len() as u64,
    };
    let mut body = serde_json::json!({ "package": package.name() });
    if let (Some(object), Ok(serde_json::Value::Object(fields))) =
        (body.as_object_mut(), serde_json::to_value(&record))
    {
        object.extend(fields);
    }
    Outcome {
        response: Response {
            status: 201,
            headers: vec![
                ("Content-Type".to_owned(), JSON.to_owned()),
                ("Location".to_owned(), format!("{instance}/download")),
            ],
            body: json(&body),
        },
        publish: Some(record),
    }
}

/// The `409` for a version that already exists.
pub fn conflict(package: &PackageId, existing: &VersionRecord, instance: &str) -> Response {
    let mut response = problem(
        409,
        "version-conflict",
        "Version already published",
        &format!(
            "version {} of {} was already published at {}; versions are immutable, so publish a new version",
            existing.version,
            package.name(),
            existing.published_at
        ),
        instance,
    );
    with_extensions(
        &mut response,
        serde_json::json!({
            "previous_publish": existing.published_at,
            "previous_digest": existing.digest,
        }),
    );
    response
}

/// Section 6, rules 3 to 6: an `apm.yml` at the root, valid YAML, with a
/// `name` that is the repo and a `version` that is the URL's.
fn check_manifest(package: &PackageId, version: &str, manifest: Option<&[u8]>) -> Vec<String> {
    let Some(bytes) = manifest else {
        return vec!["the archive has no apm.yml at its root".to_owned()];
    };
    let value: serde_yaml::Value = match serde_yaml::from_slice(bytes) {
        Ok(value) => value,
        Err(error) => return vec![format!("apm.yml is not valid YAML: {error}")],
    };
    let Some(mapping) = value.as_mapping() else {
        return vec!["apm.yml is not a mapping".to_owned()];
    };
    let mut errors = Vec::new();
    match mapping.get("name") {
        Some(serde_yaml::Value::String(name)) if name.eq_ignore_ascii_case(&package.repo) => {}
        Some(serde_yaml::Value::String(name)) => errors.push(format!(
            "apm.yml names the package `{name}`, but it is published as `{}`, whose repo is `{}`",
            package.name(),
            package.repo
        )),
        Some(_) => errors.push("apm.yml's `name` is not a string".to_owned()),
        None => errors.push("apm.yml has no `name`".to_owned()),
    }
    match mapping.get("version") {
        Some(serde_yaml::Value::String(declared)) if declared == version => {}
        Some(serde_yaml::Value::String(declared)) => {
            if let Err(error) = check_version(declared) {
                errors.push(format!("apm.yml's `version` is invalid: {error}"));
            }
            errors.push(format!(
                "apm.yml declares version `{declared}`, but the archive is published as `{version}`; \
                 the two must match"
            ));
        }
        Some(_) => errors.push(
            "apm.yml's `version` is not a string (quote it, as `version: \"1.0\"`)".to_owned(),
        ),
        None => errors.push("apm.yml has no `version`".to_owned()),
    }
    errors
}

/// `sha256:<64 lowercase hex>` over `bytes`: the digest the registry
/// advertises, and the one APM verifies before it extracts.
pub fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let mut text = String::with_capacity(7 + 64);
    text.push_str("sha256:");
    for byte in hash {
        text.push(char::from(HEX[usize::from(byte >> 4)]));
        text.push(char::from(HEX[usize::from(byte & 0xf)]));
    }
    text
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// RFC 3230's `Digest: sha256=<base64 of the binary digest>`.
fn rfc3230_digest(digest: &str) -> String {
    let hex = digest.strip_prefix("sha256:").unwrap_or(digest);
    let bytes: Vec<u8> = (0..hex.len() / 2)
        .filter_map(|index| u8::from_str_radix(hex.get(index * 2..index * 2 + 2)?, 16).ok())
        .collect();
    format!("sha256={}", crate::base64::encode(&bytes))
}

const JSON: &str = "application/json; charset=utf-8";
const PROBLEM: &str = "application/problem+json; charset=utf-8";

fn json(value: &serde_json::Value) -> Body {
    Body::Json {
        text: serde_json::to_string(value).unwrap_or_default(),
    }
}

/// An RFC 7807 problem response.
pub fn problem(status: u16, slug: &str, title: &str, detail: &str, instance: &str) -> Response {
    let body = serde_json::json!({
        "type": format!("https://shelfkit.dev/problems/{slug}"),
        "title": title,
        "status": status,
        "detail": detail,
        "instance": instance,
    });
    Response {
        status,
        headers: vec![("Content-Type".to_owned(), PROBLEM.to_owned())],
        body: json(&body),
    }
}

fn invalid(errors: Vec<String>, instance: &str) -> Response {
    let detail = errors.join("; ");
    let mut response = problem(422, "invalid-package", "Invalid package", &detail, instance);
    with_extensions(&mut response, serde_json::json!({ "errors": errors }));
    response
}

/// Add `extensions` to a problem's body (section 4: vendor fields belong there).
fn with_extensions(response: &mut Response, extensions: serde_json::Value) {
    if let Body::Json { text } = &mut response.body
        && let Ok(serde_json::Value::Object(mut body)) = serde_json::from_str(text)
    {
        body.insert("extensions".to_owned(), extensions);
        *text = serde_json::Value::Object(body).to_string();
    }
}

fn missing_package(package: &PackageId, instance: &str) -> Response {
    problem(
        404,
        "not-found",
        "Package not found",
        &format!("this registry has no package {}", package.name()),
        instance,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_are_lowercase_hex_and_rfc3230_is_their_base64() {
        let digest = digest(b"abc");
        assert_eq!(
            digest,
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            rfc3230_digest(&digest),
            "sha256=ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
    }

    #[test]
    fn the_manifest_must_name_the_repo_and_the_version() {
        let id = PackageId::parse("acme/web").unwrap();
        assert!(check_manifest(&id, "1.0.0", Some(b"name: Web\nversion: 1.0.0\n")).is_empty());
        assert_eq!(check_manifest(&id, "1.0.0", None).len(), 1);
        assert_eq!(
            check_manifest(&id, "1.0.0", Some(b"name: other\nversion: 2.0.0\n")).len(),
            2
        );
        assert_eq!(
            check_manifest(&id, "1.0", Some(b"name: web\nversion: 1.0\n")),
            vec![
                "apm.yml's `version` is not a string (quote it, as `version: \"1.0\"`)".to_owned()
            ]
        );
        assert_eq!(check_manifest(&id, "1.0.0", Some(b": [")).len(), 1);
    }
}
