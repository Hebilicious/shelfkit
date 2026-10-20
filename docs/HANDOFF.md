# Handoff: orchestrate ShelfKit implementation

You are the orchestrating session for ShelfKit. This prompt is self-contained. Read it, then read the two ground-truth documents before dispatching anything.

## Ground truth

- **Repository:** `/home/heb/GitHub/shelfkit`, private at `github.com/Hebilicious/shelfkit`. Branch `main`, working tree clean, CI green at `ee04603`.
- **Spec:** `docs/PRD.md`. Read it in full. It is the source of truth for scope, and it is deliberately short. Do not re-derive scope from this handoff.
- **Conventions:** `AGENTS.md`. Read it. It lists the command surface and the rules that are easy to break.
- **Work items:** issues #2 to #8, with #9 as tracking. Each already contains scope, out-of-scope, acceptance criteria, its dispatch wave, branch name, and write scope for wave 5. Do not rewrite them; dispatch them.

## Environment

```bash
moon setup        # installs every pinned toolchain
pnpm install      # workspace dependencies
moon run :build :check :lint :test   # the gate
```

There are no npm scripts. Every task is a moon task. `moon query tasks` lists them.

Pinned: proto 0.62.2, node 26.9.0, npm 12.0.2, pnpm 11.8.0, moon 2.5.5, uv 0.11.20, rust 1.98.1. CI runs the full task graph on `main` and `moon ci` on pull requests.

## What already exists

| Path | State |
| --- | --- |
| `crates/core` | Working shelf model in `shelf.rs` (ten item kinds, profiles, bundles, compile options) and a tested content-addressed revision hasher in `revision.rs`. Loader and resolution do **not** exist yet. |
| `crates/compiler` | A stub `compile()` in `manifest.rs` that emits a minimal manifest, plus tests. `main.rs` handles only `--help` and `--version`. |
| `apps/worker` | Health route and a `501` catch-all in `index.ts`. `shelf-index.ts` has the Durable Object skeleton with its `meta` and `item` tables. Bindings in `wrangler.jsonc`: DO namespace, R2, one queue, one cron. |
| `apps/web` | Placeholder shell listing the eight routes from the PRD. Vite 8, Vize, CSSForge tokens wired and building. |
| `packages/schema` | A few Valibot schemas (item kind, revision, item id, key scopes). The six MCP tool schemas are **not** there yet; issue #2 adds them. |
| `packages/tokens` | Working CSSForge generation, output committed. |
| `shelf/` | ShelfKit's own shelf: one stack, one library, one prompt, one profile. |
| `scripts/setup.ts` | Cloudflare provisioning script, not yet exercised against a real account. |

Do not re-scaffold any of this. Extend it.

## The plan

Waves 1 to 4 are a chain. Each runs as its own session, alone. Wave 5 is three parallel workers with disjoint write scopes.

| Wave | Issues | Mode | Ends with |
| --- | --- | --- | --- |
| 1 | #2 | alone | the format loads, validates, resolves, and hashes deterministically |
| 2 | #3 | alone | `shelfkit compile` emits a schema-valid `apm.yml` |
| 3 | #4 | alone | `apm install` against `shelfkit serve` |
| 4 | #5 | alone | a deployed instance serves the registry durably |
| 5 | #6, #7, #8 | parallel | MCP, UI, and curation land together |

Issue #2 also carries two enablers that wave 5 depends on: the provenance fields in the item model, and the six MCP tool schemas in `packages/schema`. Both are acceptance criteria there. Do not start wave 5 until they exist.

## Per issue: the detail a session will get wrong

