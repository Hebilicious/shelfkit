//! `shelfkit install`: put a hosted profile into a repository, and run APM there (`docs/PRD.md` section 4.2).
//!
//! With a profile (`<shelf>/<profile>`), the repository's apm.yml gains the shelf's registry and a dependency on the
//! profile that follows its newest published version, beside whatever the file already declares. Without one, APM
//! installs what apm.yml already declares. Then, in order:
//!
//! 1. APM's experimental registry support is turned on (`apm experimental enable registries`), and each private
//!    ShelfKit registry apm.yml names is put in APM's user config, the only place APM 0.33 sends a registry key to.
//! 2. `apm install`, with the key `shelfkit login` keeps for each of those registries in `APM_REGISTRY_TOKEN_<NAME>`,
//!    so a key is never in a file, on a command line, or in front of an agent. It is never printed.
//! 3. When apm.yml puts instructions into AGENTS.md (its `compilation` settings, which ShelfKit writes), AGENTS.md is
//!    given the two lines APM writes the instructions between (everything else in it is kept), CLAUDE.md is made to
//!    import AGENTS.md, and `apm compile` writes them. Every agent then reads the same instructions: Codex, Cursor,
//!    and Copilot from AGENTS.md, Claude Code through CLAUDE.md's `@AGENTS.md`.
//!
//! ShelfKit writes apm.yml, those marker lines, and that import line, and nothing else: every file of the profile's
//! content an agent reads is written by APM.

use super::apm::{self, Runner};
use super::hosted::{KEY_ENV, deployment, encode_segment};
use super::output::APM_YML;
use super::system::{HttpRequest, System};
use super::{Context, absolute};
use crate::manifest::{AGENTS_MD_MARKERS, compilation};
use crate::merge::{MergeError, merge};
use crate::yaml::{self, Node};
use serde_json::{Value, json};
use shelfkit_core::OnConflict;
use std::collections::BTreeSet;
use std::path::Path;

/// What `shelfkit install` was asked.
pub struct InstallRequest<'a> {
    /// `<shelf>/<profile>`, to add to apm.yml first.
    pub profile: Option<&'a str>,
    /// The deployment the profile is on.
    pub url: Option<&'a str>,
    pub repo: Option<&'a Path>,
    /// Passed to `apm install`.
    pub apm_args: &'a [String],
}

/// A hosted profile: the shelf (the registry's namespace) and the profile in it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProfileRef {
    shelf: String,
    profile: String,
}

impl ProfileRef {
    fn parse(text: &str) -> Result<Self, String> {
        let valid = |part: &str| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        match text.split_once('/') {
            Some((shelf, profile)) if valid(shelf) && valid(profile) => Ok(Self {
                profile: profile.to_owned(),
                shelf: shelf.to_owned(),
            }),
            _ => Err(format!(
                "`{text}` is not a profile: name it as <shelf>/<profile>, as the shelf's Install page shows it"
            )),
        }
    }

    fn coordinate(&self) -> String {
        format!("{}/{}", self.shelf, self.profile)
    }
}

/// The environment variable APM reads a registry's key from: `APM_REGISTRY_TOKEN_<NAME>`, the name upper-cased with
/// `-` and `.` as `_`.
pub fn token_variable(registry: &str) -> String {
    format!(
        "APM_REGISTRY_TOKEN_{}",
        registry.to_ascii_uppercase().replace(['-', '.'], "_")
    )
}

