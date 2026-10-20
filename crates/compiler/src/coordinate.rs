//! Upstream coordinates: how an imported item is referenced from `apm.yml`.
//!
//! Two parser rules from `docs/PRD.md` section 3.1 shape everything here. A
//! Git pin is `#<ref>` and nothing else; `@` is never a ref separator, though
//! it may appear inside a literal ref. A registry-routed dependency uses the
//! object form `{ id, version }`, because a version selector is not a Git
//! ref. Registry URLs follow what APM 0.33.0 accepts: `https://`, or plain
//! `http://` only for a loopback host, with no credentials, query, or
//! fragment; APM has no insecure opt-in.

use crate::yaml::Node;
use shelfkit_core::profile::{ShelfSource, SourceKind};
use shelfkit_core::{ItemKind, Pin, Source};
use std::net::{Ipv4Addr, Ipv6Addr};

/// The host APM strips from shorthand, as its canonical form does.
const DEFAULT_HOST: &str = "github.com";

/// An item's reference to its upstream, ready to write into `dependencies.apm`.
#[derive(Debug, Clone, PartialEq)]
pub enum Upstream {
    /// A Git repository, a directory in one, or one file in one.
    Git(GitRef),
    /// A package on an OpenAPM registry.
    Registry(RegistryRef),
}

#[derive(Debug, Clone, PartialEq)]
pub struct GitRef {
    /// The repository as `host/owner/repo`, lowercase host, no scheme or `.git`.
    pub repository: String,
    /// The path inside the repository, when the item is not the whole of it.
    pub path: Option<String>,
    /// The ref to pin: a commit, a tag, or a branch.
    pub git_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegistryRef {
    /// The `registries` key: the id of the shelf source.
    pub registry: String,
    pub url: String,
    /// `owner/repo` on the registry.
    pub id: String,
    pub version: String,
}

impl Upstream {
    /// The `dependencies.apm` entry. `targets` restricts which of the
    /// install's targets receive the dependency.
    ///
    /// A Git reference is always written in the object form `{ git, ref }`.
    /// APM keeps that form on Git even when a default registry is active, and
    /// one can be active without the manifest saying so: the repository's own
    /// `apm.yml`, or `registry.<name>.default` in `~/.apm/config.json`. In the
    /// string form, `o/r#ref` would be routed through that registry instead.
    ///
    /// The object forms are the ones the OpenAPM v0.1 schema accepts: its
    /// `depEntry` allows exactly one of `git`, `id`, `path`, and `registry`,
    /// so a Git path rides inside `git` (APM parses it there as in the string
    /// form) and a registry dependency is routed by `registries.default`
    /// rather than a `registry` key.
    pub fn entry(&self, targets: Option<&[String]>) -> Node {
        let mut entry = match self {
            Self::Git(git) => git.entry(),
            Self::Registry(registry) => Node::Map(vec![
                ("id".to_owned(), Node::string(&registry.id)),
                ("version".to_owned(), Node::string(&registry.version)),
            ]),
        };
        if let (Some(targets), Node::Map(entries)) = (targets, &mut entry) {
            entries.push(("targets".to_owned(), Node::strings(targets)));
        }
        entry
    }
}

impl GitRef {
    /// `[host/]owner/repo[/path]`: shorthand with the default host stripped,
    /// and the host kept for any other, as APM's canonical form writes it.
    fn coordinate(&self) -> String {
        let mut text = self
            .repository
            .strip_prefix(DEFAULT_HOST)
            .and_then(|rest| rest.strip_prefix('/'))
            .unwrap_or(&self.repository)
            .to_owned();
        if let Some(path) = &self.path {
            text.push('/');
            text.push_str(path);
        }
        text
    }

