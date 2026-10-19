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
//! while stating that the spec's prose wins where the two disagree, and the
//! prose defers MCP objects to APM's manifest reference. So every object-form
//! MCP entry is validated against APM 0.33.0's own entry rules
//! (`schemas/apm-mcp-entry.schema.json`, written from APM's source), and only
//! an entry that passes them has the published schema's error at exactly its
//! location waived. Anything else fails.

use crate::yaml::Node;
use std::sync::OnceLock;

/// The vendored schema, byte for byte.
pub const MANIFEST_SCHEMA: &str = include_str!("../schemas/manifest-v0.1.schema.json");

/// Where the vendored schema came from.
pub const MANIFEST_SCHEMA_URL: &str =
    "https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json";

/// APM's own rules for an object-form `dependencies.mcp` entry, written by
/// ShelfKit from APM 0.33.0's source; see the file's `description`.
pub const MCP_ENTRY_SCHEMA: &str = include_str!("../schemas/apm-mcp-entry.schema.json");

type Compiled = Result<jsonschema::Validator, String>;

fn compile_schema(text: &str, name: &str) -> Compiled {
    let schema: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("{name} is not JSON: {error}"))?;
    jsonschema::draft202012::new(&schema)
        .map_err(|error| format!("{name} does not compile: {error}"))
}

fn manifest_validator() -> Result<&'static jsonschema::Validator, String> {
    static VALIDATOR: OnceLock<Compiled> = OnceLock::new();
    VALIDATOR
        .get_or_init(|| compile_schema(MANIFEST_SCHEMA, "the vendored manifest schema"))
        .as_ref()
        .map_err(Clone::clone)
}

fn mcp_validator() -> Result<&'static jsonschema::Validator, String> {
    static VALIDATOR: OnceLock<Compiled> = OnceLock::new();
    VALIDATOR
        .get_or_init(|| compile_schema(MCP_ENTRY_SCHEMA, "the APM MCP entry schema"))
        .as_ref()
        .map_err(Clone::clone)
}

fn describe(location: &str, error: &impl std::fmt::Display) -> String {
    let location = if location.is_empty() { "/" } else { location };
    format!("{location}: {error}")
}

/// Validate a manifest. `Err` lists every violation as `<location>: <message>`.
pub fn validate(manifest: &Node) -> Result<(), Vec<String>> {
    let manifest_schema = manifest_validator().map_err(|error| vec![error])?;
    let mcp_schema = mcp_validator().map_err(|error| vec![error])?;
    let instance = manifest.to_json();

    // Every object-form MCP entry, checked against APM's rules. Those that
    // pass are the only locations whose published-schema error is waived.
    let mut problems = Vec::new();
    let mut waived = Vec::new();
    for block in ["dependencies", "devDependencies"] {
        let Some(entries) = instance
            .get(block)
            .and_then(|b| b.get("mcp"))
            .and_then(|m| m.as_array())
        else {
            continue;
        };
        for (index, entry) in entries.iter().enumerate() {
            if !entry.is_object() {
                continue;
            }
            let location = format!("/{block}/mcp/{index}");
            let before = problems.len();
            for error in mcp_schema.iter_errors(entry) {
                let inner = error.instance_path().to_string();
                problems.push(describe(
                    &format!("{location}{inner}"),
                    &format!("APM's MCP entry rules: {error}"),
                ));
            }
            if problems.len() == before {
                waived.push(location);
            }
        }
    }
    problems.extend(manifest_schema.iter_errors(&instance).filter_map(|error| {
        let location = error.instance_path().to_string();
        (!waived.contains(&location)).then(|| describe(&location, &error))
    }));
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
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

        // An MCP object APM itself would refuse keeps failing.
        for bad in [
            "    - {}\n",
            "    - { name: 5, transport: bogus }\n",
            "    - { git: 5, id: 7 }\n",
            "    - { name: z, registry: false }\n",
            "    - { name: z, registry: false, transport: http }\n",
            "    - { name: z, registry: false, transport: stdio, command: \"a b\" }\n",
            "    - { name: ../z }\n",
            "    - { name: z, url: \"ws://x\" }\n",
            "    - { name: z, command: ../bin/x }\n",
            "    - { name: z, headers: { A: \"x\\ny\" } }\n",
        ] {
            let text = format!("name: x\nversion: 1.0.0\ndependencies:\n  mcp:\n{bad}");
            assert!(validate(&parse(&text)).is_err(), "{bad}");
        }
        let dev = parse("name: x\nversion: 1.0.0\ndevDependencies:\n  mcp:\n    - { foo: bar }\n");
        assert!(validate(&dev).is_err());

        // An `apm` object without an identity key is still an error.
        let apm = parse("name: x\nversion: 1.0.0\ndependencies:\n  apm:\n    - name: z\n");
        assert!(validate(&apm).is_err());
    }
}
