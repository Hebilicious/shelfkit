//! `shelfkit add <source>` for a source that is not on this machine: a Git
//! repository, a catalog (ClawHub, an MCP registry), or another ShelfKit
//! instance.
//!
//! The CLI runs no adapter of its own. It starts an import job on the hosted
//! shelf (`startImport`), where the importer's adapters discover what the
//! source offers and apply the licence rules, then lists the candidates or,
//! with `--pick` or `--all`, picks them (`pickImport`) and waits for the job
//! to commit them. One implementation of licence enforcement, link-only
//! imports, and pinning serves the UI and the CLI alike. The items land in
//! the hosted shelf as commits on its repository; `git pull` brings them into
//! the local one.

use super::hosted::Remote;
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

/// How long to wait for a job, and how often to look.
const POLLS: u32 = 120;
const INTERVAL: Duration = Duration::from_millis(500);

/// What to import, as `startImport` takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub kind: &'static str,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub git_ref: Option<String>,
    pub source_id: Option<String>,
}

impl Source {
    fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("kind".into(), json!(self.kind));
        for (key, value) in [
            ("repo", &self.repo),
            ("url", &self.url),
            ("path", &self.path),
            ("ref", &self.git_ref),
            ("sourceId", &self.source_id),
        ] {
            if let Some(value) = value {
                out.insert(key.into(), json!(value));
            }
        }
        Value::Object(out)
    }
}

/// Read a source argument: a GitHub URL or `owner/repo`, a ClawHub listing,
/// an MCP registry, or another ShelfKit instance. `path` and `git_ref` come
/// from the command's flags and win over what the URL says.
pub fn parse(
    text: &str,
    path: Option<&str>,
    git_ref: Option<&str>,
    source_id: Option<&str>,
) -> Result<Source, String> {
    let mut source = Source {
        kind: "git",
        repo: None,
        url: None,
        path: None,
        git_ref: None,
        source_id: source_id.map(str::to_owned),
    };
    let trimmed = text.trim().trim_end_matches('/');
    let without_scheme = trimmed.strip_prefix("https://");
    match without_scheme {
        Some(rest) if rest.starts_with("github.com/") => {
            let segments: Vec<&str> = rest.split('/').collect();
            let (Some(owner), Some(name)) = (segments.get(1), segments.get(2)) else {
                return Err(format!("`{text}` names no repository"));
            };
            source.repo = Some(format!(
                "https://github.com/{owner}/{}",
                name.trim_end_matches(".git")
            ));
            // `/tree/<ref>/<path>` or `/blob/<ref>/<path>`, as GitHub links read.
            if let (Some(&("tree" | "blob")), Some(found_ref)) = (segments.get(3), segments.get(4))
            {
                source.git_ref = Some((*found_ref).to_owned());
                let rest = segments.get(5..).map(|s| s.join("/")).unwrap_or_default();
                if !rest.is_empty() {
                    source.path = Some(rest);
                }
            }
        }
        Some(rest) if rest.starts_with("clawhub.ai") => {
            source.kind = "catalog";
            source.url = Some("https://clawhub.ai".into());
            // `https://clawhub.ai/<owner>/skills/<slug>`.
            let segments: Vec<&str> = rest.split('/').skip(1).collect();
            if let [owner, "skills", slug] = segments.as_slice() {
                source.path = Some(format!("{owner}/{slug}"));
            }
        }
        Some(rest) if rest.starts_with("registry.modelcontextprotocol.io") => {
            source.kind = "catalog";
            source.url = Some("https://registry.modelcontextprotocol.io".into());
        }
        Some(rest) => {
            // Another ShelfKit instance: `https://<instance>/<shelf>`, or the shelf in `--path`.
            source.kind = "shelfkit";
            let (host, shelf) = rest.split_once('/').unwrap_or((rest, ""));
            source.url = Some(format!("https://{host}"));
            if !shelf.is_empty() {
                source.path = Some(shelf.to_owned());
            }
        }
        None if trimmed.starts_with("http://") => {
            return Err(format!(
                "`{text}` is plain http; sources are read over https"
            ));
        }
        None => {
            let shorthand = trimmed
                .strip_prefix("git@github.com:")
                .or_else(|| trimmed.strip_prefix("github:"))
                .unwrap_or(trimmed);
            let shorthand = shorthand.strip_suffix(".git").unwrap_or(shorthand);
            let segments: Vec<&str> = shorthand.split('/').collect();
            let plain = |segment: &str| {
                !segment.is_empty()
                    && segment
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            };
            match segments.as_slice() {
                [owner, name] if plain(owner) && plain(name) => {
                    source.repo = Some(format!("https://github.com/{owner}/{name}"));
                }
                _ => {
                    return Err(format!(
                        "`{text}` is not a directory or file here, a GitHub repository (`owner/repo` or a URL), a ClawHub listing, an MCP registry, or a ShelfKit instance"
                    ));
                }
            }
        }
    }
    if let Some(path) = path {
        source.path = Some(path.to_owned());
    }
    if let Some(git_ref) = git_ref {
        source.git_ref = Some(git_ref.to_owned());
    }
    Ok(source)
}

