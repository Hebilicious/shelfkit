//! Validation against OpenAPM's published v0.1 manifest schema, compiled in.
//!
//! The schema is vendored in `schemas/` with its source and fetch date. It is
//! a published contract, so ShelfKit validates against it rather than
//! re-implementing APM's parser (`docs/PRD.md` sections 2 and 4).
//!
//! Native only: the `jsonschema` crate cannot build for
//! `wasm32-unknown-unknown` without wasm-bindgen imports. That costs the WASM
//! engine nothing it could show: validation never changes a plan, it only
//! refuses one, and the compiler emits a valid shape by construction, which
//! the golden tests check on every fixture.
//!
//! One exception, documented in `schemas/README.md`: the schema rejects every
//! object-form `dependencies.mcp` entry, including APM's own documented forms,
//! while stating that the spec's prose wins where the two disagree. An error
//! whose location is exactly such an entry is accepted; anything else fails.

use crate::yaml::Node;
use std::sync::OnceLock;

/// The vendored schema, byte for byte.
pub const MANIFEST_SCHEMA: &str = include_str!("../schemas/manifest-v0.1.schema.json");

/// Where the vendored schema came from.
pub const MANIFEST_SCHEMA_URL: &str =
    "https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json";

fn validator() -> Result<&'static jsonschema::Validator, String> {
    static VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();
    VALIDATOR
        .get_or_init(|| {
            let schema: serde_json::Value = serde_json::from_str(MANIFEST_SCHEMA)
                .map_err(|error| format!("the vendored schema is not JSON: {error}"))?;
            jsonschema::draft202012::new(&schema)
                .map_err(|error| format!("the vendored schema does not compile: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Validate a manifest. `Err` lists every violation as `<location>: <message>`.
pub fn validate(manifest: &Node) -> Result<(), Vec<String>> {
    let validator = validator().map_err(|error| vec![error])?;
    let instance = manifest.to_json();
    let problems: Vec<String> = validator
        .iter_errors(&instance)
        .filter(|error| !is_mcp_object(&instance, &error.instance_path().to_string()))
        .map(|error| {
            let location = error.instance_path().to_string();
            let location = if location.is_empty() {
                "/".to_owned()
            } else {
                location
            };
            format!("{location}: {error}")
        })
        .collect();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// Is `location` exactly an object-form entry of `dependencies.mcp` or
/// `devDependencies.mcp`?
fn is_mcp_object(instance: &serde_json::Value, location: &str) -> bool {
    let segments: Vec<&str> = location.trim_start_matches('/').split('/').collect();
    match segments.as_slice() {
        [block @ ("dependencies" | "devDependencies"), "mcp", index] => index
            .parse::<usize>()
            .ok()
            .and_then(|index| instance.get(*block)?.get("mcp")?.get(index))
            .is_some_and(serde_json::Value::is_object),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Node {
        Node::parse(text).unwrap()
    }

    #[test]
    fn the_vendored_schema_is_the_one_its_readme_names() {
        assert_eq!(
            crate::manifest::digest(MANIFEST_SCHEMA.as_bytes()),
            "sha256:7bdefbe443d3315d71add021c777d776c9cfd4942acb19750a799f46fa0d1344"
        );
    }

    #[test]
    fn a_minimal_manifest_is_valid() {
        assert_eq!(validate(&parse("name: x\nversion: 1.0.0\n")), Ok(()));
    }

    #[test]
    fn real_violations_fail_with_their_location() {
        let errors = validate(&parse("name: x\nversion: one\ntargets: [Claude]\n")).unwrap_err();
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(
            errors.iter().any(|e| e.starts_with("/version:")),
            "{errors:?}"
        );
        assert!(
            errors.iter().any(|e| e.starts_with("/targets:")),
            "{errors:?}"
        );
        assert!(validate(&parse("version: 1.0.0\n")).is_err());
        let insecure = "name: x\nversion: 1.0.0\nregistries:\n  a:\n    url: ftp://x\n";
        assert!(validate(&parse(insecure)).is_err());
    }

    #[test]
    fn the_schema_rejects_apm_mcp_objects_and_only_those_errors_are_accepted() {
        let manifest = parse(
            "name: x\nversion: 1.0.0\ndependencies:\n  mcp:\n    - io.github.x/y\n    \
             - name: z\n      registry: false\n      transport: stdio\n      command: z\n      args: []\n",
        );
        // The raw schema refuses the object, which is the bug this module works around.
        let schema: serde_json::Value = serde_json::from_str(MANIFEST_SCHEMA).unwrap();
        let raw = jsonschema::draft202012::new(&schema).unwrap();
        let locations: Vec<String> = raw
            .iter_errors(&manifest.to_json())
            .map(|e| e.instance_path().to_string())
            .collect();
        assert_eq!(locations, vec!["/dependencies/mcp/1"]);
        assert_eq!(validate(&manifest), Ok(()));

        // An `apm` object without an identity key is still an error.
        let apm = parse("name: x\nversion: 1.0.0\ndependencies:\n  apm:\n    - name: z\n");
        assert!(validate(&apm).is_err());
    }
}
