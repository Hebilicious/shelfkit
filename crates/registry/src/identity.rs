//! Package identity and the three routes (Registry HTTP API sections 1.2
//! and 3).
//!
//! A package is `{owner}/{repo}`. For a GitHub-origin identity those are two
//! path segments; for any other origin the identity is percent-encoded, each
//! `/` as `%2F`, and APM's client splits it at its last `/` before encoding
//! each half, so `gitlab.com/acme/web-skills` arrives as
//! `gitlab.com%2Facme/web-skills`. Every segment is therefore decoded, the
//! decoded segments are joined with `/`, and the result is split again at
//! its last `/`: whichever way a client encodes an identity, it names one
//! package.
//!
//! A ShelfKit shelf publishes each profile as `{namespace}/{profile}`: the
//! shelf's `registry.namespace` is the owner, and the profile id the repo.

use serde::Serialize;

/// A package identity, as the client spelled it, with its owner and repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackageId {
    pub owner: String,
    pub repo: String,
}

impl PackageId {
    /// Parse an identity written as text: `owner/repo`, or a longer
    /// non-GitHub identity whose last component is the repo.
    pub fn parse(identity: &str) -> Result<Self, String> {
        let components: Vec<&str> = identity.split('/').collect();
        if components.len() < 2 {
            return Err(format!(
                "`{identity}` is not a package identity: it needs an owner and a repo, as `owner/repo`"
            ));
        }
        for component in &components {
            check_component(identity, component)?;
        }
        let (repo, owner) = components.split_last().ok_or_else(|| identity.to_owned())?;
        Ok(Self {
            owner: owner.join("/"),
            repo: (*repo).to_owned(),
        })
    }

    /// `owner/repo`, as the client sent it: what responses echo as `package`.
    pub fn name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The key a host stores the package under. Registry coordinates are
    /// case-insensitive (OpenAPM v0.1), so `Acme/Web` and `acme/web` are one
    /// package.
    pub fn key(&self) -> String {
        self.name().to_ascii_lowercase()
    }

    /// The owner as a host looks up its shelf: lowercase.
    pub fn owner_key(&self) -> String {
        self.owner.to_ascii_lowercase()
    }

    /// The path segments APM's client sends for this identity: the owner and
    /// the repo, each percent-encoded, so a `/` inside the owner is `%2F`.
    pub fn path(&self) -> String {
        format!("{}/{}", encode(&self.owner), encode(&self.repo))
    }
}

impl std::fmt::Display for PackageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.owner, self.repo)
    }
}

/// One component of an identity: what GitHub, GitLab, and Azure DevOps
/// allow in an owner, group, or repository name, and never `.` or `..`.
fn check_component(identity: &str, component: &str) -> Result<(), String> {
    if component.is_empty() {
        return Err(format!("`{identity}` has an empty component"));
    }
    if component == "." || component == ".." {
        return Err(format!("`{identity}` has a `{component}` component"));
    }
    if let Some(bad) = component
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')))
    {
        return Err(format!(
            "`{}` contains `{}`; an identity component is letters, digits, `-`, `_`, `.`, and `~`",
            identity.escape_debug(),
            bad.escape_debug()
        ));
    }
    Ok(())
}

/// Check a version selector from a path or a manifest (section 6, rule 1):
/// opaque, but not empty, not a control character, and of a sane length.
pub fn check_version(version: &str) -> Result<(), String> {
    if version.is_empty() {
        return Err("the version is empty".to_owned());
    }
    if version.chars().any(char::is_control) {
        return Err(format!(
            "the version `{}` contains a control character",
            version.escape_debug()
        ));
    }
    if version.len() > 256 {
        return Err("the version is longer than 256 bytes".to_owned());
    }
    Ok(())
}

/// What a request asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "operation", rename_all = "kebab-case")]
pub enum Route {
    /// `GET /v1/packages/{owner}/{repo}/versions`
    List { package: PackageId },
    /// `GET /v1/packages/{owner}/{repo}/versions/{version}/download`
    Download { package: PackageId, version: String },
    /// `PUT /v1/packages/{owner}/{repo}/versions/{version}`
    Publish { package: PackageId, version: String },
}

impl Route {
    pub fn package(&self) -> &PackageId {
        match self {
            Self::List { package }
            | Self::Download { package, .. }
            | Self::Publish { package, .. } => package,
        }
    }

    pub fn is_read(&self) -> bool {
        !matches!(self, Self::Publish { .. })
    }
}

/// Why a path is not one of the three routes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    /// No route has this shape.
    NotFound,
    /// A route has this shape, but not for this method; the methods it takes.
    MethodNotAllowed(&'static str),
    /// The shape is right, but a segment is not a valid identity or version.
    Invalid(String),
}

