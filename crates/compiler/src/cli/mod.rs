//! The `shelfkit` command line.
//!
//! [`run`] takes the arguments, a [`Context`] (working directory, output
//! streams, and the [`System`] that is the only way to another process), and
//! returns the exit code, so every command is testable in process.
//!
//! Exit codes: 0 success, 1 a failure the output explains (a shelf that does
//! not load, a conflict, a stale `--frozen` check, APM missing), 2 a usage
//! error. `install` exits with APM's own code.

pub mod add;
pub mod add_remote;
pub mod apm;
pub mod doctor;
mod hosted;
mod install;
mod keychain;
mod network;
pub mod output;
pub mod serve;
pub mod system;

use crate::engine::{self, Request};
use crate::manifest::compile;
use crate::recommend::recommend;
use apm::Runner;
use clap::{Args, Parser, Subcommand, ValueEnum};
pub use hosted::{KEY_ENV, URL_ENV, normalize_url};
use output::{APM_YML, Change};
use serde::Serialize;
use shelfkit_core::item::Markers;
use shelfkit_core::{DirSource, Errors, ItemKind, OnConflict, Payload, Shelf, load};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
pub use system::{HostSystem, HttpRequest, HttpResponse, KEYCHAIN_SERVICE, Platform, System};

/// Where a command runs, and what it may reach.
pub struct Context<'a> {
    pub cwd: PathBuf,
    pub stdout: &'a mut dyn Write,
    pub stderr: &'a mut dyn Write,
    pub system: &'a dyn System,
}

#[derive(Parser)]
#[command(
    name = "shelfkit",
    version,
    about = "A shelf of agent context, compiled to APM.",
    long_about = "A shelf of agent context, compiled to APM.\n\n\
        A shelf is a directory of curated items (skills, prompts, instructions, agents, hooks, plugins, \
        MCP and LSP servers, libraries, stacks) and profiles that select them. `compile` turns a profile \
        into an apm.yml plus vendored content and stops; APM installs it. ShelfKit never writes a lockfile \
        and runs APM only when `install` is asked for.\n\n\
        Not in this build: `search`.",
    after_help = "See docs/PRD.md for the specification."
)]
struct Cli {
    /// The shelf: a directory with a shelf.json. Defaults to the nearest one from the current directory up.
    #[arg(long, global = true, value_name = "DIR")]
    shelf: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scaffold a shelf: shelf.json, an empty default profile, and the items/ directory.
    Init(InitArgs),
    /// Import items from a local directory or file, or from a source elsewhere through the hosted service.
    ///
    /// A local directory or file (the `path` source kind) is read here, by APM's package layouts: `.apm/` primitives,
    /// a root SKILL.md, a plugin, `skills/<name>/SKILL.md`, and `hooks/*.json`, or one `.prompt.md`, `.agent.md`, or
    /// `.instructions.md` file. Items are copied into the shelf with no upstream, their `source` naming a `path`
    /// source in shelf.json.
    ///
    /// Anything else (a GitHub repository as a URL or `owner/repo`, a ClawHub listing, an MCP registry, another
    /// ShelfKit instance) is imported by the hosted service's import job, which pins each item, records its licence
    /// and attribution, and imports an unlicensed one as a link without content. Without `--pick` or `--all` the
    /// candidates are listed; with them they are imported into the hosted shelf, and `shelfkit fetch` brings them
    /// here. Needs `shelfkit login`.
    Add(AddArgs),
    /// Remove an item. Refused while a profile, a bundle, or another item references it.
    Rm(RmArgs),
    /// List the shelf's items, or its profiles.
    Ls(LsArgs),
    /// Show one item (its fields, revision, and files) or one profile (its resolution).
    Show(ShowArgs),
    /// Validate the shelf: every file, reference, and pin, and every profile compiled against the OpenAPM schema.
    ///
    /// Reports what does not stop a compile too: targets outside the OpenAPM v0.1 producer set, `lsp` items (absent
    /// from the published schema), hooks that need approval, hosted MCP servers, and MCP entries the schema rejects.
    Check(CheckArgs),
    /// Propose items and profiles from a repository's stack markers.
    ///
    /// Reads the files at the repository's root and the dependencies and packageManager of its package.json.
    Recommend(RecommendArgs),
    /// Write apm.yml and the vendored packages into a repository. Never runs APM.
    ///
    /// The repository's existing apm.yml is kept and the shelf's declarations are merged into it; a declaration it
    /// makes differently is settled by the profile's `onConflict` (or `--on-conflict`). The vendored packages are
    /// `vendor/<profile>/` and `vendor/<profile>--*/`; files in them the plan no longer has are removed.
    Compile(CompileArgs),
    /// Check that a repository's apm.yml and vendored packages still match the profile they came from.
    Verify(VerifyArgs),
    /// Report the APM runner `install` would use, the harnesses a repository has, the shelf's state, and drift.
    ///
    /// Drift: each imported item's upstream is read (GitHub, ClawHub, an MCP registry, another ShelfKit instance, or
    /// an APM registry) and compared with what the item is pinned to; moved and gone items are listed. Nothing is
    /// written. `GITHUB_TOKEN`, when set, is sent to api.github.com only. `--offline` skips the check.
    Doctor(DoctorArgs),
    /// Install a profile from a hosted shelf into a repository, or run `apm install` there.
    ///
    /// With a profile, named `<shelf>/<profile>` as the shelf's Install page shows it, the repository's apm.yml gains
    /// the shelf's registry and a dependency on the profile that follows its newest published version (apm.yml is
    /// created when there is none, and what it already declares is kept); then APM installs it. Without one, APM
    /// installs what apm.yml declares. APM runs through `apm` on PATH or a pinned `uvx`, and the command is printed
    /// first. With neither `apm` nor `uv`, it prints the command that installs uv for this platform.
    ///
    /// A private shelf needs a key that can read it, kept once per computer by `shelfkit login <url>`. ShelfKit hands
    /// it to APM in the environment for each ShelfKit registry apm.yml names, so it is never in a file or a command
    /// line, and never printed. Arguments after `--` are passed to `apm install`.
    Install(InstallArgs),
    /// Serve the shelf as an OpenAPM registry on http://127.0.0.1, in memory, until stopped.
    ///
    /// Every profile is packaged and published as `{registry.namespace}/{profile}` at its `version`, or at
    /// `0.0.0+sha256.<revision>.format<N>` when it has none. The three Registry HTTP API endpoints are served at the root:
    /// `GET /v1/packages/{owner}/{repo}/versions`, `GET .../versions/{version}/download`, and `PUT
    /// .../versions/{version}` (tar.gz as application/gzip only; a version is immutable, so a repeat PUT is 409).
    /// Reads are anonymous when the shelf is public (`registry.public`, or --public / --private). Keys are given as
    /// `SCOPES=KEY`, scopes comma-separated from `read`, `read:{owner}/{repo}`, `publish:{owner}/{repo}`, and
    /// `publish:{owner}/*`, with --key or in SHELFKIT_SERVE_KEYS (whitespace-separated; prefer it, since arguments are
    /// visible to other processes). Keys are never printed or logged. APM 0.33.0 sends no credentials over plain
    /// http, so APM installs only from a public shelf on loopback.
    Serve(ServeArgs),
    /// Keep a key for a hosted deployment in the OS keychain.
    ///
    /// Reads the key from the terminal without echoing it (or a line of standard input), checks it against the
    /// deployment, stores it under the keychain service `shelfkit` with the URL as the account, and remembers the URL
    /// as the default. The key is never printed. `SHELFKIT_KEY`, when set, is used instead of the keychain.
    Login(LoginArgs),
    /// Remove the key kept for a hosted deployment from the OS keychain.
    Logout(LoginArgs),
    /// Open the deployment's web UI in a browser, signed in as the owner.
    ///
    /// Uses the owner key it holds (`SHELFKIT_KEY`, or the keychain) to make a one-time sign-in link, which works once,
    /// within 15 minutes, and opens it with the system's browser opener. A URL with a path, such as
    /// `https://<host>/shelves/<shelf>`, opens that page once signed in. The page then offers to add a passkey on that
    /// device, so it signs in again without a link. Only with `--print` is the link printed instead; when no opener
    /// works, rerun with `--print`. The link is a credential until used, so let nobody else see it. The key is never
    /// printed.
    Open(OpenArgs),
    /// Upload the shelf to a hosted deployment and publish its profiles to its registry.
    ///
    /// Every file is uploaded once by its sha256, the set becomes the hosted shelf's snapshot (the deployment's
    /// engine validates it first), and each profile is packaged exactly as `serve` packages it and published at its
    /// `version`, or `0.0.0+sha256.<revision>.format<N>`. A hosted shelf that was changed there (in the web UI, by an import) is
    /// not overwritten without `--force`.
    Push(PushArgs),
    /// Write a hosted shelf's snapshot into a directory, removing the shelf files it no longer has.
    ///
    /// A local file it would replace or remove whose content the service has never had is work that was never pushed:
    /// the fetch is refused, naming each one, unless `--force`.
    Fetch(FetchArgs),
}