/// `shelfkit install`. Exits with APM's own code when an APM step fails.
pub fn install(ctx: &mut Context<'_>, request: &InstallRequest<'_>) -> u8 {
    let repo = absolute(ctx, request.repo);
    if let Some(profile) = request.profile {
        if let Err(message) = add_profile(ctx, &repo, profile, request.url) {
            let _ = writeln!(ctx.stderr, "shelfkit: {message}");
            return 1;
        }
    } else if !repo.join(APM_YML).is_file() {
        let _ = writeln!(
            ctx.stderr,
            "shelfkit: {} has no apm.yml. Name a profile to install (`shelfkit install <shelf>/<profile> --url \
             https://<host>`), or run `shelfkit compile` from a shelf",
            repo.display()
        );
        return 1;
    }
    match run_apm(ctx, &repo, request.apm_args) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

/// Check the profile is published and readable, then add it to the repository's apm.yml.
fn add_profile(
    ctx: &mut Context<'_>,
    repo: &Path,
    profile: &str,
    url: Option<&str>,
) -> Result<(), String> {
    let wanted = ProfileRef::parse(profile)?;
    let url = deployment(ctx.system, url)?;
    let key = key_for(ctx.system, &url)?;
    check_published(ctx.system, &url, key.as_deref(), &wanted)?;
    let facts = profile_facts(ctx.system, &url, key.as_deref(), &wanted);

    let path = repo.join(APM_YML);
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let text = with_profile(existing.as_deref(), repo, &url, &wanted, &facts)?;
    if existing.as_deref() == Some(text.as_str()) {
        let _ = writeln!(
            ctx.stderr,
            "apm.yml already installs {} from {url}",
            wanted.coordinate()
        );
        return Ok(());
    }
    std::fs::write(&path, &text).map_err(|error| format!("{}: {error}", path.display()))?;
    let _ = writeln!(
        ctx.stderr,
        "{} apm.yml: the registry `{}` ({url}/apm) and {} at its newest version",
        if existing.is_some() {
            "Updated"
        } else {
            "Wrote"
        },
        wanted.shelf,
        wanted.coordinate()
    );
    Ok(())
}

/// The key to send `url`: `SHELFKIT_KEY`, else the one `shelfkit login` keeps; `None` for a public shelf's reader
/// with neither.
fn key_for(system: &dyn System, url: &str) -> Result<Option<String>, String> {
    if let Some(key) = system.var(KEY_ENV) {
        return Ok(Some(key));
    }
    match system.keychain_get(url) {
        Ok(key) => Ok(key),
        // A machine with no keychain can still install a public shelf.
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => Ok(None),
        Err(error) => Err(format!(
            "reading the key for {url} from the OS keychain: {error}"
        )),
    }
}

fn get(
    system: &dyn System,
    url: &str,
    key: Option<&str>,
) -> Result<super::system::HttpResponse, String> {
    let headers = key
        .map(|key| vec![("authorization".to_owned(), format!("Bearer {key}"))])
        .unwrap_or_default();
    system
        .http(&HttpRequest {
            body: Vec::new(),
            headers,
            method: "GET",
            url: url.to_owned(),
        })
        .map_err(|error| format!("GET {url}: {error}"))
}

/// Ask the registry for the profile's versions, as APM will, and explain what stops APM before it runs.
fn check_published(
    system: &dyn System,
    url: &str,
    key: Option<&str>,
    wanted: &ProfileRef,
) -> Result<(), String> {
    let versions = format!(
        "{url}/apm/v1/packages/{}/{}/versions",
        encode_segment(&wanted.shelf),
        encode_segment(&wanted.profile)
    );
    let response = get(system, &versions, key)?;
    let coordinate = wanted.coordinate();
    match (response.status, key) {
        (200, _) => {
            let published: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            let empty = published
                .get("versions")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
            if empty {
                Err(format!(
                    "{coordinate} is on {url} but not published: its owner publishes it with `shelfkit push`"
                ))
            } else {
                Ok(())
            }
        }
        (401, None) => Err(format!(
            "the shelf `{}` on {url} is private. Once per computer, run `shelfkit login {url}` and paste a key that \
             can read it (its owner makes one in Settings → Keys), then run this again",
            wanted.shelf
        )),
        (401, Some(_)) => Err(format!(
            "{url} does not know the key this computer holds for it: it was revoked or mistyped. Run `shelfkit login \
             {url}` with a key that can read `{}`",
            wanted.shelf
        )),
        (403, _) => Err(format!(
            "the key this computer holds for {url} cannot read {coordinate}: ask the shelf's owner for a key with \
             read scope, and run `shelfkit login {url}` with it"
        )),
        (404, _) => Err(format!(
            "{url} has no profile {coordinate}: check the name on the shelf's Install page, or publish it with \
             `shelfkit push`"
        )),
        (status, _) => Err(format!("{versions} answered {status}")),
    }
}

const PROFILE_FACTS: &str = "query InstallProfile($shelf: ID!, $profile: ID!) { shelf(id: $shelf) { profile(id: \
    $profile) { resolution { compile items { kind } } } } }";

/// What a new apm.yml needs to know about the profile.
#[derive(Debug, Default)]
struct ProfileFacts {
    /// The agents the profile sets up; empty when it names none or the deployment does not say.
    targets: Vec<String>,
    /// Whether it has instructions, tech stacks, or library notes: what goes into AGENTS.md. True when the
    /// deployment does not say.
    instructions: bool,
}

fn profile_facts(
    system: &dyn System,
    url: &str,
    key: Option<&str>,
    wanted: &ProfileRef,
) -> ProfileFacts {
    let unknown = ProfileFacts {
        instructions: true,
        targets: Vec::new(),
    };
    let body = serde_json::to_vec(&json!({
        "query": PROFILE_FACTS,
        "variables": { "profile": wanted.profile, "shelf": wanted.shelf },
    }))
    .unwrap_or_default();
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(key) = key {
        headers.push(("authorization".to_owned(), format!("Bearer {key}")));
    }
    let Ok(response) = system.http(&HttpRequest {
        body,
        headers,
        method: "POST",
        url: format!("{url}/graphql"),
    }) else {
        return unknown;
    };
    let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let resolution = &value["data"]["shelf"]["profile"]["resolution"];
    let Some(items) = resolution["items"].as_array() else {
        return unknown;
    };
    ProfileFacts {
        instructions: items.iter().any(|item| {
            matches!(
                item["kind"].as_str(),
                Some("instructions" | "library" | "stack")
            )
        }),
        targets: resolution["compile"]["targets"]
            .as_array()
            .map(|targets| {
                targets
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// The repository's apm.yml with the profile added: the registry under the shelf's name, a dependency routed to it,
/// and, for a profile with instructions, the `compilation` settings that put them into AGENTS.md. What the file
/// already declares is kept, its `targets` included; the registry entry and the dependency replace an older one of
/// the same name.
fn with_profile(
    existing: Option<&str>,
    repo: &Path,
    url: &str,
    wanted: &ProfileRef,
    facts: &ProfileFacts,
) -> Result<String, String> {
    let mut ours = Vec::new();
    if existing.is_none() {
        let name = repo
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "repository".to_owned());
        ours.push(("name".to_owned(), Node::string(name)));
        ours.push(("version".to_owned(), Node::string("0.0.0")));
        let targets: Vec<String> = if !facts.targets.is_empty() {
            facts.targets.clone()
        } else if uses_a_harness(repo) {
            Vec::new()
        } else {
            DEFAULT_TARGETS
                .iter()
                .map(|&target| target.to_owned())
                .collect()
        };
        if !targets.is_empty() {
            ours.push(("targets".to_owned(), Node::strings(&targets)));
        }
    }
    ours.push((
        "registries".to_owned(),
        Node::Map(vec![(
            wanted.shelf.clone(),
            Node::Map(vec![("url".to_owned(), Node::string(format!("{url}/apm")))]),
        )]),
    ));
    ours.push((
        "dependencies".to_owned(),
        Node::Map(vec![(
            "apm".to_owned(),
            Node::Seq(vec![Node::Map(vec![
                ("registry".to_owned(), Node::string(&wanted.shelf)),
                ("id".to_owned(), Node::string(wanted.coordinate())),
                ("version".to_owned(), Node::string(">=0.0.0")),
            ])]),
        )]),
    ));
    if facts.instructions {
        ours.push(("compilation".to_owned(), compilation()));
    }
    let compiled = yaml::render(&Node::Map(ours));
    let Some(existing) = existing else {
        return Ok(compiled);
    };
    merge(existing, &compiled, &BTreeSet::new(), OnConflict::ShelfWins)
        .map(|merged| merged.text)
        .map_err(|error| match error {
            MergeError::Unreadable(why) => {
                format!("the repository's apm.yml cannot be read: {why}")
            }
            MergeError::Conflicts(conflicts) => conflicts.join(", "),
        })
}

/// The agents a new apm.yml sets up when the profile names none and the repository shows none: without `targets` or
/// a harness's files to detect, APM 0.33 refuses to install.
const DEFAULT_TARGETS: [&str; 4] = ["claude", "codex", "copilot", "cursor"];

/// Whether the repository has a harness's files, from which APM detects the targets itself. AGENTS.md is not one:
/// every agent reads it.
fn uses_a_harness(repo: &Path) -> bool {
    super::HARNESS_SIGNALS
        .iter()
        .filter(|(harness, _)| *harness != "agents-md")
        .flat_map(|(_, files)| files.iter())
        .any(|file| repo.join(file).exists())
}

/// Every ShelfKit registry apm.yml names, with the deployment it is on: `(name, deployment URL)`. A ShelfKit
/// registry is a deployment's `/apm`.
fn shelfkit_registries(manifest: &Node) -> Vec<(String, String)> {
    let Some(Node::Map(registries)) = manifest.get("registries") else {
        return Vec::new();
    };
    registries
        .iter()
        .filter_map(|(name, entry)| {
            let url = entry.get("url")?.as_str()?;
            let deployment = url.trim_end_matches('/').strip_suffix("/apm")?;
            Some((name.clone(), deployment.to_owned()))
        })
        .collect()
}

/// Run one APM command in the repository, printing it first. `Err` carries the exit code to end with.
fn apm_step(
    ctx: &mut Context<'_>,
    runner: &Runner,
    args: &[&str],
    repo: &Path,
    env: &[(String, String)],
) -> Result<(), u8> {
    let Some((program, full)) = runner.command(args) else {
        let _ = writeln!(
            ctx.stderr,
            "shelfkit: {}",
            apm::missing_message(ctx.system.platform())
        );
        return Err(1);
    };
    let _ = writeln!(ctx.stderr, "$ {}", apm::display_command(&program, &full));
    let _ = ctx.stderr.flush();
    match ctx.system.run(&program, &full, repo, env) {
        Ok(0) => Ok(()),
        Ok(code) => Err(u8::try_from(code)
            .ok()
            .filter(|code| *code != 0)
            .unwrap_or(1)),
        Err(error) => {
            let _ = writeln!(
                ctx.stderr,
                "shelfkit: could not run {}: {error}",
                program.display()
            );
            Err(1)
        }
    }
}

/// Configure APM for the registries apm.yml names, install, and compile the instructions into AGENTS.md.
fn run_apm(ctx: &mut Context<'_>, repo: &Path, apm_args: &[String]) -> Result<(), u8> {
    let runner = Runner::resolve(ctx.system);
    if runner == Runner::Missing {
        let _ = writeln!(
            ctx.stderr,
            "shelfkit: {}",
            apm::missing_message(ctx.system.platform())
        );
        return Err(1);
    }
    if runner.supported() == Some(false) {
        let _ = writeln!(
            ctx.stderr,
            "warning: this apm is outside the supported range {}; running it anyway",
            apm::supported_range()
        );
    }
    let text = std::fs::read_to_string(repo.join(APM_YML)).unwrap_or_default();
    let manifest = Node::parse(&text).unwrap_or(Node::Null);

    let mut env = Vec::new();
    let mut private = Vec::new();
    for (name, url) in shelfkit_registries(&manifest) {
        match key_for(ctx.system, &url) {
            Ok(Some(key)) => {
                env.push((token_variable(&name), key));
                private.push((name, url));
            }
            Ok(None) => {}
            Err(message) => {
                let _ = writeln!(ctx.stderr, "warning: {message}");
            }
        }
    }
    if manifest.get("registries").is_some() {
        let _ = writeln!(
            ctx.stderr,
            "APM reads registries only behind its experimental `registries` flag, turned on once per computer:"
        );
        apm_step(
            ctx,
            &runner,
            &["experimental", "enable", "registries"],
            repo,
            &[],
        )?;
    }
    for (name, url) in &private {
        let _ = writeln!(
            ctx.stderr,
            "APM sends `{name}`'s key only to the URL its user config names for it:"
        );
        let setting = format!("registry.{name}.url");
        let registry = format!("{url}/apm");
        apm_step(
            ctx,
            &runner,
            &["config", "set", &setting, &registry],
            repo,
            &[],
        )?;
    }

    let mut args = vec!["install"];
    args.extend(apm_args.iter().map(String::as_str));
    apm_step(ctx, &runner, &args, repo, &env)?;
    if repo.join("apm.lock.yaml").is_file() {
        let _ = writeln!(ctx.stderr, "apm.lock.yaml written by APM");
    }

    if !writes_agents_md(&manifest) {
        return Ok(());
    }
    let targets = manifest_targets(&manifest);
    for change in prepare_context_files(repo, &targets) {
        let _ = writeln!(ctx.stderr, "{change}");
    }
    let compile_targets = compile_targets(&targets);
    let mut compile = vec!["compile", "--target"];
    compile.push(&compile_targets);
    apm_step(ctx, &runner, &compile, repo, &env)
}

/// Whether apm.yml has `apm compile` write instructions between AGENTS.md's markers, as ShelfKit sets it up.
fn writes_agents_md(manifest: &Node) -> bool {
    manifest
        .get("compilation")
        .and_then(|compilation| compilation.get("agents_md"))
        .and_then(|agents_md| agents_md.get("mode"))
        .and_then(Node::as_str)
        == Some("managed_section")
}

/// apm.yml's `targets` (a list) or legacy `target` (comma-separated); empty when APM detects them.
fn manifest_targets(manifest: &Node) -> Vec<String> {
    match manifest.get("targets").or_else(|| manifest.get("target")) {
        Some(Node::Seq(items)) => items
            .iter()
            .filter_map(Node::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Node::String(text)) => text
            .split(',')
            .map(|slug| slug.trim().to_owned())
            .filter(|slug| !slug.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// The targets `apm compile` writes for: `codex`, whose output is AGENTS.md and nothing else, plus `gemini` for a
/// profile that sets Gemini up (its GEMINI.md imports AGENTS.md). Not `claude`, whose CLAUDE.md would repeat what
/// CLAUDE.md's `@AGENTS.md` already brings in, and not `copilot`, whose `.github/copilot-instructions.md` would repeat
/// AGENTS.md, which Copilot reads too.
fn compile_targets(targets: &[String]) -> String {
    if targets
        .iter()
        .any(|target| target == "gemini" || target == "all")
    {
        "codex,gemini".to_owned()
    } else {
        "codex".to_owned()
    }
}

/// The first lines of a file `apm compile` wrote, which it replaces whole.
const GENERATED: [&str; 3] = [
    "<!-- Generated by APM CLI from .apm/ primitives -->",
    "<!-- Generated by APM CLI from distributed .apm/ primitives -->",
    "<!-- Generated by APM CLI -->",
];

fn generated_by_apm(text: &str) -> bool {
    text.lines()
        .take(5)
        .any(|line| GENERATED.contains(&line.trim()))
}

/// Give AGENTS.md the lines `apm compile` writes the instructions between, and have CLAUDE.md import it. Returns a
/// sentence for each file changed. A file that is a symbolic link is left as it is: what it points at is the
/// repository's choice (CLAUDE.md is often a link to AGENTS.md).
fn prepare_context_files(repo: &Path, targets: &[String]) -> Vec<String> {
    let mut changes = Vec::new();
    let (start, end) = AGENTS_MD_MARKERS;
    let markers = format!("{start}\n{end}\n");

    let agents = repo.join("AGENTS.md");
    if !is_symlink(&agents) {
        match std::fs::read_to_string(&agents) {
            Err(_) => {
                if std::fs::write(&agents, &markers).is_ok() {
                    changes
                        .push("Wrote AGENTS.md, for APM to fill with the instructions.".to_owned());
                }
            }
            Ok(text) if text.contains(start) && text.contains(end) => {}
            Ok(text) if generated_by_apm(&text) => {
                if std::fs::write(&agents, &markers).is_ok() {
                    changes.push(
                        "AGENTS.md was written whole by an earlier `apm compile`; it now holds only the section APM \
                         fills."
                            .to_owned(),
                    );
                }
            }
            Ok(text) => {
                let separator = if text.ends_with('\n') { "\n" } else { "\n\n" };
                if std::fs::write(&agents, format!("{text}{separator}{markers}")).is_ok() {
                    changes.push(format!(
                        "Added `{start}` and `{end}` to the end of AGENTS.md: APM writes the instructions between \
                         them, and keeps everything else in the file as it is."
                    ));
                }
            }
        }
    }

    let claude_targeted = targets.is_empty()
        || targets
            .iter()
            .any(|target| target == "claude" || target == "all");
    let claude = repo.join("CLAUDE.md");
    if claude_targeted && !is_symlink(&claude) {
        match std::fs::read_to_string(&claude) {
            Err(_) => {
                if std::fs::write(&claude, "@AGENTS.md\n").is_ok() {
                    changes.push(
                        "Wrote CLAUDE.md as `@AGENTS.md`: Claude Code reads CLAUDE.md, and the import brings AGENTS.md \
                         in."
                            .to_owned(),
                    );
                }
            }
            Ok(text) if text.lines().any(|line| line.trim() == "@AGENTS.md") => {}
            Ok(text) if generated_by_apm(&text) => {
                if std::fs::write(&claude, "@AGENTS.md\n").is_ok() {
                    changes.push(
                        "CLAUDE.md was written by an earlier `apm compile`; it is now `@AGENTS.md`, which brings the \
                         same instructions in."
                            .to_owned(),
                    );
                }
            }
            Ok(text) => {
                let separator = if text.ends_with('\n') { "\n" } else { "\n\n" };
                if std::fs::write(&claude, format!("{text}{separator}@AGENTS.md\n")).is_ok() {
                    changes.push(
                        "Added `@AGENTS.md` to the end of CLAUDE.md, so Claude Code reads the instructions too."
                            .to_owned(),
                    );
                }
            }
        }
    }
    changes
}

fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_is_named_by_its_shelf_and_id() {
        assert_eq!(
            ProfileRef::parse("jarettes-box/default")
                .unwrap()
                .coordinate(),
            "jarettes-box/default"
        );
        assert!(ProfileRef::parse("default").is_err());
        assert!(ProfileRef::parse("a/b/c").is_err());
        assert!(ProfileRef::parse("/b").is_err());
    }

    #[test]
    fn a_registry_key_goes_in_the_variable_apm_reads() {
        assert_eq!(
            token_variable("jarettes-box"),
            "APM_REGISTRY_TOKEN_JARETTES_BOX"
        );
        assert_eq!(token_variable("a.b"), "APM_REGISTRY_TOKEN_A_B");
    }
}
