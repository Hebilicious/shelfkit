# ShelfKit

A registry and curation layer for AI agent context, built on [APM](https://github.com/microsoft/apm). **`docs/PRD.md` is the specification and the source of truth for scope. Read it before writing code.**

## Commands

There are no npm scripts. Everything is a moon task.

```bash
moon setup                 # every pinned toolchain
pnpm install               # workspace dependencies
moon run :build            # build every project that has a build task
moon run :check :lint      # typecheck and format check
moon run :test             # tests
moon run web:dev           # SPA on :5173
moon run worker:dev        # Worker on :8787
moon query tasks           # every task, by project
moon run worker:setup      # provision a Cloudflare account and deploy
```

`moon run :task` runs that task in every project defining it. A single project is `moon run core:test`.

## Layout

| Path | Holds |
|---|---|
| `crates/core` | The shelf format: item kinds, profiles, revisions, resolution. **The product.** |
| `crates/compiler` | Profile to `apm.yml`, plus the `shelfkit` binary. |
| `apps/worker` | Cloudflare Worker: registry, MCP, GraphQL, static assets. |
| `apps/web` | Vue 3 SPA. |
| `packages/schema` | Boundary validation shared by the Worker and the CLI. |
| `packages/tokens` | CSSForge tokens, generated and committed. |
| `shelf/` | ShelfKit's own shelf. |

## Rules

- **`crates/` is the product.** It compiles native for the CLI and to WASM for the Worker, so the browser preview and the CLI cannot disagree. Keep it free of Cloudflare, network, and async-runtime dependencies.
- **APM owns install.** `shelfkit compile` writes `apm.yml` and stops. It never writes a lockfile, never materializes skills into harness directories, and never runs APM unless the `install` command was asked for.
- **Never parse human-oriented `apm` output.** Only `audit -f json`, `deps why --json`, `pack --json`, `policy status --json`, `targets --json`, and `lock export` are structured. Drive the rest by exit code and read `apm.lock.yaml`.
- **One Durable Object per shelf, SQLite, no D1.** There is no cross-shelf query and no shared database. Content lives in R2 keyed by `sha256`; databases hold metadata only.
- **No stateful MCP servers.** ShelfKit serves stateless tools and distributes MCP definitions. It never runs a shelf's server code, in any form.
- **APM targets verbatim.** Emit only the OpenAPM v0.1 canonical producer set by default; anything outside it is an explicit opt-in that `check` reports.
- **Migrations run inside the Durable Object**, behind `blockConcurrencyWhile`. There is no CLI path to its SQLite and `PRAGMA user_version` is unsupported.
- **Item ids are kebab-case and contain no `__`**, which the MCP namespace separator reserves.

## Conventions

- Rust: `unwrap_used` and `expect_used` are denied outside tests. Errors carry the file they came from, because a shelf that half-loads produces an agent that half-knows the conventions.
- TypeScript: `strict`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. No enums, no parameter properties. Type-only imports need `import type`.
- Design values come from CSSForge tokens. No hand-written colours, spacing, or type.
- A new project joins the workspace through a glob in `.moon/workspace.yml` and a `moon.yml` declaring its tasks.
- Binaries in moon tasks are invoked by their path in `node_modules/.bin`; moon puts toolchain binaries on PATH but not a project's own.

## Toolchains

Every toolchain is pinned in `.prototools`, and `.moon/toolchains.yml` tells moon to manage them. The two pins must agree: proto resolves `.prototools`, and moon only manages a toolchain this file declares. The filename is plural; moon ignores `toolchain.yml` without warning.

## Testing

`moon run :test` runs every project's tests. Rust tests live beside the code they cover; the compiler's golden-file tests assert the `apm.yml` shape and are what catch an APM change. Prefer a test that fails for a real reason over one that restates the implementation: the revision test for CRLF normalization caught a genuine hashing bug before the first commit.