#[derive(Args)]
struct LoginArgs {
    /// The deployment, as https://<host>. Defaults to SHELFKIT_URL, then the one `login` remembered.
    url: Option<String>,
}

#[derive(Args)]
struct OpenArgs {
    /// The deployment, as https://<host>, or a page of it. Defaults to SHELFKIT_URL, then the one `login` remembered.
    url: Option<String>,
    /// Print the link instead of opening it.
    #[arg(long)]
    print: bool,
}

#[derive(Args)]
struct PushArgs {
    /// The deployment. Defaults to SHELFKIT_URL, then the one `login` remembered.
    #[arg(long)]
    url: Option<String>,
    /// A message for the snapshot.
    #[arg(long, short)]
    message: Option<String>,
    /// Upload and commit, but publish no profile.
    #[arg(long)]
    no_publish: bool,
    /// Replace a hosted shelf that has changes made there.
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct FetchArgs {
    /// The deployment. Defaults to SHELFKIT_URL, then the one `login` remembered.
    #[arg(long)]
    url: Option<String>,
    /// The shelf. Defaults to the local shelf.json's `registry.namespace`, then the key's own shelf.
    #[arg(long, value_name = "SHELF")]
    id: Option<String>,
    /// The directory to write into. Defaults to the shelf (`--shelf`, or the nearest shelf.json), else the current
    /// directory.
    #[arg(long, value_name = "DIR")]
    out: Option<PathBuf>,
    /// Replace or remove local files the service has never had (work that was never pushed).
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct InitArgs {
    /// The directory to scaffold. Defaults to the current one.
    dir: Option<PathBuf>,
    /// The shelf's name. Defaults to the directory's name.
    #[arg(long)]
    name: Option<String>,
}

#[derive(Args)]
struct AddArgs {
    /// A local directory or file, or a source URL (`https://github.com/o/r`, `o/r`, a ClawHub listing, an MCP
    /// registry, a ShelfKit instance).
    source: String,
    /// The id of the shelf.json source the items record. For a local directory, defaults to its name.
    #[arg(long, value_name = "ID")]
    source_id: Option<String>,
    /// For a remote source: the path inside it (a directory or file of a repository, a ClawHub `owner/slug`, an
    /// MCP registry server or search term, a ShelfKit shelf).
    #[arg(long, value_name = "PATH")]
    path: Option<String>,
    /// For a Git source: the branch, tag, or commit to read.
    #[arg(long = "ref", value_name = "REF")]
    git_ref: Option<String>,
    /// For a remote source: import this candidate (by the key the listing shows). Repeatable.
    #[arg(long, value_name = "KEY")]
    pick: Vec<String>,
    /// For a remote source: import every candidate.
    #[arg(long, conflicts_with = "pick")]
    all: bool,
    /// For a remote source: the deployment, when it is not the one `login` remembered.
    #[arg(long, value_name = "URL")]
    url: Option<String>,
}

#[derive(Args)]
struct RmArgs {
    /// The item's id.
    item: String,
}

#[derive(Args)]
struct LsArgs {
    /// List profiles instead of items.
    #[arg(long)]
    profiles: bool,
    /// Only items of this kind.
    #[arg(long, value_name = "KIND")]
    kind: Option<String>,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ShowArgs {
    /// An item id or a profile id.
    id: String,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct CheckArgs {
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct RecommendArgs {
    /// The repository to read markers from. Defaults to the current directory.
    #[arg(long, value_name = "DIR")]
    repo: Option<PathBuf>,
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct CompileArgs {
    /// The profile. Defaults to shelf.json's `defaultProfile`.
    profile: Option<String>,
    /// The repository to write into. Defaults to the current directory.
    #[arg(long, value_name = "DIR")]
    repo: Option<PathBuf>,
    /// Write nothing: print the apm.yml (or, with --json, the whole plan).
    #[arg(long, conflicts_with = "frozen")]
    dry_run: bool,
    /// Write nothing, and fail when the repository differs from what compile would write. For CI.
    #[arg(long)]
    frozen: bool,
    /// Print the plan as JSON: the same object the MCP `shelf.compile.plan` tool and the composer preview use.
    #[arg(long)]
    json: bool,
    /// Compile for these APM target slugs instead of the profile's, comma-separated.
    #[arg(long, value_delimiter = ',', value_name = "SLUGS")]
    targets: Option<Vec<String>>,
    /// Opt into targets outside the OpenAPM v0.1 producer set for this compile.
    #[arg(long)]
    allow_nonconformant_targets: bool,
    /// Settle declarations the repository's apm.yml makes differently, instead of the profile's `onConflict`.
    #[arg(long, value_enum, value_name = "POLICY")]
    on_conflict: Option<ConflictPolicy>,
}

#[derive(Args)]
struct VerifyArgs {
    /// The profile. Defaults to shelf.json's `defaultProfile`.
    profile: Option<String>,
    /// The repository to check. Defaults to the current directory.
    #[arg(long, value_name = "DIR")]
    repo: Option<PathBuf>,
}

#[derive(Args)]
struct DoctorArgs {
    /// The repository to inspect. Defaults to the current directory.
    #[arg(long, value_name = "DIR")]
    repo: Option<PathBuf>,
    /// Do not read upstream: skip the drift check.
    #[arg(long)]
    offline: bool,
}

#[derive(Args)]
struct InstallArgs {
    /// The profile to add, as `<shelf>/<profile>`. Without it, APM installs what apm.yml already declares.
    profile: Option<String>,
    /// The deployment the profile is on, as https://<host>. Defaults to SHELFKIT_URL, then the one `login` remembered.
    #[arg(long)]
    url: Option<String>,
    /// The repository to install into. Defaults to the current directory.
    #[arg(long, value_name = "DIR")]
    repo: Option<PathBuf>,
    /// Passed to `apm install`.
    #[arg(last = true)]
    apm_args: Vec<String>,
}

#[derive(Args)]
struct ServeArgs {
    /// The loopback port; 0 picks a free one.
    #[arg(long, default_value_t = 7878)]
    port: u16,
    /// Serve anonymous reads, whatever shelf.json's `registry.public` says.
    #[arg(long, conflicts_with = "private")]
    public: bool,
    /// Require a key for every read, whatever shelf.json's `registry.public` says.
    #[arg(long)]
    private: bool,
    /// A key, as `SCOPES=KEY`. Repeatable. Prefer SHELFKIT_SERVE_KEYS.
    #[arg(long = "key", value_name = "SCOPES=KEY")]
    keys: Vec<String>,
    /// Seconds a client has to send a whole request; a slower one gets 408.
    #[arg(long, default_value_t = 30, value_name = "SECONDS", value_parser = clap::value_parser!(u64).range(1..))]
    request_timeout: u64,
    /// Connections served at once; one more gets 503.
    #[arg(long, default_value_t = 64, value_name = "N", value_parser = clap::value_parser!(u64).range(1..))]
    max_connections: u64,
}

#[derive(Clone, Copy, ValueEnum)]
enum ConflictPolicy {
    Fail,
    ShelfWins,
    LocalWins,
}

impl From<ConflictPolicy> for OnConflict {
    fn from(policy: ConflictPolicy) -> Self {
        match policy {
            ConflictPolicy::Fail => Self::Fail,
            ConflictPolicy::ShelfWins => Self::ShelfWins,
            ConflictPolicy::LocalWins => Self::LocalWins,
        }
    }
}

/// A failure the command has explained, or will explain with this message.
enum Failure {
    Message(String),
    Errors(Errors),
    /// Already reported.
    Reported,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<Errors> for Failure {
    fn from(errors: Errors) -> Self {
        Self::Errors(errors)
    }
}

type Outcome = Result<(), Failure>;

/// Run the command line and return the exit code.
pub fn run<I, T>(args: I, ctx: &mut Context<'_>) -> u8
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => {
            let text = error.render().to_string();
            let code = u8::try_from(error.exit_code()).unwrap_or(2);
            let stream: &mut dyn Write = if code == 0 { ctx.stdout } else { ctx.stderr };
            let _ = write!(stream, "{text}");
            return code;
        }
    };
    let shelf = cli.shelf.clone();
    let outcome = match cli.command {
        Command::Init(args) => init(ctx, args),
        Command::Add(args) => add(ctx, shelf, &args),
        Command::Rm(args) => rm(ctx, shelf, &args),
        Command::Ls(args) => ls(ctx, shelf, &args),
        Command::Show(args) => show(ctx, shelf, &args),
        Command::Check(args) => check(ctx, shelf, &args),
        Command::Recommend(args) => recommend_command(ctx, shelf, &args),
        Command::Compile(args) => compile_command(ctx, shelf, &args),
        Command::Verify(args) => verify(ctx, shelf, &args),
        Command::Doctor(args) => doctor(ctx, shelf, &args),
        Command::Install(args) => {
            return install::install(
                ctx,
                &install::InstallRequest {
                    apm_args: &args.apm_args,
                    profile: args.profile.as_deref(),
                    repo: args.repo.as_deref(),
                    url: args.url.as_deref(),
                },
            );
        }
        Command::Serve(args) => serve_command(ctx, shelf, &args),
        Command::Login(args) => hosted::login(ctx, args.url.as_deref()),
        Command::Logout(args) => hosted::logout(ctx, args.url.as_deref()),
        Command::Open(args) => hosted::open(ctx, args.url.as_deref(), args.print),
        Command::Push(args) => push_command(ctx, shelf, &args),
        Command::Fetch(args) => hosted::fetch(
            ctx,
            shelf,
            &hosted::FetchOptions {
                force: args.force,
                id: args.id.as_deref(),
                out: args.out.as_deref(),
                url: args.url.as_deref(),
            },
        ),
    };
    match outcome {
        Ok(()) => 0,
        Err(Failure::Message(message)) => {
            let _ = writeln!(ctx.stderr, "shelfkit: {message}");
            1
        }
        Err(Failure::Errors(errors)) => {
            let _ = writeln!(ctx.stderr, "{errors}");
            let _ = writeln!(ctx.stderr, "shelfkit: {} error(s)", errors.len());
            1
        }
        Err(Failure::Reported) => 1,
    }
}

fn push_command(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &PushArgs) -> Outcome {
    let root = shelf_root(ctx, shelf)?;
    hosted::push(
        ctx,
        &root,
        &hosted::PushOptions {
            force: args.force,
            message: args.message.as_deref(),
            publish: !args.no_publish,
            url: args.url.as_deref(),
        },
    )
}

fn absolute(ctx: &Context<'_>, path: Option<&Path>) -> PathBuf {
    match path {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(path) => ctx.cwd.join(path),
        None => ctx.cwd.clone(),
    }
}

/// The shelf root: `--shelf`, or the nearest directory with a shelf.json.
fn shelf_root(ctx: &Context<'_>, shelf: Option<PathBuf>) -> Result<PathBuf, Failure> {
    if let Some(dir) = shelf {
        let dir = absolute(ctx, Some(&dir));
        return if dir.join("shelf.json").is_file() {
            Ok(dir)
        } else {
            Err(format!("{} has no shelf.json", dir.display()).into())
        };
    }
    ctx.cwd
        .ancestors()
        .find(|dir| dir.join("shelf.json").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            "no shelf.json here or above; pass `--shelf <dir>`, or run `shelfkit init`"
                .to_owned()
                .into()
        })
}

fn load_shelf(ctx: &Context<'_>, shelf: Option<PathBuf>) -> Result<(PathBuf, Shelf), Failure> {
    let root = shelf_root(ctx, shelf)?;
    let loaded = load(&DirSource::new(&root))?;
    Ok((root, loaded))
}

fn print_json<T: Serialize>(ctx: &mut Context<'_>, value: &T) -> Outcome {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let _ = writeln!(ctx.stdout, "{text}");
    Ok(())
}

fn init(ctx: &mut Context<'_>, args: InitArgs) -> Outcome {
    let dir = absolute(ctx, args.dir.as_deref());
    if dir.join("shelf.json").exists() {
        return Err(format!("{} already has a shelf.json", dir.display()).into());
    }
    let name = args.name.unwrap_or_else(|| {
        dir.file_name()
            .map_or_else(|| "shelf".to_owned(), |n| n.to_string_lossy().into_owned())
    });
    let shelf = serde_json::json!({
        "$schema": "https://shelfkit.dev/schemas/shelf.json",
        "name": name,
        "defaultProfile": "default",
        "sources": [],
    });
    let profile = serde_json::json!({
        "$schema": "https://shelfkit.dev/schemas/profile.json",
        "id": "default",
        "title": "Default",
        "items": [],
    });
    let files = [
        ("shelf.json", pretty(&shelf)),
        ("profiles/default.json", pretty(&profile)),
        ("items/.gitkeep", String::new()),
    ];
    for (path, text) in files {
        let target = dir.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        std::fs::write(&target, text).map_err(|error| format!("{}: {error}", target.display()))?;
    }
    load(&DirSource::new(&dir))?;
    let _ = writeln!(
        ctx.stdout,
        "Scaffolded a shelf in {}.\nAdd items with `shelfkit add <dir>`, select them in profiles/default.json, \
         then `shelfkit compile --dry-run`.",
        dir.display()
    );
    Ok(())
}

fn pretty(value: &serde_json::Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

fn add(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &AddArgs) -> Outcome {
    let root = shelf_root(ctx, shelf)?;
    let target = absolute(ctx, Some(Path::new(&args.source)));
    if !target.exists() {
        return add_from_source(ctx, &root, args);
    }
    let import = add::import(&root, &target, args.source_id.as_deref())?;
    for (path, bytes) in &import.files {
        let file = root.join(path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        std::fs::write(&file, bytes).map_err(|error| format!("{}: {error}", file.display()))?;
    }
    for (kind, id) in &import.items {
        let _ = writeln!(ctx.stdout, "added {kind} {id}");
    }
    let _ = writeln!(ctx.stdout, "Select them in a profile to compile them.");
    Ok(())
}

/// `add` for a source that is not on this machine, through the hosted import job.
fn add_from_source(ctx: &mut Context<'_>, root: &Path, args: &AddArgs) -> Outcome {
    let source = add_remote::parse(
        &args.source,
        args.path.as_deref(),
        args.git_ref.as_deref(),
        args.source_id.as_deref(),
    )?;
    let shelf = add_remote::namespace(root)?;
    let remote = hosted::Remote::connect(ctx.system, args.url.as_deref())?;
    let outcome = add_remote::run(
        &remote,
        &shelf,
        &source,
        &args.pick,
        args.all,
        &std::thread::sleep,
    )?;
    let _ = write!(ctx.stdout, "{}", outcome.text);
    if outcome.failed {
        return Err("the import failed; see above".to_owned().into());
    }
    Ok(())
}

fn rm(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &RmArgs) -> Outcome {
    let (root, shelf) = load_shelf(ctx, shelf)?;
    let id = &args.item;
    let Some(loaded) = shelf.items.get(id) else {
        return Err(format!("no item `{id}`").into());
    };
    let mut users = Vec::new();
    for profile in shelf.profiles.values() {
        if profile.items.iter().any(|r| &r.id == id) {
            users.push(format!(
                "profile `{}` (profiles/{}.json)",
                profile.id, profile.id
            ));
        }
    }
    for bundle in shelf.bundles.values() {
        if bundle.items.iter().any(|r| &r.id == id) {
            users.push(format!(
                "bundle `{}` (bundles/{}.json)",
                bundle.id, bundle.id
            ));
        }
    }
    for other in shelf.items.values() {
        let recommends = match &other.item.payload {
            Payload::Stack(stack) => stack.recommends.contains(id),
            _ => false,
        };
        if other.item.requires.contains(id) || recommends {
            users.push(format!("item `{}` ({})", other.item.id, other.item_json()));
        }
    }
    if !users.is_empty() {
        return Err(format!(
            "`{id}` is still referenced by:\n{}\nremove those references first",
            users
                .iter()
                .map(|u| format!("  - {u}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
        .into());
    }
    let dir = root.join(&loaded.path);
    std::fs::remove_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let _ = writeln!(
        ctx.stdout,
        "removed {} {id} ({})",
        loaded.kind(),
        loaded.path
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemRow<'a> {
    id: &'a str,
    kind: ItemKind,
    title: &'a str,
    description: &'a str,
    revision: &'a shelfkit_core::Revision,
    tags: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRow<'a> {
    id: &'a str,
    title: &'a str,
    description: &'a str,
    revision: Option<shelfkit_core::Revision>,
    items: usize,
}

fn ls(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &LsArgs) -> Outcome {
    let (_, shelf) = load_shelf(ctx, shelf)?;
    if args.profiles {
        let rows: Vec<ProfileRow<'_>> = shelf
            .profiles
            .values()
            .map(|profile| {
                let resolved = shelf.resolve(&profile.id).ok();
                ProfileRow {
                    id: &profile.id,
                    title: &profile.title,
                    description: &profile.description,
                    items: resolved.as_ref().map_or(0, |r| r.items.len()),
                    revision: resolved.map(|r| r.revision),
                }
            })
            .collect();
        if args.json {
            return print_json(ctx, &rows);
        }
        for row in rows {
            let _ = writeln!(
                ctx.stdout,
                "{:<24} {:>3} items  {}",
                row.id, row.items, row.title
            );
        }
        return Ok(());
    }
    let kind = match &args.kind {
        Some(kind) => Some(
            ItemKind::ALL
                .into_iter()
                .find(|k| k.as_str() == kind)
                .ok_or_else(|| format!("unknown kind `{kind}`"))?,
        ),
        None => None,
    };
    let rows: Vec<ItemRow<'_>> = shelf
        .items
        .values()
        .filter(|loaded| kind.is_none_or(|k| loaded.kind() == k))
        .map(|loaded| ItemRow {
            id: &loaded.item.id,
            kind: loaded.kind(),
            title: &loaded.item.title,
            description: &loaded.item.description,
            revision: &loaded.revision,
            tags: &loaded.item.tags,
        })
        .collect();
    if args.json {
        return print_json(ctx, &rows);
    }
    for row in rows {
        let _ = writeln!(
            ctx.stdout,
            "{:<13} {:<32} {}",
            row.kind.as_str(),
            row.id,
            row.title
        );
    }
    Ok(())
}

fn show(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &ShowArgs) -> Outcome {
    let (_, shelf) = load_shelf(ctx, shelf)?;
    if let Some(loaded) = shelf.items.get(&args.id) {
        let files: Vec<&String> = loaded.files.keys().collect();
        if args.json {
            return print_json(
                ctx,
                &serde_json::json!({
                    "item": loaded.item,
                    "path": loaded.path,
                    "revision": loaded.revision,
                    "files": files,
                }),
            );
        }
        let item = &loaded.item;
        let _ = writeln!(ctx.stdout, "{} {} ({})", item.kind(), item.id, loaded.path);
        let _ = writeln!(ctx.stdout, "title     {}", item.title);
        if !item.description.is_empty() {
            let _ = writeln!(ctx.stdout, "about     {}", item.description);
        }
        let _ = writeln!(ctx.stdout, "revision  {}", loaded.revision);
        if !item.tags.is_empty() {
            let _ = writeln!(ctx.stdout, "tags      {}", item.tags.join(", "));
        }
        if !item.targets.is_empty() {
            let _ = writeln!(ctx.stdout, "targets   {}", item.targets.join(", "));
        }
        if let Some(source) = &item.source {
            let upstream = source
                .repo
                .as_deref()
                .or(source.url.as_deref())
                .unwrap_or("local");
            let _ = writeln!(
                ctx.stdout,
                "source    {upstream}{}",
                source
                    .path
                    .as_deref()
                    .map(|p| format!(" {p}"))
                    .unwrap_or_default()
            );
        }
        let _ = writeln!(
            ctx.stdout,
            "files     {}",
            files
                .iter()
                .map(|f| f.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        return Ok(());
    }
    let Some(profile) = shelf.profiles.get(&args.id) else {
        return Err(format!("no item or profile `{}`", args.id).into());
    };
    let resolved = shelf.resolve(&args.id)?;
    if args.json {
        return print_json(
            ctx,
            &serde_json::json!({ "profile": profile, "resolution": resolved }),
        );
    }
    let _ = writeln!(ctx.stdout, "profile {} ({})", profile.id, resolved.path);
    let _ = writeln!(ctx.stdout, "title     {}", profile.title);
    let _ = writeln!(ctx.stdout, "revision  {}", resolved.revision);
    let _ = writeln!(
        ctx.stdout,
        "compiles  {} for {}",
        resolved.compile.name,
        if resolved.compile.targets.is_empty() {
            "the targets APM detects".to_owned()
        } else {
            resolved.compile.targets.join(", ")
        }
    );
    for item in &resolved.items {
        let pin = if item.pinned { "pinned" } else { "unpinned" };
        let _ = writeln!(
            ctx.stdout,
            "  {:<13} {:<32} {pin} via {}",
            item.kind.as_str(),
            item.id,
            item.origin.declared_in()
        );
    }
    for notice in &resolved.notices {
        let _ = writeln!(ctx.stdout, "note: {notice}");
    }
    Ok(())
}

#[derive(Serialize)]
struct CheckReport {
    errors: Vec<ErrorRow>,
    notes: Vec<crate::Note>,
}

#[derive(Serialize)]
struct ErrorRow {
    path: String,
    message: String,
}

fn check(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &CheckArgs) -> Outcome {
    let root = shelf_root(ctx, shelf)?;
    let mut report = CheckReport {
        errors: Vec::new(),
        notes: Vec::new(),
    };
    let mut summary = String::new();
    match load(&DirSource::new(&root)) {
        Err(errors) => {
            report.errors.extend(errors.into_iter().map(|e| ErrorRow {
                path: e.path,
                message: e.kind.to_string(),
            }));
        }
        Ok(shelf) => {
            report
                .notes
                .extend(shelf.check().into_iter().map(|notice| crate::Note {
                    path: notice.path,
                    code: notice.code.into(),
                    message: notice.message,
                }));
            for id in shelf.profiles.keys() {
                let compiled = shelf
                    .resolve(id)
                    .and_then(|resolved| compile(&shelf, &resolved));
                match compiled {
                    Ok(plan) => report.notes.extend(plan.notes),
                    Err(errors) => report.errors.extend(errors.into_iter().map(|e| ErrorRow {
                        path: e.path,
                        message: e.kind.to_string(),
                    })),
                }
            }
            summary = format!(
                "{} items, {} profiles",
                shelf.items.len(),
                shelf.profiles.len()
            );
        }
    }
    report.notes.sort();
    report.notes.dedup();
    let failed = !report.errors.is_empty();
    if args.json {
        print_json(ctx, &report)?;
    } else {
        for error in &report.errors {
            let _ = writeln!(ctx.stderr, "{}: {}", error.path, error.message);
        }
        for note in &report.notes {
            let code = serde_json::to_value(note.code)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let _ = writeln!(ctx.stdout, "{}: [{code}] {}", note.path, note.message);
        }
        if failed {
            let _ = writeln!(ctx.stderr, "shelfkit: {} error(s)", report.errors.len());
        } else {
            let _ = writeln!(
                ctx.stdout,
                "ok: {summary}, every profile compiles to a manifest that validates"
            );
        }
    }
    if failed {
        Err(Failure::Reported)
    } else {
        Ok(())
    }
}

/// What a repository shows: the files at its root, and its package.json.
fn repository_markers(repo: &Path) -> Markers {
    let mut files: Vec<String> = std::fs::read_dir(repo)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut markers = Markers {
        files,
        ..Markers::default()
    };
    if let Ok(bytes) = std::fs::read(repo.join("package.json"))
        && let Ok(package) = serde_json::from_slice::<serde_json::Value>(&bytes)
    {
        for key in [
            "dependencies",
            "devDependencies",
            "peerDependencies",
            "optionalDependencies",
        ] {
            if let Some(map) = package.get(key).and_then(serde_json::Value::as_object) {
                markers.dependencies.extend(map.keys().cloned());
            }
        }
        markers.dependencies.sort();
        markers.dependencies.dedup();
        markers.package_manager = package
            .get("packageManager")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
    }
    markers
}

fn recommend_command(
    ctx: &mut Context<'_>,
    shelf: Option<PathBuf>,
    args: &RecommendArgs,
) -> Outcome {
    let (_, shelf) = load_shelf(ctx, shelf)?;
    let repo = absolute(ctx, args.repo.as_deref());
    let found = recommend(&shelf, &repository_markers(&repo));
    if args.json {
        return print_json(ctx, &found);
    }
    if found.items.is_empty() {
        let _ = writeln!(
            ctx.stdout,
            "Nothing on the shelf matches {}.",
            repo.display()
        );
        return Ok(());
    }
    for item in &found.items {
        let mut why: Vec<String> = item
            .matched
            .files
            .iter()
            .map(|f| format!("file {f}"))
            .collect();
        why.extend(
            item.matched
                .dependencies
                .iter()
                .map(|d| format!("dependency {d}")),
        );
        why.extend(
            item.matched
                .package_manager
                .iter()
                .map(|m| format!("uses {m}")),
        );
        why.extend(
            item.recommended_by
                .iter()
                .map(|s| format!("recommended by {s}")),
        );
        let _ = writeln!(
            ctx.stdout,
            "{:<13} {:<32} {}",
            item.kind.as_str(),
            item.id,
            why.join(", ")
        );
    }
    for profile in &found.profiles {
        let _ = writeln!(
            ctx.stdout,
            "profile {:<24} selects {}",
            profile.id,
            profile.items.join(", ")
        );
    }
    Ok(())
}

fn plan_for(
    ctx: &Context<'_>,
    shelf: Option<PathBuf>,
    request: &Request,
) -> Result<(PathBuf, crate::CompiledManifest, OnConflict), Failure> {
    let root = shelf_root(ctx, shelf)?;
    let source = DirSource::new(&root);
    let plan = engine::plan(&source, request)?;
    // The profile's own onConflict, after `extends`.
    let shelf = load(&DirSource::new(&root))?;
    let on_conflict = shelf
        .resolve(&plan.profile)
        .map(|r| r.compile.on_conflict)
        .unwrap_or_default();
    Ok((root, plan, on_conflict))
}

fn print_notes(ctx: &mut Context<'_>, plan: &crate::CompiledManifest) {
    for note in &plan.notes {
        let _ = writeln!(ctx.stderr, "note: {}: {}", note.path, note.message);
    }
}

fn compile_command(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &CompileArgs) -> Outcome {
    let request = Request {
        profile: args.profile.clone(),
        override_profile: None,
        targets: args.targets.clone(),
        allow_nonconformant_targets: args.allow_nonconformant_targets,
    };
    let (_, plan, profile_policy) = plan_for(ctx, shelf, &request)?;
    if args.dry_run {
        if args.json {
            let _ = write!(ctx.stdout, "{}", plan.to_json());
        } else {
            let _ = write!(ctx.stdout, "{}", plan.apm_yml);
            for file in &plan.files {
                let _ = writeln!(ctx.stderr, "would vendor {}", file.path);
            }
            print_notes(ctx, &plan);
            let _ = writeln!(ctx.stderr, "then: {}", next_steps(&plan));
        }
        return Ok(());
    }

    let repo = absolute(ctx, args.repo.as_deref());
    let on_conflict = args.on_conflict.map_or(profile_policy, OnConflict::from);
    let out = output::output(&plan, &repo, on_conflict)?;
    let changes = output::changes(&out, &repo);
    if args.frozen {
        if changes.is_empty() {
            let _ = writeln!(
                ctx.stderr,
                "{} is up to date with profile `{}`",
                repo.display(),
                plan.profile
            );
            return Ok(());
        }
        for change in &changes {
            let _ = writeln!(ctx.stderr, "would {change}");
        }
        return Err(format!(
            "{} is not what `shelfkit compile {}` writes ({} change(s)); --frozen wrote nothing",
            repo.display(),
            plan.profile,
            changes.len()
        )
        .into());
    }
    output::apply(&out, &changes, &repo)?;
    for conflict in &out.conflicts {
        let winner = if on_conflict == OnConflict::ShelfWins {
            "the shelf's"
        } else {
            "the repository's"
        };
        let _ = writeln!(ctx.stderr, "conflict: {conflict}: kept {winner}");
    }
    if args.json {
        let _ = write!(ctx.stdout, "{}", plan.to_json());
    } else {
        for change in &changes {
            let _ = writeln!(ctx.stdout, "{change}");
        }
        if changes.is_empty() {
            let _ = writeln!(ctx.stdout, "{} is already up to date", repo.display());
        }
    }
    print_notes(ctx, &plan);
    let _ = writeln!(ctx.stderr, "next: {}", next_steps(&plan));
    Ok(())
}

/// What to run after compiling: `shelfkit install`, which also turns on APM's registry flag where apm.yml needs it
/// and writes the instructions into AGENTS.md. With APM alone, each of those is a step of its own.
fn next_steps(plan: &crate::CompiledManifest) -> String {
    let mut steps = Vec::new();
    if declares_registries(&plan.apm_yml) {
        steps.push("`apm experimental enable registries` once per computer (APM 0.33.0 reads registries only behind that flag)".to_owned());
    }
    steps.push("`apm install`".to_owned());
    if plan.apm_yml.contains("managed_section") {
        let (start, end) = crate::manifest::AGENTS_MD_MARKERS;
        steps.push(format!(
            "`apm compile --target codex`, with `{start}` and `{end}` in AGENTS.md, and `@AGENTS.md` in CLAUDE.md"
        ));
    }
    format!(
        "`shelfkit install`, or with APM alone: {}",
        steps.join(", then ")
    )
}

fn declares_registries(apm_yml: &str) -> bool {
    crate::yaml::Node::parse(apm_yml)
        .ok()
        .and_then(|manifest| manifest.get("registries").cloned())
        .is_some_and(|registries| !matches!(registries, crate::yaml::Node::Null))
}

fn verify(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &VerifyArgs) -> Outcome {
    let request = Request {
        profile: args.profile.clone(),
        ..Request::default()
    };
    let (_, plan, on_conflict) = plan_for(ctx, shelf, &request)?;
    let repo = absolute(ctx, args.repo.as_deref());
    if !repo.join(APM_YML).is_file() {
        return Err(format!(
            "{} has no apm.yml; run `shelfkit compile` first",
            repo.display()
        )
        .into());
    }
    let out = output::output(&plan, &repo, on_conflict)?;
    let changes = output::changes(&out, &repo);
    if changes.is_empty() {
        let _ = writeln!(
            ctx.stdout,
            "{} matches profile `{}` at {}",
            repo.display(),
            plan.profile,
            plan.profile_revision
        );
        return Ok(());
    }
    for change in &changes {
        let what = match change {
            Change::Create(path) => format!("{path} is missing"),
            Change::Update(path) => format!("{path} differs from the profile"),
            Change::Remove(path) => format!("{path} is no longer in the profile"),
        };
        let _ = writeln!(ctx.stderr, "{what}");
    }
    Err(format!(
        "{} does not match profile `{}`; run `shelfkit compile {}` to update it",
        repo.display(),
        plan.profile,
        plan.profile
    )
    .into())
}

/// Files and directories whose presence says a harness is in use.
pub(super) const HARNESS_SIGNALS: &[(&str, &[&str])] = &[
    ("claude", &["CLAUDE.md", ".claude"]),
    (
        "copilot",
        &[
            ".github/copilot-instructions.md",
            ".github/prompts",
            ".github/agents",
        ],
    ),
    ("cursor", &[".cursor", ".cursorrules"]),
    ("codex", &[".codex"]),
    ("gemini", &["GEMINI.md", ".gemini"]),
    ("opencode", &[".opencode", "opencode.json"]),
    ("windsurf", &[".windsurf"]),
    ("kiro", &[".kiro"]),
    ("agents-md", &["AGENTS.md"]),
];

fn doctor(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &DoctorArgs) -> Outcome {
    let repo = absolute(ctx, args.repo.as_deref());
    let _ = writeln!(ctx.stdout, "repository  {}", repo.display());

    let mut loaded = None;
    match shelf_root(ctx, shelf) {
        Ok(root) => match load(&DirSource::new(&root)) {
            Ok(shelf) => {
                let _ = writeln!(
                    ctx.stdout,
                    "shelf       {} ({} items, {} profiles; `shelfkit check` for notes)",
                    root.display(),
                    shelf.items.len(),
                    shelf.profiles.len()
                );
                loaded = Some(shelf);
            }
            Err(errors) => {
                let _ = writeln!(
                    ctx.stdout,
                    "shelf       {} does not load: {} error(s), see `shelfkit check`",
                    root.display(),
                    errors.len()
                );
            }
        },
        Err(_) => {
            let _ = writeln!(ctx.stdout, "shelf       none found; pass `--shelf <dir>`");
        }
    }

    let runner = Runner::resolve(ctx.system);
    let range = apm::supported_range();
    match &runner {
        Runner::Path { apm, version } => {
            let status = match (version, runner.supported()) {
                (Some(v), Some(true)) => format!("{v}, in the supported range {range}"),
                (Some(v), _) => format!(
                    "{v}, OUTSIDE the supported range {range}: it is used, with this warning"
                ),
                (None, _) => format!("version unknown; the supported range is {range}"),
            };
            let _ = writeln!(ctx.stdout, "apm         {} ({status})", apm.display());
        }
        Runner::Uvx { uvx } => {
            let _ = writeln!(
                ctx.stdout,
                "apm         not on PATH; `install` runs `uvx --from apm-cli=={} apm` ({})",
                apm::APM_PIN,
                uvx.display()
            );
        }
        Runner::Missing => {
            let _ = writeln!(
                ctx.stdout,
                "apm         not on PATH, and no uvx to run it. Install uv:\n            {}",
                apm::install_uv_command(ctx.system.platform())
            );
        }
    }

    let harnesses: Vec<String> = HARNESS_SIGNALS
        .iter()
        .filter_map(|(name, signals)| {
            let found: Vec<&str> = signals
                .iter()
                .copied()
                .filter(|s| repo.join(s).exists())
                .collect();
            (!found.is_empty()).then(|| format!("{name} ({})", found.join(", ")))
        })
        .collect();
    let _ = writeln!(
        ctx.stdout,
        "harnesses   {}",
        if harnesses.is_empty() {
            "none detected".to_owned()
        } else {
            harnesses.join("; ")
        }
    );
    match (&loaded, args.offline) {
        (Some(shelf), false) => {
            let drifts = doctor::check(ctx.system, shelf);
            let _ = write!(ctx.stdout, "{}", doctor::report(&drifts));
        }
        (Some(_), true) => {
            let _ = writeln!(ctx.stdout, "drift       not checked (--offline)");
        }
        (None, _) => {
            let _ = writeln!(ctx.stdout, "drift       not checked: no shelf loaded");
        }
    }
    Ok(())
}

fn serve_command(ctx: &mut Context<'_>, shelf: Option<PathBuf>, args: &ServeArgs) -> Outcome {
    use shelfkit_registry::PackageId;
    use shelfkit_registry::host::{MemoryKeys, MemoryStore, Registry};
    use std::sync::{Arc, Mutex};

    let (_, loaded) = load_shelf(ctx, shelf)?;
    let Some(settings) = &loaded.manifest.registry else {
        return Err(
            "shelf.json has no `registry`: set `registry.namespace`, the `{owner}` its profiles \
                    publish under, and `registry.public` for anonymous reads"
                .to_owned()
                .into(),
        );
    };
    let namespace = settings.namespace.clone();
    let public = if args.public {
        true
    } else if args.private {
        false
    } else {
        settings.public
    };

    let mut keys = MemoryKeys::new();
    let from_env = std::env::var(serve::KEYS_ENV).unwrap_or_default();
    for (index, entry) in args
        .keys
        .iter()
        .map(String::as_str)
        .chain(from_env.split_whitespace())
        .enumerate()
    {
        let (key, scopes) =
            serve::parse_key(entry).map_err(|error| format!("key {}: {error}", index + 1))?;
        keys.add(&key, scopes);
    }
    let key_count = keys.len();
    let mut store = MemoryStore::new();
    store.add_shelf(&namespace, public);
    let mut registry = Registry::new(store, keys);

    let listener = serve::bind(args.port)
        .map_err(|error| format!("cannot listen on 127.0.0.1:{}: {error}", args.port))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let url = format!("http://127.0.0.1:{port}");
    let visibility = if public {
        "public: anonymous reads"
    } else {
        "private: every read needs a key"
    };
    let _ = writeln!(ctx.stdout, "listening on {url}");
    let _ = writeln!(
        ctx.stdout,
        "shelf `{namespace}`, {visibility}, {key_count} key(s)"
    );

    let now = serve::now();
    let mut published = Vec::new();
    for id in loaded.profiles.keys() {
        let packaged = loaded
            .resolve(id)
            .and_then(|resolved| crate::package::package(&loaded, &resolved));
        match packaged {
            Ok(packaged) => {
                let package = PackageId::parse(&packaged.package)?;
                let response =
                    registry.publish(&package, &packaged.version, packaged.archive.clone(), &now);
                if response.status == 201 {
                    let _ = writeln!(
                        ctx.stdout,
                        "published {} {} {}",
                        packaged.package, packaged.version, packaged.digest
                    );
                    published.push((package, packaged.version));
                } else {
                    let _ = writeln!(
                        ctx.stderr,
                        "not published: {} ({}): {}",
                        packaged.package,
                        response.status,
                        String::from_utf8_lossy(&response.body)
                    );
                }
            }
            Err(errors) => {
                let _ = writeln!(ctx.stderr, "not published: profile `{id}`:\n{errors}");
            }
        }
    }
    let default = loaded.manifest.default_profile.as_deref();
    let example = published
        .iter()
        .find(|(package, _)| Some(package.repo.as_str()) == default)
        .or_else(|| published.first());
    if let Some((package, version)) = example {
        let _ = writeln!(
            ctx.stdout,
            "\nTo install it with APM, run `apm experimental enable registries` once, then declare in apm.yml:\n\n{}",
            serve::install_snippet(&url, package, version)
        );
    }
    if !public {
        let _ = writeln!(
            ctx.stderr,
            "note: APM 0.33.0 sends no credentials over plain http, so it cannot read a private shelf from \
             this server; use --public for APM, or a client that sends a key"
        );
    }
    let _ = ctx.stdout.flush();

    let shared = Arc::new(Mutex::new(registry));
    let log: Arc<Mutex<dyn Write + Send>> = Arc::new(Mutex::new(std::io::stderr()));
    let limits = serve::Limits {
        request_timeout: std::time::Duration::from_secs(args.request_timeout),
        max_connections: usize::try_from(args.max_connections).unwrap_or(usize::MAX),
    };
    serve::run(&listener, &shared, &log, limits);
    Ok(())
}
