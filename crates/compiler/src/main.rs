//! The `shelfkit` binary. Everything is in [`shelfkit_compiler::cli`]; this
//! wires it to the real working directory, streams, and processes.

use shelfkit_compiler::cli::{Context, HostSystem, run};

fn main() -> std::process::ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("shelfkit: cannot read the current directory: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let mut ctx = Context {
        cwd,
        stdout: &mut stdout,
        stderr: &mut stderr,
        system: &HostSystem,
    };
    std::process::ExitCode::from(run(std::env::args_os(), &mut ctx))
}
