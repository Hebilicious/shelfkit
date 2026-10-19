//! What `compile` writes into a repository, worked out from a view of the
//! repository rather than from the filesystem, so the CLI (which reads the
//! disk) and the WASM engine (which is handed a snapshot by the browser)
//! plan the same output from the same code.
//!
//! `compile` owns two things in the target repository: its `apm.yml`, merged
//! with whatever the repository already declares (see [`crate::merge`]), and
//! the vendored packages it wrote. A package is ShelfKit's only when its
//! `apm.yml` carries the ownership marker ([`OWNER_KEY`]) for the profile
//! being compiled: a `vendor/<name>` without it (Composer's `vendor/`, say)
//! is never written into or deleted from, and the plan wanting that
//! directory is a conflict. Inside an owned package, a file the plan no
//! longer has is removed. Nothing else is touched: no lockfile, no harness
//! directory.
//!
//! No path is written, created, or deleted through a symbolic link: every
//! component below the repository root is looked at without following
//! links, and a link is a refusal that names it.
//!
//! The repository is a [`Repository`]: the CLI's reads the disk
//! (`cli::output`), and [`Snapshot`] is one a host describes in JSON.

use crate::manifest::{CompiledManifest, OWNER_KEY, VENDOR_DIR, VendorFile};
use crate::merge::{MergeError, merge};
use crate::yaml::Node;
use serde::Deserialize;
use shelfkit_core::OnConflict;
use std::collections::{BTreeMap, BTreeSet};

pub const APM_YML: &str = "apm.yml";

/// What is at a path, looked at without following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Link,
    /// Anything else: a socket, a device, a FIFO.
    Other,
}

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The entry's name, or `None` when it is not UTF-8.
    pub name: Option<String>,
    /// What it is, or why that could not be found out.
    pub kind: Result<Kind, String>,
}

/// The parts of a repository `compile` looks at. Paths are relative to the
/// repository root, with `/`.
pub trait Repository {
    /// What is at `relative`, without following a link there; `None` when
    /// nothing is, or when it cannot be found out.
    fn kind(&self, relative: &str) -> Option<Kind>;
    /// The text of the regular file at `relative`, or why it cannot be read.
    fn read(&self, relative: &str) -> Result<String, String>;
    /// The entries of the directory at `relative`, or why it cannot be listed.
    fn list(&self, relative: &str) -> Result<Vec<Entry>, String>;
}

/// The parts of a compile plan that decide what is written.
#[derive(Debug, Clone, Copy)]
pub struct Plan<'a> {
    pub profile: &'a str,
    pub apm_yml: &'a str,
    pub files: &'a [VendorFile],
}

impl<'a> From<&'a CompiledManifest> for Plan<'a> {
    fn from(plan: &'a CompiledManifest) -> Self {
        Self {
            profile: &plan.profile,
            apm_yml: &plan.apm_yml,
            files: &plan.files,
        }
    }
}

/// The repository as `compile` would leave it.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Output {
    /// Every file to write, by path relative to the repository, with `/`.
    pub files: BTreeMap<String, Vec<u8>>,
    /// Files to remove, relative to the repository.
    pub remove: Vec<String>,
    /// Declarations in an existing `apm.yml` that differed, and how
    /// `onConflict` settled them.
    pub conflicts: Vec<String>,
}

/// Why nothing may be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The repository's `apm.yml` is not a manifest; why.
    Unreadable(String),
    /// `onConflict` is `fail`, and these declarations differ.
    Conflicts(Vec<String>),
    /// Paths `compile` may not write or delete, sorted, each with why.
    Refused(Vec<String>),
    /// The plan itself is broken (a vendored file that is not valid base64).
    Plan(String),
}

impl Refusal {
    /// The message the CLI prints: `repo` and `manifest` are how the
    /// repository and its `apm.yml` are named in it.
    pub fn message(&self, repo: &str, manifest: &str) -> String {
        match self {
            Self::Unreadable(why) => format!("{manifest}: cannot read it as a manifest: {why}"),
            Self::Conflicts(conflicts) => format!(
                "{manifest} already declares, differently, what the shelf declares:\n{}\n\
                 onConflict is `fail`, so nothing was written. Decide which side wins with \
                 `--on-conflict shelf-wins` or `--on-conflict local-wins`, or set the \
                 profile's `compile.onConflict`.",
                bullet(conflicts)
            ),
            Self::Refused(refused) => {
                format!("nothing was written to {repo}:\n{}", bullet(refused))
            }
            Self::Plan(why) => why.clone(),
        }
    }
}

