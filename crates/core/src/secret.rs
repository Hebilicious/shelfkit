//! Secrets are references, never literals.
//!
//! A shelf is a Git repository that gets cloned, pushed, and served, so a
//! credential written into it is a leaked credential. Values that hold a
//! secret are written as `{ "secret": "NAME" }`, and a literal that looks like
//! a credential fails the load (`docs/PRD.md` sections 5.2 and 11.6).
//!
//! Detection is two rules. Anywhere in a JSON file, a string that contains a
//! well-known token shape fails. In a slot that holds a secret (an HTTP header
//! or environment variable whose name says it carries a key, a token, or a
//! password), any literal fails, because the shape of a private token is not
//! knowable but its slot is.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A value that is either a reference to a named secret or a plain literal.
///
/// The literal form exists for values that are not secret (`LOG_LEVEL`,
/// `Accept`), and the loader refuses a literal that looks like a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretValue {
    /// `{ "secret": "CONTEXT7_API_KEY" }`: resolved where the server runs,
    /// never stored in the shelf.
    Reference {
        secret: String,
    },
    Literal(String),
}

impl Serialize for SecretValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Self::Reference { secret } => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("secret", secret)?;
                map.end()
            }
            Self::Literal(value) => serializer.serialize_str(value),
        }
    }
}

impl<'de> Deserialize<'de> for SecretValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::String(literal) => Ok(Self::Literal(literal)),
            serde_json::Value::Object(map) if map.len() == 1 => match map.get("secret") {
                Some(serde_json::Value::String(name)) if is_secret_name(name) => {
                    Ok(Self::Reference {
                        secret: name.clone(),
                    })
                }
                Some(serde_json::Value::String(name)) => Err(D::Error::custom(format!(
                    "secret name `{name}` must be UPPER_SNAKE_CASE"
                ))),
                _ => Err(D::Error::custom(
                    "expected a string or { \"secret\": \"NAME\" }",
                )),
            },
            _ => Err(D::Error::custom(
                "expected a string or { \"secret\": \"NAME\" }",
            )),
        }
    }
}

fn is_secret_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_uppercase())
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// Prefixes of well-known token formats, with the number of token characters
/// that must follow for a match. The tail length keeps prose such as
/// `sk-learn` or `ghp_` in documentation from tripping the check.
const TOKEN_PREFIXES: &[(&str, usize, &str)] = &[
    ("github_pat_", 22, "a GitHub token"),
    ("ghp_", 30, "a GitHub token"),
    ("gho_", 30, "a GitHub token"),
    ("ghu_", 30, "a GitHub token"),
    ("ghs_", 30, "a GitHub token"),
    ("ghr_", 30, "a GitHub token"),
    ("glpat-", 20, "a GitLab token"),
    ("sk-", 20, "an API secret key"),
    ("sk_live_", 16, "a Stripe key"),
    ("sk_test_", 16, "a Stripe key"),
    ("rk_live_", 16, "a Stripe key"),
    ("xoxb-", 10, "a Slack token"),
    ("xoxp-", 10, "a Slack token"),
    ("xoxa-", 10, "a Slack token"),
    ("xoxr-", 10, "a Slack token"),
    ("xoxs-", 10, "a Slack token"),
    ("AKIA", 16, "an AWS access key"),
    ("ASIA", 16, "an AWS access key"),
    ("AIza", 30, "a Google API key"),
    ("npm_", 30, "an npm token"),
    ("pypi-", 30, "a PyPI token"),
    ("hf_", 30, "a Hugging Face token"),
];

/// Query parameters whose value is a credential.
const SECRET_QUERY_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "key",
    "password",
    "secret",
    "token",
];

/// Words in a header or variable name that mark its value as a secret. A
/// name is split on `_` and `-`, so `X-Api-Key` and `GITHUB_TOKEN` match and
/// `AUTHOR` or `KEYBOARD` do not.
const SECRET_NAME_WORDS: &[&str] = &[
    "apikey",
    "auth",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "key",
    "pass",
    "passwd",
    "password",
    "pat",
    "secret",
    "token",
];

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// A placeholder is not a credential: `${NAME}`, `<your-key>`, or empty.
fn is_placeholder(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || (trimmed.starts_with("${") && trimmed.ends_with('}'))
        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
}

/// Why `value` looks like a credential, if it does.
pub fn looks_like_credential(value: &str) -> Option<&'static str> {
    if value.contains("-----BEGIN") && value.contains("PRIVATE KEY") {
        return Some("a PEM private key");
    }

    let bytes = value.as_bytes();
    for (prefix, tail, reason) in TOKEN_PREFIXES {
        let mut from = 0;
        while let Some(offset) = value[from..].find(prefix) {
            let start = from + offset;
            let at_boundary = start == 0 || !is_token_char(bytes[start - 1]);
            let rest = &bytes[start + prefix.len()..];
            let run = rest.iter().take_while(|b| is_token_char(**b)).count();
            if at_boundary && run >= *tail {
                return Some(reason);
            }
            from = start + prefix.len();
        }
    }

    if let Some(reason) = jwt(value) {
        return Some(reason);
    }

    for scheme in ["Bearer ", "Basic ", "token "] {
        if let Some(start) = value.find(scheme) {
            let rest = &value[start + scheme.len()..];
            let run = rest
                .bytes()
                .take_while(|b| {
                    is_token_char(*b) || *b == b'.' || *b == b'=' || *b == b'+' || *b == b'/'
                })
                .count();
            if run >= 16 && !is_placeholder(rest) {
                return Some("an Authorization credential");
            }
        }
    }

    url_credential(value)
}