    /// `{ git: coordinate, ref }`: APM parses the path inside `git` as it
    /// does in the string form.
    fn entry(&self) -> Node {
        let mut entries = vec![("git".to_owned(), Node::String(self.coordinate()))];
        if let Some(git_ref) = &self.git_ref {
            entries.push(("ref".to_owned(), Node::string(git_ref)));
        }
        Node::Map(entries)
    }
}

/// A path segment in APM's string grammar: `1*( ALPHA / DIGIT / "-" / "_" / "." )`.
fn is_grammar_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Find an item's upstream, if it has one. `Ok(None)` means the item is not
/// a reference: its content is in the shelf and it compiles into the vendored
/// package. An error is a message about the item's `source`.
pub fn upstream(
    kind: ItemKind,
    source: &Source,
    shelf_sources: &[ShelfSource],
    pin: Pin,
) -> Result<Option<Upstream>, String> {
    let declared = source
        .id
        .as_ref()
        .and_then(|id| shelf_sources.iter().find(|s| &s.id == id));

    if let Some(registry) = declared.filter(|s| s.kind == SourceKind::ApmRegistry) {
        return registry_ref(source, registry, pin).map(|r| Some(Upstream::Registry(r)));
    }

    let Some(repo) = source.repo.as_deref() else {
        return Ok(None);
    };
    let repository = normalize_repository(repo)?;
    let path = match source.path.as_deref().map(clean_path).transpose()? {
        Some(path) => Some(primitive_path(kind, path)?),
        None => None,
    };
    if let Some(path) = &path {
        if !path.split('/').all(is_grammar_segment) {
            return Err(format!(
                "`source.path` `{path}` has a segment APM's dependency grammar cannot carry; \
                 segments are letters, digits, `-`, `_`, and `.`"
            ));
        }
        if repository.split('/').count() > 3 {
            return Err(format!(
                "`{repository}` is a nested group, which APM can pin with a path only in the \
                 `{{ git, path }}` object form, and the OpenAPM v0.1 schema rejects that form"
            ));
        }
    }
    let git_ref = match pin {
        Pin::Revision => source
            .resolved_commit
            .clone()
            .or_else(|| source.git_ref.clone()),
        Pin::Latest => source.git_ref.clone(),
    };
    if pin == Pin::Revision && git_ref.is_none() {
        return Err(
            "`pin: revision` needs `source.resolvedCommit` or `source.ref` to pin the upstream; \
             set one, or compile with `pin: latest`"
                .to_owned(),
        );
    }
    if let Some(git_ref) = &git_ref
        && (git_ref.is_empty() || git_ref.chars().any(char::is_whitespace))
    {
        return Err(format!(
            "`{git_ref}` is not a Git ref: it must be non-empty with no whitespace"
        ));
    }
    Ok(Some(Upstream::Git(GitRef {
        repository,
        path,
        git_ref,
    })))
}

fn registry_ref(source: &Source, registry: &ShelfSource, pin: Pin) -> Result<RegistryRef, String> {
    let Some(url) = registry.url.as_deref() else {
        return Err(format!(
            "source `{}` is an apm-registry with no `url` in shelf.json",
            registry.id
        ));
    };
    check_registry_url(url).map_err(|reason| format!("source `{}`: {reason}", registry.id))?;
    let Some(path) = source.path.as_deref() else {
        return Err(
            "a registry item needs `source.path`, the package as `owner/repo[/path]`".to_owned(),
        );
    };
    let path = clean_path(path)?;
    let mut segments = path.splitn(3, '/');
    let (Some(owner), Some(repo)) = (segments.next(), segments.next()) else {
        return Err(format!(
            "`source.path` `{path}` must start with the package `owner/repo`"
        ));
    };
    if let Some(inner) = segments.next() {
        return Err(format!(
            "`source.path` `{path}` names `{inner}` inside the package `{owner}/{repo}`; APM \
             writes that as `{{ id, path }}`, and the OpenAPM v0.1 schema rejects `path` beside \
             `id`, so a registry item is a whole package"
        ));
    }
    let Some(version) = source.version.clone().filter(|v| !v.trim().is_empty()) else {
        return Err(
            "a registry item needs `source.version`, the version it resolved to".to_owned(),
        );
    };
    Ok(RegistryRef {
        registry: registry.id.clone(),
        url: url.trim_end_matches('/').to_owned(),
        id: format!("{owner}/{repo}"),
        // `latest` lets the registry pick the newest version; a revision pin
        // names the exact version that was imported.
        version: match pin {
            Pin::Revision => version,
            Pin::Latest => "*".to_owned(),
        },
    })
}

/// A path inside a repository or package: relative, `/`-separated, no empty,
/// `.`, or `..` segment.
fn clean_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Err("`source.path` must not be empty".to_owned());
    }
    if trimmed.contains('\\')
        || trimmed
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(format!(
            "`source.path` `{path}` must be relative with `/` separators and no empty, `.`, or `..` segment"
        ));
    }
    Ok(trimmed.to_owned())
}