/// Work out what compiling `plan` into `repo` writes. An `Err` explains
/// every refusal found; nothing may be written.
pub fn output(
    plan: Plan<'_>,
    repo: &dyn Repository,
    on_conflict: OnConflict,
) -> Result<Output, Refusal> {
    let mut out = Output::default();
    let mut refused: Vec<String> = Vec::new();

    // The packages ShelfKit wrote for this profile, by directory name.
    let owned = owned_packages(repo, plan.profile);

    // Every package directory the plan writes must be absent or ShelfKit's.
    let planned: BTreeSet<&str> = plan
        .files
        .iter()
        .filter_map(|file| file.path.strip_prefix(&format!("{VENDOR_DIR}/")))
        .filter_map(|rest| rest.split('/').next())
        .collect();
    for name in &planned {
        let dir = format!("{VENDOR_DIR}/{name}");
        if repo.kind(&dir).is_some() && !owned.contains(*name) {
            refused.push(format!(
                "{dir} exists and is not a package ShelfKit vendored for profile `{}` (its apm.yml \
                 has no `{OWNER_KEY}: {}`); move it, or compile into another repository",
                plan.profile, plan.profile
            ));
        }
    }

    let manifest = match read_regular(repo, APM_YML) {
        Ok(Some(text)) => {
            let owned_entries: BTreeSet<String> =
                owned.iter().map(|n| format!("{VENDOR_DIR}/{n}")).collect();
            match merge(&text, plan.apm_yml, &owned_entries, on_conflict) {
                Ok(merged) => {
                    out.conflicts = merged.conflicts;
                    merged.text
                }
                Err(MergeError::Unreadable(why)) => return Err(Refusal::Unreadable(why)),
                Err(MergeError::Conflicts(conflicts)) => {
                    return Err(Refusal::Conflicts(conflicts));
                }
            }
        }
        Ok(None) => plan.apm_yml.to_owned(),
        Err(why) => {
            refused.push(why);
            String::new()
        }
    };
    out.files.insert(APM_YML.to_owned(), manifest.into_bytes());

    for file in plan.files {
        out.files
            .insert(file.path.clone(), file.bytes().map_err(Refusal::Plan)?);
    }

    // Stale files: only inside packages carrying this profile's marker.
    for name in &owned {
        match files_under(repo, &format!("{VENDOR_DIR}/{name}")) {
            Ok(paths) => out.remove.extend(
                paths
                    .into_iter()
                    .filter(|path| !out.files.contains_key(path)),
            ),
            Err(why) => refused.push(why),
        }
    }

    for path in out.files.keys().chain(&out.remove) {
        if let Err(why) = no_symlink(repo, path) {
            refused.push(why);
        }
    }
    if refused.is_empty() {
        Ok(out)
    } else {
        refused.sort();
        refused.dedup();
        Err(Refusal::Refused(refused))
    }
}