- **#2, shelf format.** Revision hashing is a canonical serialization: paths sorted, LF line endings, no timestamps. The hasher already exists and is tested; wire it to directories rather than rewriting it. Errors must carry the file path.
- **#3, compiler.** `compile` writes `apm.yml` and stops. No lockfile, no materializing skills into harness directories, no invoking APM. Validate against the OpenAPM v0.1 JSON Schema, and note the URL in APM's docs (`manifest-v0.1.41.schema.json`) is a 404; `manifest-v0.1.schema.json` resolves. A `hook` item must compile into the vendored package because APM cannot pin a `.json` as a virtual file. `shelfkit install` runs APM through `uvx --from apm-cli==<pin> apm` when no `apm` binary is present.
- **#4, registry.** Three endpoints only. Archives are `tar.gz` and `application/gzip` only, because the v0.1 consumer rejects zip and serving zip would break the only client. Repeat `PUT` returns `409`. Missing credentials return `401`, not `403`. Digests are `sha256:` over the archive bytes. Versions are immutable.
- **#5, hosted service.** One Durable Object per shelf with SQLite, schema set up behind `blockConcurrencyWhile` in the constructor. No D1, no cross-shelf query. Content in R2 keyed by `sha256`; databases hold metadata only. Keys are managed over GraphQL, not a REST auth path. `drizzle-orm/durable-sqlite`.
- **#6, MCP.** Stateless fetch handler on spec revision 2026-07-28. ShelfKit's own tools plus a narrow relay for remote servers whose credential must not be distributed. Namespaced `<item>__<tool>`, item ids may not contain `__`. No stateful MCP servers in any form, ever.
- **#7, web UI.** The prompt library is the screen that earns its keep; build it first, not last. The composer shows inventory, profile, resolution rail, and a live `apm.yml` preview. The manifest preview and `shelfkit compile --dry-run` must produce identical output, asserted in a Playwright test.
- **#8, curation.** Per-source adapters carrying licence metadata, an import-or-link-only flag, and attribution fields. A source with no licence contributes URLs and never content. Verdicts bind to our own computed hash, never a provider timestamp. Populate the provenance fields #2 added; do not add model fields while #6 and #7 are in flight.

## Hard rules

- APM owns install, resolution, the lockfile, policy, and drift. ShelfKit writes `apm.yml` and stops.
- Never parse human-oriented `apm` output. Only `audit -f json`, `deps why --json`, `pack --json`, `policy status --json`, `targets --json`, and `lock export` are structured. Drive the rest by exit code and read `apm.lock.yaml`.
- Emit only the OpenAPM v0.1 canonical producer set of targets by default. Anything outside it is an explicit opt-in that `check` reports.
- ShelfKit never runs a shelf's server code, in any form.
- Item ids are kebab-case and contain no `__`.

## Pitfalls already paid for

These cost hours. Do not rediscover them.

- The moon toolchain file is `.moon/toolchains.yml`, **plural**. Moon silently ignores the singular name and then reports no configured toolchains.
- Rust is pinned in both `.prototools` and `.moon/toolchains.yml`, and the two must agree. `.prototools` is what proto resolves; the moon file is what tells moon to manage the toolchain at all. Do not add a `rust-toolchain.toml`; combined with proto it leaves rustup agreeing to a toolchain with no cargo.
- Moon rejects `&&` in a task command. Split chained steps into separate tasks wired with `deps`.
- `dependsOn` orders projects, not tasks. Ordering a build after another project's build needs a task-level `deps` (see `apps/worker/moon.yml` depending on `web:build`).
- Moon layer constraints forbid application-on-application dependencies. The worker-to-web ordering is permitted through `constraints.tagRelationships` in `.moon/workspace.yml`.
- Moon does not put a project's own `node_modules/.bin` on PATH. Invoke binaries by path (`node_modules/.bin/vite`).
- `moon ci` resolves zero targets when there is no base revision to diff against, and reports success having run nothing. That is why `main` runs the full graph.
- Local `proto status` can look wrong when the shell has a stale proto activation on PATH. Verify toolchain pins in a clean environment before changing `.prototools`.
- The CRLF revision test caught a real hashing bug: length framing must describe the normalized content, not the input bytes.

## Protocol

For each of waves 1 to 4: start one session, give it the issue number, `docs/PRD.md`, `AGENTS.md`, and the per-issue detail above. It works on the branch named in the issue, opens a pull request, and does not merge. You review, confirm CI is green, and squash-merge before starting the next wave.

For wave 5: create three tasks on the shared task board, one per issue, with the write scopes from the issues. Spawn three teammates: `mcp` (#6, `apps/worker/src/mcp/`), `ui` (#7, `apps/web/`), `curation` (#8, `packages/importers/` plus additive `crates/core`). Merge in order #6, #8, #7. Run the final gate yourself on the merged tree rather than trusting a branch.

No work leaves a wave with red CI. `moon run :build :check :lint :test` green locally and CI green on the pull request are both required.

## Do not

Re-scaffold the workspace, add npm scripts, add a D1 database, add `rust-toolchain.toml`, add a stateful MCP server or a container, or change the toolchain pins beyond what a task needs. If a pinned tool blocks work, say so and stop rather than silently downgrading.