fn jwt(value: &str) -> Option<&'static str> {
    let start = value.find("eyJ")?;
    let candidate: String = value[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    let segments: Vec<&str> = candidate.split('.').collect();
    (segments.len() == 3 && segments.iter().all(|s| s.len() >= 8)).then_some("a JSON Web Token")
}

fn url_credential(value: &str) -> Option<&'static str> {
    let after_scheme = value.find("://").map(|i| &value[i + 3..])?;
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if let Some(userinfo) = authority.rsplit_once('@').map(|(u, _)| u)
        && let Some((_, password)) = userinfo.split_once(':')
        && !is_placeholder(password)
    {
        return Some("a password in a URL");
    }

    let query = after_scheme.split_once('?').map(|(_, q)| q)?;
    for pair in query.split(['&', '#']) {
        if let Some((key, val)) = pair.split_once('=')
            && SECRET_QUERY_KEYS.contains(&key.to_ascii_lowercase().as_str())
            && !is_placeholder(val)
        {
            return Some("a credential in a URL query");
        }
    }
    None
}

/// Does a header or environment variable with this name carry a secret?
pub fn is_secret_slot(name: &str) -> bool {
    name.to_ascii_lowercase()
        .split(['_', '-'])
        .any(|word| SECRET_NAME_WORDS.contains(&word))
}

/// Check one value in a named slot: a literal in a secret slot fails even
/// when its shape is unknown.
pub fn check_slot(name: &str, value: &SecretValue) -> Option<&'static str> {
    match value {
        SecretValue::Reference { .. } => None,
        SecretValue::Literal(literal) if is_placeholder(literal) => None,
        SecretValue::Literal(literal) => looks_like_credential(literal).or_else(|| {
            is_secret_slot(name).then_some("a literal value in a slot that carries a secret")
        }),
    }
}

/// Every string in a JSON document that looks like a credential, as
/// `(JSON pointer, reason)`.
pub fn scan_json(value: &serde_json::Value) -> Vec<(String, &'static str)> {
    let mut found = Vec::new();
    scan(value, &mut String::new(), &mut found);
    found
}

fn scan(value: &serde_json::Value, pointer: &mut String, found: &mut Vec<(String, &'static str)>) {
    match value {
        serde_json::Value::String(text) => {
            if let Some(reason) = looks_like_credential(text) {
                found.push((display_pointer(pointer), reason));
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let len = pointer.len();
                pointer.push_str(&format!("/{index}"));
                scan(item, pointer, found);
                pointer.truncate(len);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                let len = pointer.len();
                pointer.push('/');
                pointer.push_str(&key.replace('~', "~0").replace('/', "~1"));
                scan(item, pointer, found);
                pointer.truncate(len);
            }
        }
        _ => {}
    }
}

fn display_pointer(pointer: &str) -> String {
    if pointer.is_empty() {
        "/".to_owned()
    } else {
        pointer.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Token-shaped test values are assembled at run time so the source
    /// never holds a string a secret scanner would flag.
    fn fake(prefix: &str, tail: usize) -> String {
        format!("{prefix}{}", "x1".repeat(tail.div_ceil(2)))
    }

    #[test]
    fn known_token_shapes_are_caught() {
        let jwt = format!(
            "eyJ{}.eyJ{}.{}",
            "a".repeat(20),
            "b".repeat(20),
            "c".repeat(20)
        );
        for literal in [
            fake("ghp_", 36),
            format!("Bearer {}", fake("sk-proj-", 40)),
            fake("AKIA", 16),
            jwt,
            "https://user:hunter2@example.com/mcp".to_owned(),
            "https://mcp.example.com/sse?api_key=abc123".to_owned(),
            format!("-----BEGIN OPENSSH {} KEY-----\nabc", "PRIVATE"),
        ] {
            assert!(looks_like_credential(&literal).is_some(), "{literal}");
        }
    }

    #[test]
    fn prose_and_placeholders_pass() {
        for literal in [
            "Use sk-learn for the model.",
            "Set GITHUB_TOKEN before running.",
            "https://mcp.context7.com/mcp",
            "https://example.com/?page=2",
            "${CONTEXT7_API_KEY}",
            "Bearer ${TOKEN}",
        ] {
            assert_eq!(looks_like_credential(literal), None, "{literal}");
        }
    }

    #[test]
    fn any_literal_in_a_secret_slot_fails() {
        let literal = SecretValue::Literal("not-a-known-shape-but-secret".into());
        assert!(check_slot("Authorization", &literal).is_some());
        assert!(check_slot("API_KEY", &literal).is_some());
        assert!(check_slot("X-Api-Key", &literal).is_some());
        assert!(check_slot("LOG_LEVEL", &literal).is_none());
        assert!(check_slot("AUTHOR", &literal).is_none());
        let reference = SecretValue::Reference {
            secret: "API_KEY".into(),
        };
        assert!(check_slot("API_KEY", &reference).is_none());
    }

    #[test]
    fn references_round_trip() {
        let value: SecretValue = serde_json::from_str(r#"{ "secret": "API_KEY" }"#).unwrap();
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            r#"{"secret":"API_KEY"}"#
        );
        assert!(serde_json::from_str::<SecretValue>(r#"{ "secret": "api-key" }"#).is_err());
        assert!(serde_json::from_str::<SecretValue>(r#"{ "secret": "A", "x": 1 }"#).is_err());
    }

    #[test]
    fn scan_reports_json_pointers() {
        let value = serde_json::json!({ "env": { "A/B": [fake("ghp_", 36)] } });
        assert_eq!(
            scan_json(&value),
            vec![("/env/A~1B/0".to_owned(), "a GitHub token")]
        );
    }
}