fn bullet(lines: &[String]) -> String {
    lines
        .iter()
        .map(|line| format!("  - {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Refuse a path any of whose components is a symbolic link: writing,
/// creating, or deleting through it could reach outside the repository.
pub fn no_symlink(repo: &dyn Repository, relative: &str) -> Result<(), String> {
    let mut shown = String::new();
    for component in relative.split('/') {
        if !shown.is_empty() {
            shown.push('/');
        }
        shown.push_str(component);
        match repo.kind(&shown) {
            Some(Kind::Link) => {
                return Err(format!(
                    "{shown} is a symbolic link; ShelfKit never writes, creates, or deletes through one"
                ));
            }
            Some(_) => {}
            // Nothing exists from here down, so nothing below can be a link.
            None => return Ok(()),
        }
    }
    Ok(())
}

/// A file's text when it exists as a regular file, `None` when it does not
/// exist, and an error when it is reached through a link or is not a file.
fn read_regular(repo: &dyn Repository, relative: &str) -> Result<Option<String>, String> {
    no_symlink(repo, relative)?;
    match repo.kind(relative) {
        None => Ok(None),
        Some(Kind::File) => repo.read(relative).map(Some),
        Some(_) => Err(format!("{relative} is not a regular file")),
    }
}

/// The directories under `vendor/` whose `apm.yml` (a regular file, reached
/// through no link) carries the ownership marker for `profile`.
fn owned_packages(repo: &dyn Repository, profile: &str) -> BTreeSet<String> {
    let mut owned = BTreeSet::new();
    if no_symlink(repo, VENDOR_DIR).is_err() {
        return owned;
    }
    let Ok(entries) = repo.list(VENDOR_DIR) else {
        return owned;
    };
    for entry in entries {
        // A linked package is never ours.
        if entry.kind != Ok(Kind::Dir) {
            continue;
        }
        let Some(name) = entry.name else {
            continue;
        };
        let marked = read_regular(repo, &format!("{VENDOR_DIR}/{name}/{APM_YML}"))
            .ok()
            .flatten()
            .and_then(|text| Node::parse(&text).ok())
            .is_some_and(|manifest| {
                manifest.get(OWNER_KEY).and_then(Node::as_str) == Some(profile)
            });
        if marked {
            owned.insert(name);
        }
    }
    owned
}

/// Every file under `dir`, relative to the repository, sorted. A link
/// anywhere inside is refused rather than followed or deleted.
fn files_under(repo: &dyn Repository, dir: &str) -> Result<Vec<String>, String> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_owned()];
    while let Some(current) = stack.pop() {
        for entry in repo.list(&current)? {
            let Some(name) = entry.name else {
                return Err(format!("{current} holds a file name that is not UTF-8"));
            };
            let path = format!("{current}/{name}");
            match entry.kind.map_err(|error| format!("{path}: {error}"))? {
                Kind::Link => {
                    return Err(format!(
                        "{path} is a symbolic link; ShelfKit never writes, creates, or deletes through one"
                    ));
                }
                Kind::Dir => stack.push(path),
                Kind::File | Kind::Other => found.push(path),
            }
        }
    }
    found.sort();
    Ok(found)
}

/// A repository as a host describes it: what the browser can read through
/// the File System Access API, in JSON.
///
/// Only the parts `compile` looks at: the root `apm.yml`, and each entry of
/// `vendor/`. A package's `files` matter only when its `apm.yml` carries the
/// marker for the profile compiled; a host may leave them out for any other.
///
/// The File System Access API shows no symbolic links: it follows them, or
/// does not list them. A browser host therefore cannot see a link and sends
/// no `links`; it is the CLI, reading the disk, that refuses to write
/// through one. A host that can see links (Node) lists each in `links`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    /// The text of the repository's `apm.yml`, when it has one.
    #[serde(default)]
    pub apm_yml: Option<String>,
    /// Every entry of `vendor/`. A plain file there is a package with no
    /// `apm.yml` and no files, which is never ShelfKit's.
    #[serde(default)]
    pub vendor: Vec<SnapshotPackage>,
    /// Every symbolic link the host found at `apm.yml`, `vendor`, or inside
    /// `vendor/`, by path relative to the repository.
    #[serde(default)]
    pub links: Vec<String>,
}

/// One entry of `vendor/` in a [`Snapshot`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotPackage {
    /// The directory's name under `vendor/`.
    pub name: String,
    /// The text of the package's `apm.yml`, when it has one.
    #[serde(default)]
    pub apm_yml: Option<String>,
    /// Every file in the package, relative to the package directory. Its
    /// `apm.yml` is implied by `apmYml`.
    #[serde(default)]
    pub files: Vec<String>,
}

impl Snapshot {
    /// Refuse a snapshot whose paths could name something outside the
    /// repository, or that names a package twice.
    pub fn validate(&self) -> Result<(), String> {
        let mut names = BTreeSet::new();
        for package in &self.vendor {
            if !is_component(&package.name) {
                return Err(format!(
                    "`{}` is not a directory name under vendor/",
                    package.name
                ));
            }
            if !names.insert(package.name.as_str()) {
                return Err(format!("vendor/{} is listed twice", package.name));
            }
            if let Some(file) = package.files.iter().find(|file| !is_relative(file)) {
                return Err(format!(
                    "vendor/{}: `{file}` is not a relative path",
                    package.name
                ));
            }
        }
        if let Some(link) = self.links.iter().find(|link| !is_relative(link)) {
            return Err(format!("links: `{link}` is not a relative path"));
        }
        Ok(())
    }

