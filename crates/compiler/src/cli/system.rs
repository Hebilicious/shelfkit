//! The one door to the world outside the shelf: other processes, the
//! network, the OS keychain, and the user's environment.
//!
//! Every command reaches `PATH` and child processes through [`System`], and
//! only `install` and `doctor` ever call it. Tests pass a double that panics
//! on any call, which is how they prove `compile` never runs APM. The hosted
//! service's client (`login`, `push`, `fetch`) is the only caller of the
//! network and keychain methods, whose defaults refuse, so a double that does
//! not provide them proves a command never reaches either.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Unix,
    Windows,
}

/// A request to the hosted service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The hosted service's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// The keychain service every key is stored under; the account is the
/// service's URL.
pub const KEYCHAIN_SERVICE: &str = "shelfkit";

fn unavailable(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        format!("{what} is not available here"),
    )
}

pub trait System {
    /// The program's path, when it is on `PATH`.
    fn find(&self, program: &str) -> Option<PathBuf>;
    /// Run a program to completion and capture its standard output.
    fn capture(&self, program: &Path, args: &[&str]) -> io::Result<(i32, String)>;
    /// Run a program in `dir` with this process's standard streams and
    /// environment, plus `env`, and return its exit code.
    fn run(
        &self,
        program: &Path,
        args: &[String],
        dir: &Path,
        env: &[(String, String)],
    ) -> io::Result<i32>;
    fn platform(&self) -> Platform;

    /// Send one HTTP request and read the whole answer. A status that is not
    /// 2xx is an answer, not an error.
    fn http(&self, _request: &HttpRequest) -> io::Result<HttpResponse> {
        Err(unavailable("the network"))
    }

    /// The key stored for `account` in the OS keychain, if there is one.
    fn keychain_get(&self, _account: &str) -> io::Result<Option<String>> {
        Err(unavailable("the OS keychain"))
    }

    fn keychain_set(&self, _account: &str, _secret: &str) -> io::Result<()> {
        Err(unavailable("the OS keychain"))
    }

    /// Remove the key stored for `account`; `false` when there was none.
    fn keychain_delete(&self, _account: &str) -> io::Result<bool> {
        Err(unavailable("the OS keychain"))
    }

    /// An environment variable.
    fn var(&self, _name: &str) -> Option<String> {
        None
    }

    /// The directory user configuration lives in (`$XDG_CONFIG_HOME`,
    /// `~/.config`, or `%APPDATA%`).
    fn config_dir(&self) -> Option<PathBuf> {
        None
    }

    /// Read a secret: from the terminal without echoing it, or a line of
    /// standard input when that is not a terminal.
    fn read_secret(&self, _prompt: &str) -> io::Result<String> {
        Err(unavailable("reading a secret"))
    }

    /// Whether standard input is a terminal, so a person is there to sign in
    /// through the browser. `false` by default, as in CI.
    fn stdin_is_terminal(&self) -> bool {
        false
    }

    /// This computer's name, to show on the page that approves a login.
    fn hostname(&self) -> Option<String> {
        None
    }

    /// Wait between two polls of the hosted service.
    fn sleep(&self, _duration: Duration) {}
}

/// The real machine.
pub struct HostSystem;

impl System for HostSystem {
    fn find(&self, program: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH")?;
        let extensions: Vec<String> = if cfg!(windows) {
            std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_owned())
                .split(';')
                .map(str::to_ascii_lowercase)
                .collect()
        } else {
            vec![String::new()]
        };
        std::env::split_paths(&path).find_map(|dir| {
            extensions.iter().find_map(|extension| {
                let candidate = dir.join(format!("{program}{extension}"));
                is_executable(&candidate).then_some(candidate)
            })
        })
    }

    // The seam itself: `clippy.toml` forbids `Command::new` everywhere else.
    #[allow(clippy::disallowed_methods)]
    fn capture(&self, program: &Path, args: &[&str]) -> io::Result<(i32, String)> {
        let output = std::process::Command::new(program).args(args).output()?;
        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).into_owned(),
        ))
    }

    // The seam itself: `clippy.toml` forbids `Command::new` everywhere else.
    #[allow(clippy::disallowed_methods)]
    fn run(
        &self,
        program: &Path,
        args: &[String],
        dir: &Path,
        env: &[(String, String)],
    ) -> io::Result<i32> {
        let status = std::process::Command::new(program)
            .args(args)
            .current_dir(dir)
            .envs(env.iter().map(|(name, value)| (name, value)))
            .status()?;
        Ok(status.code().unwrap_or(-1))
    }

    fn platform(&self) -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }

    fn http(&self, request: &HttpRequest) -> io::Result<HttpResponse> {
        crate::cli::network::send(request)
    }

    fn keychain_get(&self, account: &str) -> io::Result<Option<String>> {
        crate::cli::keychain::get(account)
    }

    fn keychain_set(&self, account: &str, secret: &str) -> io::Result<()> {
        crate::cli::keychain::set(account, secret)
    }

    fn keychain_delete(&self, account: &str) -> io::Result<bool> {
        crate::cli::keychain::delete(account)
    }

    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn config_dir(&self) -> Option<PathBuf> {
        if cfg!(windows) {
            return std::env::var_os("APPDATA").map(PathBuf::from);
        }
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
    }

    fn stdin_is_terminal(&self) -> bool {
        use std::io::IsTerminal as _;
        io::stdin().is_terminal()
    }

    fn hostname(&self) -> Option<String> {
        let named = |text: String| {
            let name = text.trim().to_owned();
            (!name.is_empty()).then_some(name)
        };
        if cfg!(windows) {
            return std::env::var("COMPUTERNAME").ok().and_then(named);
        }
        std::fs::read_to_string("/proc/sys/kernel/hostname")
            .ok()
            .and_then(named)
            .or_else(|| std::env::var("HOSTNAME").ok().and_then(named))
            .or_else(|| {
                let program = self.find("hostname")?;
                let (code, output) = self.capture(&program, &[]).ok()?;
                (code == 0).then_some(output).and_then(named)
            })
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn read_secret(&self, prompt: &str) -> io::Result<String> {
        use std::io::IsTerminal as _;
        let secret = if io::stdin().is_terminal() {
            rpassword::prompt_password(prompt)?
        } else {
            let mut line = String::new();
            io::stdin().read_line(&mut line)?;
            line
        };
        Ok(secret.trim().to_owned())
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}
