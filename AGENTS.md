# ShelfKit

A registry and curation layer for AI agent context, built on [APM](https://github.com/microsoft/apm). **`docs/PRD.md` is the specification and the source of truth for scope. Read it before writing code.**

## Commands

There are no npm scripts. Everything is a moon task.

```bash
moon setup                 # every pinned toolchain
pnpm install               # workspace dependencies
moon run :build            # build every project that has a build task
moon run :check :lint      # typecheck, lint, format and authorship checks
moon run :test             # tests
moon run web:dev           # SPA on :5173
moon run worker:dev        # Worker on :8787
moon query tasks           # every task, by project
moon run worker:setup      # provision a Cloudflare account and deploy
moon run root:format       # format the repository with oxfmt
moon run root:hooks-install # install the git hooks, once per clone
```

`moon run :task` runs that task in every project defining it. A single project is `moon run core:test`. The repository root is the `root` project, which holds only repository-wide checks and the git hooks.

## Layout

| Path | Holds |
| --- | --- |
| `crates/core` | The shelf format: item kinds, profiles, revisions, resolution. **The product.** |
| `crates/compiler` | Profile to `apm.yml`, plus the `shelfkit` binary (its `cli` feature). The OpenAPM manifest schema is vendored in `schemas/`. |
| `crates/wasm` | The core and compiler as a `wasm32-unknown-unknown` module with a JSON ABI. No bindings generator. |
| `apps/worker` | Cloudflare Worker: registry, MCP, GraphQL, static assets. |
| `apps/web` | Vue 3 SPA. |
| `packages/schema` | Boundary validation shared by the Worker and the CLI. |
| `packages/engine` | `@shelfkit/engine`: the typed port over the WASM module, for the Worker, the browser, and Node. |
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
- Every Node dependency is pinned exactly, once, in the `catalog` of `pnpm-workspace.yaml`. A `package.json` names `catalog:` and never a version.
- `oxlint` lints with Ultracite's presets plus the vendored anti-slop rules in `tools/oxlint/anti-slop`, and `oxfmt` formats with Ultracite's settings; `vize` formats and lints the Vue components, and `cargo fmt` and clippy keep the crates. Do not introduce ESLint or Prettier. A rule is disabled only on the line it concerns, with its reason after `--`; a rule that is off for a file or for the repository says why beside its setting in `oxlint.config.ts`.
- A new project joins the workspace through a glob in `.moon/workspace.yml` and a `moon.yml` declaring its tasks.
- Binaries in moon tasks are invoked by their path in `node_modules/.bin`; moon puts toolchain binaries on PATH but not a project's own.

## Branches and commits

- Each task gets its own branch and its own worktree in `.worktrees/<branch>`, created from `main` with `git worktree add .worktrees/<branch> -b <branch> main`. Run `pnpm install` in it and do all the work there. The main checkout stays on `main`.
- Commits and pull requests carry no AI attribution: no `Co-Authored-By` trailer for an assistant, no generated-with footer. gommage enforces it from `.gommage.yml`.
- lefthook checks each commit message with gommage, formatting on commit, and lint and type checks on push. Fix what it reports instead of bypassing it with `--no-verify`.

## Toolchains

Every toolchain is pinned in `.prototools`, and `.moon/toolchains.yml` tells moon to manage them. The two pins must agree: proto resolves `.prototools`, and moon only manages a toolchain this file declares. The filename is plural; moon ignores `toolchain.yml` without warning.

CI runners ship their own rustup default, which can be newer than the pin; a cargo subcommand such as clippy then compiles with it, and two compilers sharing `target/` fail with E0514. The toolchains action makes the `.prototools` pin rustup's default for the whole job, so keep that step when changing CI.

## Testing

`moon run :test` runs every project's tests. Rust tests live beside the code they cover; the compiler's golden-file tests assert the `apm.yml` shape and are what catch an APM change. Regenerate goldens with `SHELFKIT_UPDATE_GOLDEN=1 cargo test --package <crate>` and review the diff. The compiler's plans are parsed by `CompilePlanSchema` in `packages/schema`, and `packages/engine` checks that the WASM module returns `shelfkit compile --dry-run --json` byte for byte. The test that runs `apm install` skips without an `apm` on `PATH`; `SHELFKIT_TEST_APM_UVX=1` runs it through the pinned `uvx`. Prefer a test that fails for a real reason over one that restates the implementation: the revision test for CRLF normalization caught a genuine hashing bug before the first commit.
