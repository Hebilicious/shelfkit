//! Credentials and scopes (Registry HTTP API section 2).
//!
//! A request carries a key as `Authorization: Bearer <key>`, or as HTTP
//! Basic, where the password is the key and the user name is ignored, so the
//! two forms grant exactly the same scopes. The host looks the key up and
//! reports its scopes; [`decide`] turns that into the answer:
//!
//! - no credential: an anonymous read of a public shelf is allowed;
//!   anything else is `401`, never `403`, so a client can tell "auth
//!   required" from "not authorized";
//! - a credential the host does not know, or cannot parse: `401`;
//! - a known key without the scope the route needs: `403`, naming it.

use crate::identity::{PackageId, Route};
use serde::{Deserialize, Serialize};

/// What the `Authorization` header presented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// No `Authorization` header.
    None,
    /// A key, from `Bearer <key>` or from the password of `Basic`.
    Key(String),
    /// A header the registry cannot read: another scheme, or broken Basic.
    Unreadable(String),
}

impl Credential {
    /// Read the value of an `Authorization` header, if there is one.
    pub fn from_header(value: Option<&str>) -> Self {
        let Some(value) = value.map(str::trim) else {
            return Self::None;
        };
        let (scheme, rest) = value.split_once(' ').unwrap_or((value, ""));
        let rest = rest.trim();
        if scheme.eq_ignore_ascii_case("bearer") {
            if rest.is_empty() {
                return Self::Unreadable("the Bearer credential is empty".to_owned());
            }
            return Self::Key(rest.to_owned());
        }
        if scheme.eq_ignore_ascii_case("basic") {
            let decoded = crate::base64::decode(rest)
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|text| {
                    text.split_once(':')
                        .map(|(_, password)| password.to_owned())
                });
            return match decoded {
                Some(password) if !password.is_empty() => Self::Key(password),
                _ => Self::Unreadable(
                    "the Basic credential is not base64 of `user:key` with a key".to_owned(),
                ),
            };
        }
        Self::Unreadable(format!(
            "the `{scheme}` scheme is not accepted; send `Bearer <key>`, or Basic with the key as the password"
        ))
    }
}

/// A scope a key carries (section 2.2). Identities compare case-insensitively.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum Scope {
    /// `read`: every package.
    Read,
    /// `read:{owner}/{repo}`
    ReadPackage(String),
    /// `publish:{owner}/{repo}`
    Publish(String),
    /// `publish:{owner}/*`
    PublishOwner(String),
}

impl Scope {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text == "read" {
            return Ok(Self::Read);
        }
        if let Some(identity) = text.strip_prefix("read:") {
            return Ok(Self::ReadPackage(PackageId::parse(identity)?.key()));
        }
        if let Some(rest) = text.strip_prefix("publish:") {
            if let Some(owner) = rest.strip_suffix("/*") {
                // An owner is an identity without its repo.
                PackageId::parse(&format!("{owner}/x"))?;
                return Ok(Self::PublishOwner(owner.to_ascii_lowercase()));
            }
            return Ok(Self::Publish(PackageId::parse(rest)?.key()));
        }
        Err(format!(
            "`{text}` is not a scope: use `read`, `read:{{owner}}/{{repo}}`, `publish:{{owner}}/{{repo}}`, or `publish:{{owner}}/*`"
        ))
    }

    /// Whether this scope lets a key take `route`.
    pub fn allows(&self, route: &Route) -> bool {
        let package = route.package();
        match (self, route.is_read()) {
            (Self::Read, true) => true,
            (Self::ReadPackage(key), true) | (Self::Publish(key), false) => *key == package.key(),
            (Self::PublishOwner(owner), false) => *owner == package.owner_key(),
            _ => false,
        }
    }
}

impl TryFrom<String> for Scope {
    type Error = String;
    fn try_from(text: String) -> Result<Self, String> {
        Self::parse(&text)
    }
}

impl From<Scope> for String {
    fn from(scope: Scope) -> Self {
        scope.to_string()
    }
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read => f.write_str("read"),
            Self::ReadPackage(key) => write!(f, "read:{key}"),
            Self::Publish(key) => write!(f, "publish:{key}"),
            Self::PublishOwner(owner) => write!(f, "publish:{owner}/*"),
        }
    }
}

/// What the host found for the presented credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "credential", rename_all = "kebab-case")]
pub enum Access {
    /// The request carried no credential.
    Anonymous,
    /// The credential is unreadable, or names no key the host has.
    Invalid,
    /// A key the host knows, with its scopes.
    Key { scopes: Vec<Scope> },
}

/// The auth decision for one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// `401`: why.
    Unauthenticated(String),
    /// `403`: the scopes that would have allowed it.
    Forbidden(Vec<String>),
}

