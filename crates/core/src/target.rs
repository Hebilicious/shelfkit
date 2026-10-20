//! APM target slugs, used verbatim.
//!
//! `apm targets --json` is the authority for which targets exist. The
//! OpenAPM v0.1 producer rules fix a smaller canonical set than the CLI
//! supports and require a producer to reject anything outside it, so a slug
//! falls into one of three classes:
//!
//! - **canonical**: in the v0.1 producer set. The default, and always allowed.
//! - **CLI-only**: APM's manifest parser accepts it, but a v0.1 producer must
//!   not emit it. Allowed only as an explicit opt-in, which makes the manifest
//!   Producer-nonconformant and which `check` reports.
//! - **rejected**: APM's own manifest validator refuses it (`intellij`, which
//!   is MCP-only, and the experimental-flag targets), or it is an alias rather
//!   than a slug.
//!
//! The lists below were taken from APM 0.33.0 (`apm_cli/core/target_catalog.py`
//! and `apm_cli/core/apm_yml.py`) and the v0.1 producer set in `docs/PRD.md`
//! section 5. An APM release that adds a target is a change here.

use serde::Serialize;

/// The OpenAPM v0.1 canonical producer set.
pub const CANONICAL: &[&str] = &[
    "agent-skills",
    "all",
    "antigravity",
    "claude",
    "codex",
    "copilot",
    "cursor",
    "gemini",
    "opencode",
    "windsurf",
];

/// Accepted by APM's manifest parser, outside the v0.1 producer set.
pub const CLI_ONLY: &[&str] = &["grok-build", "hermes", "kiro"];

/// Targets APM's manifest validator rejects, with the reason.
const REJECTED: &[(&str, &str)] = &[
    (
        "intellij",
        "is rejected by APM's manifest validator: it is an MCP-only integration, not a manifest target",
    ),
    (
        "copilot-app",
        "is rejected by APM's manifest validator, which refuses experimental-flag targets",
    ),
    (
        "copilot-cowork",
        "is rejected by APM's manifest validator, which refuses experimental-flag targets",
    ),
    (
        "grok-cloud",
        "is rejected by APM's manifest validator, which refuses experimental-flag targets",
    ),
    (
        "openclaw",
        "is rejected by APM's manifest validator, which refuses experimental-flag targets",
    ),
];

/// Spellings APM accepts as aliases. A shelf uses slugs verbatim, so these
/// are refused with the slug to write instead.
const ALIASES: &[(&str, &str)] = &[
    ("agents", "copilot"),
    ("agy", "antigravity"),
    ("vscode", "copilot"),
];

/// How a valid slug relates to the v0.1 producer rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetClass {
    Canonical,
    CliOnly,
}

/// Classify a slug, or say why it is refused.
pub fn classify(slug: &str) -> Result<TargetClass, String> {
    if CANONICAL.contains(&slug) {
        return Ok(TargetClass::Canonical);
    }
    if CLI_ONLY.contains(&slug) {
        return Ok(TargetClass::CliOnly);
    }
    if let Some((_, reason)) = REJECTED.iter().find(|(name, _)| *name == slug) {
        return Err((*reason).to_owned());
    }
    if let Some((_, canonical)) = ALIASES.iter().find(|(name, _)| *name == slug) {
        return Err(format!(
            "is an APM alias; use the slug `{canonical}` verbatim"
        ));
    }
    Err("is not an APM target slug".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_slugs_are_accepted() {
        for slug in [
            "claude",
            "copilot",
            "cursor",
            "codex",
            "agent-skills",
            "all",
        ] {
            assert_eq!(classify(slug), Ok(TargetClass::Canonical), "{slug}");
        }
    }

    #[test]
    fn cli_only_slugs_need_an_opt_in() {
        for slug in ["kiro", "grok-build", "hermes"] {
            assert_eq!(classify(slug), Ok(TargetClass::CliOnly), "{slug}");
        }
    }

    #[test]
    fn intellij_is_rejected_outright() {
        let reason = classify("intellij").unwrap_err();
        assert!(reason.contains("manifest validator"), "{reason}");
    }

    #[test]
    fn aliases_point_at_the_slug() {
        assert!(classify("vscode").unwrap_err().contains("`copilot`"));
        assert!(classify("Claude").is_err());
    }
}