/// Check that a path names what the item's kind can be. APM classifies a
/// virtual package by file extension only: `.prompt.md`, `.instructions.md`,
/// and `.agent.md` are files, anything else is a directory.
fn primitive_path(kind: ItemKind, path: String) -> Result<String, String> {
    const FILES: [&str; 3] = [".prompt.md", ".instructions.md", ".agent.md"];
    let file_extension = FILES.iter().find(|ext| path.ends_with(*ext));
    match (kind.apm_virtual_extension(), file_extension) {
        (Some(expected), Some(found)) if expected != *found => Err(format!(
            "`source.path` `{path}` is a `{found}` file, which APM installs as another kind than `{kind}`"
        )),
        (None, Some(found)) => Err(format!(
            "`source.path` `{path}` is a `{found}` file, but a `{kind}` item references a directory"
        )),
        // A skill's directory, not its SKILL.md: APM installs the directory.
        _ if kind == ItemKind::Skill => Ok(path
            .strip_suffix("/SKILL.md")
            .map(str::to_owned)
            .unwrap_or(path)),
        _ => Ok(path),
    }
}

/// `https://github.com/o/r.git`, `git@host:o/r`, `ssh://git@host/o/r`,
/// `host/o/r`, or `o/r` to `host/o/r`.
fn normalize_repository(repo: &str) -> Result<String, String> {
    let invalid = |why: &str| format!("`source.repo` `{repo}` {why}");
    let rest = if let Some(rest) = repo.strip_prefix("https://") {
        rest.to_owned()
    } else if repo.starts_with("http://") {
        return Err(invalid(
            "uses plain http, which APM installs only behind an insecure-host opt-in; use https",
        ));
    } else if let Some(rest) = repo.strip_prefix("ssh://git@") {
        rest.to_owned()
    } else if let Some(rest) = repo.strip_prefix("git@") {
        rest.replacen(':', "/", 1)
    } else if repo.contains("://") {
        return Err(invalid("is not a Git URL APM resolves"));
    } else {
        repo.to_owned()
    };
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut segments: Vec<&str> = rest.split('/').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return Err(invalid("has an empty, `.`, or `..` segment"));
    }
    // Shorthand without a host is on the default host.
    let has_host = segments.len() > 2 && segments[0].contains('.');
    if !has_host {
        segments.insert(0, DEFAULT_HOST);
    }
    if segments.len() < 3 {
        return Err(invalid("must name a repository as `owner/repo`"));
    }
    let host = segments[0].to_ascii_lowercase();
    if host.contains('@') || host.contains(':') {
        return Err(invalid("must not carry credentials or a port"));
    }
    let mut out = host;
    for segment in &segments[1..] {
        out.push('/');
        out.push_str(segment);
    }
    Ok(out)
}

/// A registry URL APM 0.33.0 accepts (`apm_cli/deps/registry/client.py`,
/// `_validate_registry_transport`): `https://`, or `http://` only to a
/// loopback host (`127.0.0.0/8`, `::1`, `localhost`); no credentials, query,
/// or fragment. APM has no insecure opt-in, so neither does ShelfKit. A
/// backslash is refused too: URL parsers disagree on it, and one reading of
/// `http://evil.example\@127.0.0.1/` sends the request to `evil.example`.
pub fn check_registry_url(url: &str) -> Result<(), String> {
    let refuse = |why: &str| Err(format!("registry URL `{url}` {why}"));
    if url.contains('\\') || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return refuse("must not contain a backslash, whitespace, or a control character");
    }
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        ("http", rest)
    } else {
        return refuse("must start with https://");
    };
    if rest.contains(['?', '#']) {
        return refuse("must not carry a query string or a fragment, which APM refuses");
    }
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.contains('@') {
        return refuse(
            "must not carry credentials, which APM refuses; set them in APM's configuration",
        );
    }
    if authority.is_empty() {
        return refuse("has no host");
    }
    if scheme == "https" || is_loopback(authority) {
        return Ok(());
    }
    refuse(
        "is plain http to a host that is not loopback. APM 0.33.0 allows plain http only for \
         loopback testing (`_validate_registry_transport`) and has no insecure opt-in: serve the \
         registry over https, or reach it through a loopback tunnel such as \
         `ssh -L 8787:<host>:8787` and use `http://127.0.0.1:8787`",
    )
}