/// Decide a request. `public` is whether the owner's shelf serves anonymous
/// reads; an owner the host does not know is not public, so an anonymous
/// request cannot tell a private shelf from a missing one.
pub fn decide(route: &Route, access: &Access, public: bool) -> Decision {
    match access {
        Access::Anonymous if route.is_read() && public => Decision::Allow,
        Access::Anonymous if route.is_read() => Decision::Unauthenticated(
            "this package is not public: send a key with the `read` scope".to_owned(),
        ),
        Access::Anonymous => {
            Decision::Unauthenticated("publishing needs a key with the `publish` scope".to_owned())
        }
        Access::Invalid => {
            Decision::Unauthenticated("the credential is not a key this registry knows".to_owned())
        }
        Access::Key { scopes } if scopes.iter().any(|scope| scope.allows(route)) => Decision::Allow,
        Access::Key { .. } => Decision::Forbidden(required(route)),
    }
}

/// The scopes that allow a route, for a `403`'s message.
fn required(route: &Route) -> Vec<String> {
    let package = route.package();
    if route.is_read() {
        vec!["read".to_owned(), format!("read:{}", package.key())]
    } else {
        vec![
            format!("publish:{}", package.key()),
            format!("publish:{}/*", package.owner_key()),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(identity: &str) -> Route {
        Route::List {
            package: PackageId::parse(identity).unwrap(),
        }
    }

    fn publish(identity: &str) -> Route {
        Route::Publish {
            package: PackageId::parse(identity).unwrap(),
            version: "1.0.0".to_owned(),
        }
    }

    fn key(scopes: &[&str]) -> Access {
        Access::Key {
            scopes: scopes.iter().map(|s| Scope::parse(s).unwrap()).collect(),
        }
    }

    #[test]
    fn bearer_and_basic_present_the_same_key() {
        assert_eq!(
            Credential::from_header(Some("Bearer s3cret")),
            Credential::Key("s3cret".to_owned())
        );
        // base64("anyone:s3cret")
        assert_eq!(
            Credential::from_header(Some("Basic YW55b25lOnMzY3JldA==")),
            Credential::Key("s3cret".to_owned())
        );
        assert_eq!(Credential::from_header(None), Credential::None);
        assert!(matches!(
            Credential::from_header(Some("Token x")),
            Credential::Unreadable(_)
        ));
        assert!(matches!(
            Credential::from_header(Some("Basic !!!")),
            Credential::Unreadable(_)
        ));
        assert!(matches!(
            Credential::from_header(Some("Bearer ")),
            Credential::Unreadable(_)
        ));
    }

    #[test]
    fn missing_credentials_are_401_and_a_missing_scope_is_403() {
        let private = false;
        assert!(matches!(
            decide(&list("acme/x"), &Access::Anonymous, private),
            Decision::Unauthenticated(_)
        ));
        assert!(matches!(
            decide(&publish("acme/x"), &Access::Anonymous, true),
            Decision::Unauthenticated(_)
        ));
        assert!(matches!(
            decide(&list("acme/x"), &Access::Invalid, true),
            Decision::Unauthenticated(_)
        ));
        assert_eq!(
            decide(&list("acme/x"), &Access::Anonymous, true),
            Decision::Allow
        );
        assert_eq!(
            decide(&list("acme/x"), &key(&["publish:acme/*"]), true),
            Decision::Forbidden(vec!["read".to_owned(), "read:acme/x".to_owned()])
        );
    }

    #[test]
    fn each_scope_allows_exactly_its_routes() {
        assert_eq!(
            decide(&list("acme/x"), &key(&["read"]), false),
            Decision::Allow
        );
        assert_eq!(
            decide(&list("Acme/X"), &key(&["read:acme/x"]), false),
            Decision::Allow
        );
        assert!(matches!(
            decide(&list("acme/y"), &key(&["read:acme/x"]), false),
            Decision::Forbidden(_)
        ));
        assert!(matches!(
            decide(&publish("acme/x"), &key(&["read"]), false),
            Decision::Forbidden(_)
        ));
        assert_eq!(
            decide(&publish("acme/x"), &key(&["publish:acme/x"]), false),
            Decision::Allow
        );
        assert_eq!(
            decide(&publish("acme/y"), &key(&["publish:acme/*"]), false),
            Decision::Allow
        );
        assert!(matches!(
            decide(&publish("other/y"), &key(&["publish:acme/*"]), false),
            Decision::Forbidden(_)
        ));
        assert_eq!(
            decide(
                &publish("gitlab.com/acme/y"),
                &key(&["publish:gitlab.com/acme/*"]),
                false
            ),
            Decision::Allow
        );
    }

    #[test]
    fn scopes_parse_and_print_back() {
        for text in ["read", "read:acme/x", "publish:acme/x", "publish:acme/*"] {
            assert_eq!(Scope::parse(text).unwrap().to_string(), text);
        }
        for bad in ["write", "read:", "publish:acme", "publish:*", "read:../x"] {
            assert!(Scope::parse(bad).is_err(), "{bad}");
        }
    }
}