/// Match a method and a path relative to the registry's base URL. The query
/// string, if any, is ignored.
pub fn route(method: &str, path: &str) -> Result<Route, RouteError> {
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    let Some(rest) = path.strip_prefix("/v1/packages/") else {
        return Err(RouteError::NotFound);
    };
    let raw: Vec<&str> = rest.split('/').collect();

    // Read from the end: `.../versions`, `.../versions/{v}/download`, or
    // `.../versions/{v}`. The identity is everything before `versions`.
    let (identity, version, shape) = match raw.as_slice() {
        [identity @ .., "versions"] => (identity, None, Shape::List),
        [identity @ .., "versions", version, "download"] => {
            (identity, Some(*version), Shape::Download)
        }
        [identity @ .., "versions", version] => (identity, Some(*version), Shape::Publish),
        _ => return Err(RouteError::NotFound),
    };
    if identity.is_empty() {
        return Err(RouteError::NotFound);
    }
    let allowed = match shape {
        Shape::List | Shape::Download => "GET",
        Shape::Publish => "PUT",
    };
    if method != allowed {
        return Err(RouteError::MethodNotAllowed(allowed));
    }

    let mut decoded = Vec::with_capacity(identity.len());
    for segment in identity {
        decoded.push(decode(segment).map_err(RouteError::Invalid)?);
    }
    let package = PackageId::parse(&decoded.join("/")).map_err(RouteError::Invalid)?;
    let version = match version {
        Some(raw) => {
            let version = decode(raw).map_err(RouteError::Invalid)?;
            check_version(&version).map_err(RouteError::Invalid)?;
            Some(version)
        }
        None => None,
    };
    Ok(match (shape, version) {
        (Shape::List, _) => Route::List { package },
        (Shape::Download, Some(version)) => Route::Download { package, version },
        (Shape::Publish, Some(version)) => Route::Publish { package, version },
        (_, None) => return Err(RouteError::NotFound),
    })
}

enum Shape {
    List,
    Download,
    Publish,
}

/// Percent-decode one path segment into UTF-8 text.
pub fn decode(segment: &str) -> Result<String, String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| format!("`{segment}` has a broken percent escape"))?;
            out.push(hex);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("`{segment}` does not decode to UTF-8"))
}

/// Percent-encode a path segment as APM's client does: everything but
/// letters, digits, `.`, `-`, `_`, and `~`.
pub fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(owner: &str, repo: &str) -> PackageId {
        PackageId {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
        }
    }

    #[test]
    fn the_three_routes() {
        assert_eq!(
            route("GET", "/v1/packages/acme/web-skills/versions"),
            Ok(Route::List {
                package: package("acme", "web-skills")
            })
        );
        assert_eq!(
            route(
                "GET",
                "/v1/packages/acme/web-skills/versions/1.2.0/download"
            ),
            Ok(Route::Download {
                package: package("acme", "web-skills"),
                version: "1.2.0".to_owned()
            })
        );
        assert_eq!(
            route("PUT", "/v1/packages/acme/web-skills/versions/1.2.0"),
            Ok(Route::Publish {
                package: package("acme", "web-skills"),
                version: "1.2.0".to_owned()
            })
        );
    }

    #[test]
    fn non_github_identities_decode_whichever_way_they_are_encoded() {
        let expected = package("gitlab.com/acme", "web-skills");
        for path in [
            "/v1/packages/gitlab.com%2Facme%2Fweb-skills/versions",
            "/v1/packages/gitlab.com%2Facme/web-skills/versions",
            "/v1/packages/gitlab.com%2facme/web-skills/versions",
        ] {
            assert_eq!(
                route("GET", path),
                Ok(Route::List {
                    package: expected.clone()
                }),
                "{path}"
            );
        }
        assert_eq!(expected.path(), "gitlab.com%2Facme/web-skills");
        let ado = route(
            "GET",
            "/v1/packages/dev.azure.com%2Forg%2Fproj%2Frepo/versions",
        )
        .unwrap();
        assert_eq!(ado.package().owner, "dev.azure.com/org/proj");
        assert_eq!(ado.package().name(), "dev.azure.com/org/proj/repo");
    }

    #[test]
    fn versions_are_opaque_and_decoded() {
        assert_eq!(
            route("GET", "/v1/packages/a/b/versions/0.0.0%2Babc/download"),
            Ok(Route::Download {
                package: package("a", "b"),
                version: "0.0.0+abc".to_owned()
            })
        );
        assert!(matches!(
            route("PUT", "/v1/packages/a/b/versions/%0A"),
            Err(RouteError::Invalid(_))
        ));
    }

    #[test]
    fn traversal_and_garbage_are_refused_before_any_lookup() {
        for path in [
            "/v1/packages/../b/versions",
            "/v1/packages/a/%2E%2E/versions",
            "/v1/packages/a%2F..%2Fb/c/versions",
            "/v1/packages/a//b/versions",
            "/v1/packages/a/b%00/versions",
            "/v1/packages/a/b%zz/versions",
            "/v1/packages/a%FF/b/versions",
        ] {
            assert!(
                matches!(route("GET", path), Err(RouteError::Invalid(_))),
                "{path}"
            );
        }
        assert_eq!(
            route("GET", "/v1/packages/onlyowner/versions"),
            Err(RouteError::Invalid(
                "`onlyowner` is not a package identity: it needs an owner and a repo, as `owner/repo`"
                    .to_owned()
            ))
        );
        for path in [
            "/",
            "/v1/packages/",
            "/v2/packages/a/b/versions",
            "/v1/packages/a/b",
        ] {
            assert_eq!(route("GET", path), Err(RouteError::NotFound), "{path}");
        }
    }

    #[test]
    fn a_route_with_the_wrong_method_says_which_it_takes() {
        assert_eq!(
            route("PUT", "/v1/packages/a/b/versions"),
            Err(RouteError::MethodNotAllowed("GET"))
        );
        assert_eq!(
            route("DELETE", "/v1/packages/a/b/versions/1.0.0"),
            Err(RouteError::MethodNotAllowed("PUT"))
        );
    }

    #[test]
    fn keys_are_case_insensitive_and_names_echo_the_request() {
        let id = PackageId::parse("Acme/Web-Skills").unwrap();
        assert_eq!(id.name(), "Acme/Web-Skills");
        assert_eq!(id.key(), "acme/web-skills");
    }
}