    fn package(&self, name: &str) -> Option<&SnapshotPackage> {
        self.vendor.iter().find(|package| package.name == name)
    }

    /// Whether `relative` lies under a link, where the snapshot cannot see.
    fn beneath_link(&self, relative: &str) -> bool {
        self.links
            .iter()
            .any(|link| relative.starts_with(&format!("{link}/")))
    }
}

impl SnapshotPackage {
    /// Every file, `apm.yml` included when there is one.
    fn all_files(&self) -> impl Iterator<Item = &str> {
        let manifest = self
            .apm_yml
            .as_ref()
            .filter(|_| !self.files.iter().any(|file| file == APM_YML))
            .map(|_| APM_YML);
        self.files.iter().map(String::as_str).chain(manifest)
    }
}

fn is_component(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

fn is_relative(path: &str) -> bool {
    path.split('/').all(is_component)
}

impl Repository for Snapshot {
    fn kind(&self, relative: &str) -> Option<Kind> {
        if self.links.iter().any(|link| link == relative) {
            return Some(Kind::Link);
        }
        if self.beneath_link(relative) {
            return None;
        }
        if relative == APM_YML {
            return self.apm_yml.as_ref().map(|_| Kind::File);
        }
        if relative == VENDOR_DIR {
            let prefix = format!("{VENDOR_DIR}/");
            let any = !self.vendor.is_empty() || self.links.iter().any(|l| l.starts_with(&prefix));
            return any.then_some(Kind::Dir);
        }
        let rest = relative.strip_prefix(&format!("{VENDOR_DIR}/"))?;
        let (name, inner) = rest.split_once('/').unwrap_or((rest, ""));
        let package = self.package(name)?;
        if inner.is_empty() {
            return Some(Kind::Dir);
        }
        let below = format!("{inner}/");
        let mut kind = None;
        for file in package.all_files() {
            if file == inner {
                return Some(Kind::File);
            }
            if file.starts_with(&below) {
                kind = Some(Kind::Dir);
            }
        }
        kind
    }

    fn read(&self, relative: &str) -> Result<String, String> {
        let text = if relative == APM_YML {
            self.apm_yml.as_ref()
        } else {
            relative
                .strip_prefix(&format!("{VENDOR_DIR}/"))
                .and_then(|rest| rest.strip_suffix(&format!("/{APM_YML}")))
                .and_then(|name| self.package(name))
                .and_then(|package| package.apm_yml.as_ref())
        };
        text.cloned()
            .ok_or_else(|| format!("{relative}: the snapshot has no text for it"))
    }

    fn list(&self, relative: &str) -> Result<Vec<Entry>, String> {
        if self.kind(relative) != Some(Kind::Dir) {
            return Err(format!("{relative}: not a directory in the snapshot"));
        }
        let mut entries: BTreeMap<String, Kind> = BTreeMap::new();
        if relative == VENDOR_DIR {
            for package in &self.vendor {
                entries.insert(package.name.clone(), Kind::Dir);
            }
        } else if let Some(rest) = relative.strip_prefix(&format!("{VENDOR_DIR}/")) {
            let (name, inner) = rest.split_once('/').unwrap_or((rest, ""));
            let prefix = if inner.is_empty() {
                String::new()
            } else {
                format!("{inner}/")
            };
            for file in self
                .package(name)
                .into_iter()
                .flat_map(SnapshotPackage::all_files)
            {
                if let Some(below) = file.strip_prefix(&prefix) {
                    match below.split_once('/') {
                        Some((dir, _)) => entries.insert(dir.to_owned(), Kind::Dir),
                        None => entries.insert(below.to_owned(), Kind::File),
                    };
                }
            }
        }
        let prefix = format!("{relative}/");
        for link in &self.links {
            if let Some(name) = link
                .strip_prefix(&prefix)
                .filter(|name| !name.contains('/'))
            {
                entries.insert(name.to_owned(), Kind::Link);
            }
        }
        Ok(entries
            .into_iter()
            .map(|(name, kind)| Entry {
                name: Some(name),
                kind: Ok(kind),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Encoding;

    fn file(path: &str, contents: &str) -> VendorFile {
        VendorFile {
            path: path.to_owned(),
            contents: contents.to_owned(),
            encoding: Encoding::Utf8,
        }
    }

    const MARKED: &str = "name: p\nx-shelfkit-vendored-for: p\n";

    fn plan_files() -> Vec<VendorFile> {
        vec![
            file("vendor/p/apm.yml", MARKED),
            file("vendor/p/.apm/prompts/hi.prompt.md", "Say hi.\n"),
        ]
    }

    fn run(snapshot: &Snapshot, on_conflict: OnConflict) -> Result<Output, Refusal> {
        let files = plan_files();
        let plan = Plan {
            profile: "p",
            apm_yml: "name: p\ndependencies:\n  apm:\n    - ./vendor/p\n",
            files: &files,
        };
        output(plan, snapshot, on_conflict)
    }

    #[test]
    fn an_empty_repository_gets_the_plan() {
        let out = run(&Snapshot::default(), OnConflict::Fail).unwrap();
        assert_eq!(
            out.files.keys().collect::<Vec<_>>(),
            [
                "apm.yml",
                "vendor/p/.apm/prompts/hi.prompt.md",
                "vendor/p/apm.yml"
            ]
        );
        assert!(out.remove.is_empty());
    }

    #[test]
    fn a_stale_file_in_an_owned_package_is_removed() {
        let snapshot = Snapshot {
            vendor: vec![SnapshotPackage {
                name: "p".to_owned(),
                apm_yml: Some(MARKED.to_owned()),
                files: vec![".apm/prompts/old.prompt.md".to_owned()],
            }],
            ..Snapshot::default()
        };
        let out = run(&snapshot, OnConflict::Fail).unwrap();
        assert_eq!(out.remove, ["vendor/p/.apm/prompts/old.prompt.md"]);
    }

    #[test]
    fn an_unowned_package_is_refused_and_never_removed() {
        let snapshot = Snapshot {
            vendor: vec![SnapshotPackage {
                name: "p".to_owned(),
                apm_yml: None,
                files: vec!["autoload.php".to_owned()],
            }],
            ..Snapshot::default()
        };
        let Err(Refusal::Refused(refused)) = run(&snapshot, OnConflict::Fail) else {
            panic!("not refused");
        };
        assert_eq!(refused.len(), 1);
        assert!(refused[0].starts_with("vendor/p exists and is not a package"));
    }

    #[test]
    fn a_link_is_refused_by_name() {
        let snapshot = Snapshot {
            vendor: vec![SnapshotPackage {
                name: "p".to_owned(),
                apm_yml: Some(MARKED.to_owned()),
                files: Vec::new(),
            }],
            links: vec!["vendor/p/.apm".to_owned()],
            ..Snapshot::default()
        };
        let Err(Refusal::Refused(refused)) = run(&snapshot, OnConflict::Fail) else {
            panic!("not refused");
        };
        assert_eq!(
            refused,
            [
                "vendor/p/.apm is a symbolic link; ShelfKit never writes, creates, or deletes through one"
            ]
        );
    }

    #[test]
    fn a_conflicting_manifest_fails_or_is_settled() {
        let snapshot = Snapshot {
            apm_yml: Some("name: mine\ndependencies:\n  apm:\n    - ./vendor/p#v1\n".to_owned()),
            ..Snapshot::default()
        };
        assert!(matches!(
            run(&snapshot, OnConflict::Fail),
            Err(Refusal::Conflicts(_))
        ));
        let out = run(&snapshot, OnConflict::LocalWins).unwrap();
        assert_eq!(out.conflicts.len(), 1);
    }

    #[test]
    fn a_snapshot_cannot_name_a_path_outside_the_repository() {
        for snapshot in [
            Snapshot {
                vendor: vec![SnapshotPackage {
                    name: "..".to_owned(),
                    ..SnapshotPackage::default()
                }],
                ..Snapshot::default()
            },
            Snapshot {
                links: vec!["/etc".to_owned()],
                ..Snapshot::default()
            },
            Snapshot {
                vendor: vec![SnapshotPackage {
                    name: "p".to_owned(),
                    files: vec!["../x".to_owned()],
                    ..SnapshotPackage::default()
                }],
                ..Snapshot::default()
            },
        ] {
            assert!(snapshot.validate().is_err());
        }
    }
}
