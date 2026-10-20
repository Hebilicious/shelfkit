//! The one door to other processes.
//!
//! Every command reaches `PATH` and child processes through [`System`], and
//! only `install` and `doctor` ever call it. Tests pass a double that panics
//! on any call, which is how they prove `compile` never runs APM.

use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Unix,
    Windows,
}

pub trait System {
    /// The program's path, when it is on `PATH`.
    fn find(&self, program: &str) -> Option<PathBuf>;
    /// Run a program to completion and capture its standard output.
    fn capture(&self, program: &Path, args: &[&str]) -> io::Result<(i32, String)>;
    /// Run a program in `dir` with this process's standard streams, and
    /// return its exit code.
    fn run(&self, program: &Path, args: &[String], dir: &Path) -> io::Result<i32>;
    fn platform(&self) -> Platform;
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
    fn run(&self, program: &Path, args: &[String], dir: &Path) -> io::Result<i32> {
        let status = std::process::Command::new(program)
            .args(args)
            .current_dir(dir)
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
