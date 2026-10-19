//! Which APM to run, and how (`docs/PRD.md` section 4).
//!
//! In order: an `apm` on `PATH`, checked against the supported range and
//! used with a warning when it is outside it; then APM through `uvx`, pinned
//! to [`APM_PIN`]; then nothing, with the exact command that installs `uv`
//! for the platform. ShelfKit never installs a package manager itself.

use super::system::{Platform, System};
use std::path::PathBuf;

/// The APM version `uvx` runs. Bumping it is a ShelfKit change: run the
/// compiler's golden tests and an `apm install` against them first.
pub const APM_PIN: &str = "0.33.0";

/// The `apm` versions ShelfKit is tested against: at least this...
const SUPPORTED_FROM: (u64, u64, u64) = (0, 33, 0);
/// ...and below this.
const SUPPORTED_BELOW: (u64, u64, u64) = (0, 34, 0);

pub fn supported_range() -> String {
    let (a, b, c) = SUPPORTED_FROM;
    let (x, y, z) = SUPPORTED_BELOW;
    format!(">={a}.{b}.{c}, <{x}.{y}.{z}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Runner {
    /// `apm` on `PATH`. `version` is `None` when it could not be read.
    Path {
        apm: PathBuf,
        version: Option<String>,
    },
    /// No `apm`, but `uvx` is there to run the pinned one.
    Uvx { uvx: PathBuf },
    /// Neither.
    Missing,
}

impl Runner {
    pub fn resolve(system: &dyn System) -> Self {
        if let Some(apm) = system.find("apm") {
            return Self::Path {
                version: read_version(system, &apm),
                apm,
            };
        }
        match system.find("uvx") {
            Some(uvx) => Self::Uvx { uvx },
            None => Self::Missing,
        }
    }

    /// The program and arguments that run `apm <args>`.
    pub fn command(&self, args: &[&str]) -> Option<(PathBuf, Vec<String>)> {
        let args = args.iter().map(|arg| (*arg).to_owned());
        match self {
            Self::Path { apm, .. } => Some((apm.clone(), args.collect())),
            Self::Uvx { uvx } => {
                let mut full = vec![
                    "--from".to_owned(),
                    format!("apm-cli=={APM_PIN}"),
                    "apm".to_owned(),
                ];
                full.extend(args);
                Some((uvx.clone(), full))
            }
            Self::Missing => None,
        }
    }

    /// Whether a path `apm` is in the supported range: `None` when its
    /// version is unknown or this is not a path runner.
    pub fn supported(&self) -> Option<bool> {
        match self {
            Self::Path {
                version: Some(version),
                ..
            } => parse_version(version).map(|v| v >= SUPPORTED_FROM && v < SUPPORTED_BELOW),
            _ => None,
        }
    }
}

/// The command line as a person would type it, for printing before it runs.
pub fn display_command(program: &std::path::Path, args: &[String]) -> String {
    let name = program
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.display().to_string());
    std::iter::once(name)
        .chain(args.iter().map(|arg| shell_quote(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_=./:@,+".contains(c))
    {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// The exact command that installs `uv` on this platform, after which
/// ShelfKit runs the pinned APM through `uvx`.
pub fn install_uv_command(platform: Platform) -> &'static str {
    match platform {
        Platform::Unix => "curl -LsSf https://astral.sh/uv/install.sh | sh",
        Platform::Windows => {
            "powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\""
        }
    }
}

/// What to tell a user who has neither `apm` nor `uv`.
pub fn missing_message(platform: Platform) -> String {
    format!(
        "neither `apm` nor `uvx` is on PATH, so ShelfKit cannot run APM. Install uv, which runs \
         the pinned APM {APM_PIN} without a global Python:\n\n    {}\n\nthen run this command again. \
         ShelfKit installs nothing itself.",
        install_uv_command(platform)
    )
}

/// `apm --version` prints a sentence, not a structured value, and ShelfKit
/// parses no human-oriented `apm` output, with this one narrow exception: the
/// first `X.Y.Z` in it, to compare with the supported range. When there is
/// none, the version is unknown and nothing is blocked.
fn read_version(system: &dyn System, apm: &std::path::Path) -> Option<String> {
    let (code, stdout) = system.capture(apm, &["--version"]).ok()?;
    if code != 0 {
        return None;
    }
    stdout
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|token| parse_version(token).is_some())
        .map(str::to_owned)
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_against_the_supported_range() {
        let runner = |v: &str| Runner::Path {
            apm: PathBuf::from("/bin/apm"),
            version: Some(v.to_owned()),
        };
        assert_eq!(runner("0.33.0").supported(), Some(true));
        assert_eq!(runner("0.33.7").supported(), Some(true));
        assert_eq!(runner("0.34.0").supported(), Some(false));
        assert_eq!(runner("0.31.0").supported(), Some(false));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
    }

    #[test]
    fn uvx_runs_the_pinned_apm() {
        let runner = Runner::Uvx {
            uvx: PathBuf::from("/x/uvx"),
        };
        let (program, args) = runner.command(&["install"]).unwrap();
        assert_eq!(
            display_command(&program, &args),
            "uvx --from apm-cli==0.33.0 apm install"
        );
        assert_eq!(Runner::Missing.command(&["install"]), None);
    }
}
