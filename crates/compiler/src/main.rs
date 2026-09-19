//! The `shelfkit` binary.
//!
//! `compile` writes an `apm.yml` and stops. `install` resolves APM (on the
//! path, or through a pinned `uvx`) and runs it. See `docs/PRD.md` section 4.

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version" | "-V") => {
            println!("shelfkit {}", env!("CARGO_PKG_VERSION"));
            std::process::ExitCode::SUCCESS
        }
        Some("--help" | "-h") | None => {
            print!("{USAGE}");
            std::process::ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("shelfkit: `{other}` is not implemented yet");
            eprintln!("see docs/PRD.md for the command surface");
            std::process::ExitCode::from(2)
        }
    }
}

const USAGE: &str = "\
shelfkit: a shelf of agent context, compiled to APM

Usage: shelfkit <COMMAND>

Commands:
  init        Scaffold a shelf
  add         Import items from a source
  search      Search the shelf
  serve       Run a shelf locally as a registry
  compile     Write apm.yml and vendored content (never runs APM)
  install     Run APM, resolved from the path or through uvx
  verify      The manifest still matches the profile it came from
  doctor      Report APM, harnesses, and source drift
  login       Authenticate the CLI against a hosted shelf
  push        Publish the shelf to the hosted service

See docs/PRD.md for the full specification.
";
