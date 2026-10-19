# Vendored schemas

`manifest-v0.1.schema.json` is the OpenAPM v0.1 manifest schema, copied byte for byte and compiled into the
`shelfkit` binary (`src/schema.rs`), which validates every manifest it compiles against it.

`apm-mcp-entry.schema.json` is not published by anyone: ShelfKit wrote it from APM 0.33.0's source
(`src/apm_cli/models/dependency/mcp.py`, `MCPDependency.from_dict` and `validate`) and its manifest reference
(section 4.2), to check object-form `dependencies.mcp` entries the published schema cannot (below).

| | |
| --- | --- |
| Source | https://microsoft.github.io/apm/specs/schemas/manifest-v0.1.schema.json |
| Fetched | 2026-10-19 |
| sha256 | `7bdefbe443d3315d71add021c777d776c9cfd4942acb19750a799f46fa0d1344` |
| Identical to | `docs/public/specs/schemas/manifest-v0.1.schema.json` at APM `v0.33.0` |

The reference docs point at `manifest-v0.1.41.schema.json` under `/apm/schemas/`, which is a 404. A schema of that name
does resolve under `/apm/specs/schemas/`; it differs from this one only by a `pattern` on the `alias` field of an
object-form dependency, which ShelfKit never writes.

One known disagreement: the schema's `depEntry` requires `git`, `id`, `path`, or a string `registry` on every object,
and `dependencies.mcp` reuses it, so it rejects every MCP object APM documents (`registry: false` servers, and registry
servers with overlays). The schema states that the spec's prose is authoritative where the two disagree, and the prose
defers MCP objects to APM's manifest reference. `src/schema.rs` therefore validates each object-form `dependencies.mcp`
entry against `apm-mcp-entry.schema.json`, and waives the published schema's error at exactly that entry only when it
passes; the compiler writes a `mcp-schema-mismatch` note for each such entry.

To update: fetch the file again, replace it here, update the table, and run `cargo test --package shelfkit-compiler`.