/// `127.0.0.0/8`, `::1`, or `localhost`, with or without a port.
fn is_loopback(authority: &str) -> bool {
    if let Some(inner) = authority.strip_prefix('[') {
        let address = inner.split(']').next().unwrap_or_default();
        return address.parse::<Ipv6Addr>().is_ok_and(|ip| ip.is_loopback());
    }
    let host = authority.split(':').next().unwrap_or_default();
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yaml::render;

    fn git_source(
        repo: &str,
        path: Option<&str>,
        git_ref: Option<&str>,
        commit: Option<&str>,
    ) -> Source {
        Source {
            repo: Some(repo.to_owned()),
            path: path.map(str::to_owned),
            git_ref: git_ref.map(str::to_owned),
            resolved_commit: commit.map(str::to_owned),
            ..Source::default()
        }
    }

    fn entry(kind: ItemKind, source: &Source, pin: Pin) -> Result<String, String> {
        let upstream = upstream(kind, source, &[], pin)?.ok_or("no upstream")?;
        Ok(render(&Node::Map(vec![("e".into(), upstream.entry(None))])))
    }

    #[test]
    fn a_pin_is_a_ref_never_an_at_and_git_is_always_explicit() {
        let source = git_source(
            "https://github.com/anthropics/skills",
            Some("skills/frontend-design"),
            Some("main"),
            Some("0123456789abcdef0123456789abcdef01234567"),
        );
        assert_eq!(
            entry(ItemKind::Skill, &source, Pin::Revision).unwrap(),
            "e:\n  git: anthropics/skills/skills/frontend-design\n  \
             ref: \"0123456789abcdef0123456789abcdef01234567\"\n"
        );
        assert_eq!(
            entry(ItemKind::Skill, &source, Pin::Latest).unwrap(),
            "e:\n  git: anthropics/skills/skills/frontend-design\n  ref: main\n"
        );
    }

    #[test]
    fn an_at_inside_a_ref_stays_literal() {
        let source = git_source(
            "github.com/o/r",
            Some("p/x.prompt.md"),
            Some("release@2"),
            None,
        );
        assert_eq!(
            entry(ItemKind::Prompt, &source, Pin::Revision).unwrap(),
            "e:\n  git: o/r/p/x.prompt.md\n  ref: release@2\n"
        );
    }

    #[test]
    fn other_hosts_keep_their_name_and_nested_groups_need_no_path() {
        let source = git_source(
            "git@gitlab.com:acme/repo.git",
            Some("x.agent.md"),
            Some("v1"),
            None,
        );
        assert_eq!(
            entry(ItemKind::Agent, &source, Pin::Revision).unwrap(),
            "e:\n  git: gitlab.com/acme/repo/x.agent.md\n  ref: v1\n"
        );
        let nested = git_source(
            "https://gitlab.com/g/sub/repo",
            Some("skills/a"),
            Some("v1"),
            None,
        );
        assert!(
            entry(ItemKind::Skill, &nested, Pin::Revision)
                .unwrap_err()
                .contains("nested group")
        );
        let whole = git_source("https://gitlab.com/g/sub/repo", None, Some("v1"), None);
        assert_eq!(
            entry(ItemKind::Plugin, &whole, Pin::Revision).unwrap(),
            "e:\n  git: gitlab.com/g/sub/repo\n  ref: v1\n"
        );
    }

    #[test]
    fn item_targets_ride_on_the_object_form() {
        let source = git_source("o/r", Some("skills/a"), Some("v1"), None);
        let found = upstream(ItemKind::Skill, &source, &[], Pin::Revision)
            .unwrap()
            .unwrap();
        let targets = ["claude".to_owned()];
        assert_eq!(
            render(&Node::Map(vec![("e".into(), found.entry(Some(&targets)))])),
            "e:\n  git: o/r/skills/a\n  ref: v1\n  targets:\n    - claude\n"
        );
    }

    #[test]
    fn a_revision_pin_needs_something_to_pin_to() {
        let source = git_source("o/r", None, None, None);
        assert!(
            entry(ItemKind::Plugin, &source, Pin::Revision)
                .unwrap_err()
                .contains("resolvedCommit")
        );
        assert_eq!(
            entry(ItemKind::Plugin, &source, Pin::Latest).unwrap(),
            "e:\n  git: o/r\n"
        );
    }

    #[test]
    fn a_file_must_be_the_kind_apm_will_install() {
        let source = git_source("o/r", Some("a/x.agent.md"), Some("v1"), None);
        assert!(entry(ItemKind::Prompt, &source, Pin::Revision).is_err());
        assert!(entry(ItemKind::Skill, &source, Pin::Revision).is_err());
        let skill = git_source("o/r", Some("skills/a/SKILL.md"), Some("v1"), None);
        assert_eq!(
            entry(ItemKind::Skill, &skill, Pin::Revision).unwrap(),
            "e:\n  git: o/r/skills/a\n  ref: v1\n"
        );
    }

    #[test]
    fn plain_http_git_is_refused() {
        let source = git_source("http://example.com/o/r", None, Some("v1"), None);
        assert!(
            entry(ItemKind::Skill, &source, Pin::Revision)
                .unwrap_err()
                .contains("plain http")
        );
    }

    fn registry(url: &str) -> ShelfSource {
        ShelfSource {
            id: "acme".into(),
            kind: SourceKind::ApmRegistry,
            repo: None,
            url: Some(url.into()),
            path: None,
            tier: None,
            profile: None,
        }
    }

    #[test]
    fn registry_items_use_the_object_form_with_a_version() {
        let source = Source {
            id: Some("acme".into()),
            path: Some("acme/team-conventions".into()),
            version: Some("1.2.0".into()),
            ..Source::default()
        };
        let sources = [registry("https://shelf.acme.dev/apm/")];
        let found = upstream(ItemKind::Instructions, &source, &sources, Pin::Revision)
            .unwrap()
            .unwrap();
        assert_eq!(
            render(&Node::Map(vec![("e".into(), found.entry(None))])),
            "e:\n  id: acme/team-conventions\n  version: \"1.2.0\"\n"
        );
        let Upstream::Registry(r) = found else {
            panic!()
        };
        assert_eq!(r.url, "https://shelf.acme.dev/apm");

        let inner = Source {
            path: Some("acme/toolkit/skills/deploy".into()),
            ..source
        };
        let error = upstream(ItemKind::Skill, &inner, &sources, Pin::Revision).unwrap_err();
        assert!(error.contains("whole package"), "{error}");
    }

    #[test]
    fn registry_urls_are_what_apm_accepts_https_or_loopback_http() {
        for ok in [
            "https://x.example/apm",
            "https://10.0.0.1/apm",
            "http://127.0.0.1:8787/apm",
            "http://127.9.9.9/apm",
            "http://localhost:8787",
            "http://[::1]:8787/apm",
        ] {
            assert_eq!(check_registry_url(ok), Ok(()), "{ok}");
        }
        for bad in [
            // RFC 1918 and public hosts over plain http: APM refuses both.
            "http://192.168.1.20:8787/apm",
            "http://10.1.2.3/apm",
            "http://shelf.example/apm",
            // A backslash and userinfo, which parsers read differently.
            "http://evil.com\\@10.0.0.1/apm",
            "http://evil.com\\@127.0.0.1/apm",
            "https://user:pass@x.example/apm",
            "http://evil.com@127.0.0.1/apm",
            "https://x.example/apm?token=1",
            "https://x.example/apm#f",
            "ftp://x/apm",
            "https://",
        ] {
            assert!(check_registry_url(bad).is_err(), "{bad}");
        }
        let message = check_registry_url("http://192.168.1.20:8787/apm").unwrap_err();
        assert!(
            message.contains("loopback") && message.contains("https"),
            "{message}"
        );
    }
}