/// The hosted shelf a local shelf pushes to: its `registry.namespace`.
pub fn namespace(root: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(root.join("shelf.json"))
        .map_err(|error| format!("{}: {error}", root.join("shelf.json").display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("shelf.json: {error}"))?;
    value
        .pointer("/registry/namespace")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            "shelf.json has no `registry.namespace`, the hosted shelf to import into; set it, and push the shelf to \
             its hosted repository, `<deployment>/git/<namespace>.git`, with git first"
                .to_owned()
        })
}

const JOB_FIELDS: &str = "id status error warnings imported candidates";

/// What `add` did, for the command to print.
pub struct Outcome {
    pub text: String,
    pub failed: bool,
}

/// Start an import, list its candidates, and, given picks, import them.
pub fn run(
    remote: &Remote<'_>,
    shelf: &str,
    source: &Source,
    picks: &[String],
    all: bool,
    wait: &dyn Fn(Duration),
) -> Result<Outcome, String> {
    let started = remote.graphql(
        &format!("mutation($shelf: ID!, $source: JSON!) {{ startImport(shelf: $shelf, source: $source) {{ {JOB_FIELDS} }} }}"),
        json!({ "shelf": shelf, "source": source.to_json() }),
    )?;
    let id = started
        .pointer("/startImport/id")
        .and_then(Value::as_str)
        .ok_or("the deployment started no import job")?
        .to_owned();
    let job = poll(remote, shelf, &id, &["ready", "failed"], wait)?;
    let mut text = String::new();
    write_warnings(&mut text, &job);
    if job["status"] == "failed" {
        let _ = writeln!(
            text,
            "import failed: {}",
            job["error"].as_str().unwrap_or("no reason given")
        );
        return Ok(Outcome { text, failed: true });
    }
    let candidates = job["candidates"].as_array().cloned().unwrap_or_default();
    if picks.is_empty() && !all {
        let _ = writeln!(text, "{} candidate(s) from the source:", candidates.len());
        for candidate in &candidates {
            let link = if candidate["linkOnly"] == true {
                "  link only"
            } else {
                ""
            };
            let _ = writeln!(
                text,
                "  {}  {} {}  ({}){link}",
                candidate["key"].as_str().unwrap_or_default(),
                candidate["kind"].as_str().unwrap_or_default(),
                candidate["id"].as_str().unwrap_or_default(),
                candidate["licenseId"]
                    .as_str()
                    .or_else(|| candidate["license"].as_str())
                    .unwrap_or("no licence stated"),
            );
        }
        let _ = writeln!(
            text,
            "Import them with `--pick <key>` (repeatable) or `--all`."
        );
        return Ok(Outcome {
            text,
            failed: false,
        });
    }
    let keys: Vec<&str> = candidates
        .iter()
        .filter_map(|c| c["key"].as_str())
        .collect();
    let chosen: Vec<Value> = if all {
        keys.iter().map(|key| json!({ "candidate": key })).collect()
    } else {
        for pick in picks {
            if !keys.contains(&pick.as_str()) {
                return Err(format!(
                    "`{pick}` is not one of the source's candidates; run without --pick to list them"
                ));
            }
        }
        picks
            .iter()
            .map(|key| json!({ "candidate": key }))
            .collect()
    };
    remote.graphql(
        &format!("mutation($shelf: ID!, $job: ID!, $picks: JSON!) {{ pickImport(shelf: $shelf, job: $job, picks: $picks) {{ {JOB_FIELDS} }} }}"),
        json!({ "job": id, "picks": chosen, "shelf": shelf }),
    )?;
    let done = poll(remote, shelf, &id, &["done", "failed"], wait)?;
    let mut text = String::new();
    write_warnings(&mut text, &done);
    if done["status"] == "failed" {
        let _ = writeln!(
            text,
            "import failed: {}",
            done["error"].as_str().unwrap_or("no reason given")
        );
        return Ok(Outcome { text, failed: true });
    }
    for imported in done["imported"].as_array().into_iter().flatten() {
        let _ = writeln!(text, "imported {}", imported.as_str().unwrap_or_default());
    }
    let _ = writeln!(
        text,
        "The items are commits on the hosted shelf `{shelf}` ({}/git/{shelf}.git). Run `git pull` in the shelf's \
         repository to bring them into this one.",
        remote.url()
    );
    Ok(Outcome {
        text,
        failed: false,
    })
}

fn write_warnings(text: &mut String, job: &Value) {
    for warning in job["warnings"].as_array().into_iter().flatten() {
        let _ = writeln!(text, "warning: {}", warning.as_str().unwrap_or_default());
    }
}

/// Read the job until its status is one of `until`.
fn poll(
    remote: &Remote<'_>,
    shelf: &str,
    id: &str,
    until: &[&str],
    wait: &dyn Fn(Duration),
) -> Result<Value, String> {
    for attempt in 0..POLLS {
        if attempt > 0 {
            wait(INTERVAL);
        }
        let found = remote.graphql(
            &format!("query($shelf: ID!, $id: ID!) {{ shelf(id: $shelf) {{ importJob(id: $id) {{ {JOB_FIELDS} }} }} }}"),
            json!({ "id": id, "shelf": shelf }),
        )?;
        let job = found
            .pointer("/shelf/importJob")
            .cloned()
            .unwrap_or(Value::Null);
        if job.is_null() {
            return Err(format!("the hosted shelf `{shelf}` has no import job {id}"));
        }
        if until.iter().any(|status| job["status"] == *status) {
            return Ok(job);
        }
    }
    Err(format!(
        "import job {id} did not finish in {} seconds",
        u64::from(POLLS) * 500 / 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_kind_of_source_from_its_url() {
        let git = parse(
            "https://github.com/anthropics/skills/tree/main/skills/pdf",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (
                git.kind,
                git.repo.as_deref(),
                git.git_ref.as_deref(),
                git.path.as_deref()
            ),
            (
                "git",
                Some("https://github.com/anthropics/skills"),
                Some("main"),
                Some("skills/pdf")
            )
        );
        let short = parse(
            "github/awesome-copilot",
            Some("agents/x.agent.md"),
            None,
            Some("copilot"),
        )
        .unwrap();
        assert_eq!(
            short.repo.as_deref(),
            Some("https://github.com/github/awesome-copilot")
        );
        assert_eq!(short.source_id.as_deref(), Some("copilot"));
        let clawhub = parse(
            "https://clawhub.ai/steipete/skills/github",
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (clawhub.kind, clawhub.path.as_deref()),
            ("catalog", Some("steipete/github"))
        );
        let registry = parse(
            "https://registry.modelcontextprotocol.io",
            Some("github"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            (registry.kind, registry.url.as_deref()),
            ("catalog", Some("https://registry.modelcontextprotocol.io"))
        );
        let instance = parse("https://shelf.example/team", None, None, None).unwrap();
        assert_eq!(
            (
                instance.kind,
                instance.url.as_deref(),
                instance.path.as_deref()
            ),
            ("shelfkit", Some("https://shelf.example"), Some("team"))
        );
        assert!(parse("http://insecure.example", None, None, None).is_err());
        assert!(parse("not-a-source", None, None, None).is_err());
        assert_eq!(
            parse("git@github.com:o/r.git", None, None, None)
                .unwrap()
                .repo
                .as_deref(),
            Some("https://github.com/o/r")
        );
        assert!(parse("git@gitlab.com:o/r.git", None, None, None).is_err());
    }
}
