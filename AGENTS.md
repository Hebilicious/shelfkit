# ShelfKit

A registry and curation layer for AI agent context, built on [APM](https://github.com/microsoft/apm). **[`docs/PRD.md`](docs/PRD.md) is the specification and the source of truth for scope. Read it before writing code.**

## Commands

There are no npm scripts. Everything is a moon task.

```bash
moon setup                 # every pinned toolchain
pnpm install               # workspace dependencies
moon run :build            # build every project that has a build task
moon run :check :lint      # typecheck, lint, format and authorship checks
moon run :test             # tests
moon run web:dev           # SPA on :5173
moon run worker:dev        # Worker on :8787, on Miniflare without Artifacts (wrangler.local.json)
moon query tasks           # every task, by project
moon run worker:setup      # provision a Cloudflare account and deploy (not `pnpm setup`, which is pnpm's own command)
moon run worker:db-generate      # the shelf object's next migration, from apps/worker/src/db/schema.ts
moon run worker:graphql-schema   # rewrite apps/worker/schema.graphql
moon run worker:do-migrations    # rewrite wrangler.jsonc's Durable Object migration entries
moon run root:format       # format the repository with oxfmt
moon run root:hooks-install # install the git hooks, once per clone
```

`moon run :task` runs that task in every project defining it. A single project is `moon run core:test`. The repository root is the `root` project, which holds only repository-wide checks and the git hooks.

## Layout

| Path | Holds |
| --- | --- |
| `crates/core` | The shelf format: item kinds, profiles, revisions, resolution. **The product.** |
| `crates/compiler` | Profile to `apm.yml`, plus the `shelfkit` binary (its `cli` feature). The OpenAPM manifest schema is vendored in `schemas/`. |
| `crates/registry` | The OpenAPM Registry HTTP API with no I/O: routing, auth decisions, publish validation, RFC 7807 problems, deterministic `tar.gz`. `shelfkit serve` and the Worker both run it. Its conformance cases are `conformance/cases.json`. |
| `crates/git` | Git objects, trees, packfiles, and smart HTTP's both sides, with no I/O: how the Worker commits to a shelf's repository, and how local mode serves one (`serve`). |
| `crates/wasm` | The core, compiler, registry, and Git encoding as a `wasm32-unknown-unknown` module with a JSON ABI. No bindings generator. |
| `apps/worker` | Cloudflare Worker: registry, MCP, GraphQL, Git, static assets. `src/shelf-index.ts` is the shelf's Durable Object and its API; `src/repository/` is each shelf's repository, in Artifacts or, locally, in R2; `src/git.ts` relays Git clients to it; `schema.graphql` is the committed SDL. |
| `apps/web` | Vue 3 SPA. |
| `packages/schema` | Boundary validation shared by the Worker and the CLI. |
| `packages/importers` | Source adapters and scanners behind the interface the Worker's import jobs call. |
| `packages/engine` | `@shelfkit/engine`: the typed port over the WASM module, for the Worker, the browser, and Node. |
| `packages/tokens` | CSSForge tokens, generated and committed. |
| `shelf/` | ShelfKit's own shelf. |

## Rules

- **`crates/` is the product.** It compiles native for the CLI and to WASM for the Worker, so the browser preview and the CLI cannot disagree. Keep it free of Cloudflare, network, and async-runtime dependencies.
- **APM owns install.** `shelfkit compile` writes `apm.yml` and stops. It never writes a lockfile, never materializes skills into harness directories, and never runs APM unless the `install` command was asked for. Beyond `apm.yml`, `shelfkit install` writes only the two marker lines of AGENTS.md's managed section and CLAUDE.md's `@AGENTS.md` import, which route instructions through AGENTS.md for every agent (`docs/PRD.md` section 4.2); APM writes everything else.
- **Never parse human-oriented `apm` output.** Only `audit -f json`, `deps why --json`, `pack --json`, `policy status --json`, `targets --json`, and `lock export` are structured. Drive the rest by exit code and read `apm.lock.yaml`.
- **The registry is `crates/registry`, and it is served as it is.** Three endpoints, `tar.gz` as `application/gzip` only, immutable versions (a repeat `PUT` is `409`), `401` for a missing or unknown credential, `403` only for a missing scope, and a known key reads a public shelf whatever its scopes. Archives are read strictly: anything Python's `tarfile` (APM's extractor) could read differently is refused. A host does I/O and nothing else; a new rule goes into the library and a case into `conformance/cases.json`, which both hosts run.
- **A shelf's files live in its Artifacts repository; the Durable Object indexes its head.** Every write the Worker makes is a commit first and a snapshot second, one at a time per shelf; a push from a Git client is indexed afterwards, and a head the engine refuses leaves the index where it was. Artifacts has no local simulator, so local mode runs without its binding (`scripts/local-config.ts`) and keeps each repository in R2, serving Git itself (`src/repository/local.ts`); the Worker tests stand in for Artifacts (`test/fake-artifacts.ts`) and run local mode's repositories too.
- **Git is the one way a checkout's files reach a hosted shelf.** There is no upload API: a shelf of its own pushes to `/git/{shelf}.git`, and a shelf inside a larger repository is a submodule of it (`docs/PRD.md` section 10.6). The CLI's hosted commands are `login`, `logout`, `open`, and `publish`.
- **A published profile installs from the registry or from Git, with the same files.** Each version the registry publishes is also a commit of its archive, tagged `v{version}`, in the profile's own repository, `/git/{shelf}/{profile}.git`, which APM installs from with a version range and no experimental flag. That repository is derived from the registry (`crates/registry/src/git.rs`, `apps/worker/src/packages.ts`) and never pushed to.
- **One Durable Object per shelf, SQLite, no D1.** There is no cross-shelf query and no shared database. Content lives in R2 keyed by `sha256`; databases hold metadata only.
- **No stateful MCP servers.** ShelfKit serves stateless tools and distributes MCP definitions. It never runs a shelf's server code, in any form.
- **APM targets verbatim.** Emit only the OpenAPM v0.1 canonical producer set by default; anything outside it is an explicit opt-in that `check` reports.
- **Migrations run inside the Durable Object**, behind `blockConcurrencyWhile`: in the constructor for an object that already holds a shelf (skipped when `schema_version` is current), and on the first write for one that has never been written, so reading an unknown shelf id stores nothing. There is no CLI path to its SQLite and `PRAGMA user_version` is unsupported. They are generated by Drizzle Kit (`worker:db-generate`) and committed; `meta.schema_version` records the version, and the gate fails when the schema has changes no migration covers.
- **One auth module** (`apps/worker/src/auth/`) turns a Bearer key, HTTP Basic, or the browser's cookie into a session for every surface, `/git` included. An Artifacts repository token is minted per Git exchange and never leaves the Worker. Nothing caches a key's resolution, so a revoked key fails everywhere at once. A key is never printed or logged, by the Worker or the CLI.
- **The Worker's module scope only imports.** The engine and the GraphQL schema are built on first use; `worker:startup-check` holds startup to a CPU budget.
- **Item ids are kebab-case and contain no `__`**, which the MCP namespace separator reserves.

## Conventions

- Rust: `unwrap_used` and `expect_used` are denied outside tests. Errors carry the file they came from, because a shelf that half-loads produces an agent that half-knows the conventions.
- TypeScript: `strict`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. No enums, no parameter properties. Type-only imports need `import type`.
- Design values come from CSSForge tokens. No hand-written colours, spacing, or type.
- The SPA reads server data only through `apps/web/src/data/`: `cache.ts` keys every answer and keeps it across screens and visits, and `shelf.ts` loads the shelf's index (every item, with its body and item.json) once, so the lists, search, and item pages render from memory. A screen never fetches in its own setup behind a spinner, and moving between screens never waits on data the index already holds. After a mutation, `invalidate(shelfPrefix(shelf))`; the live subscription does the same for changes made elsewhere.
- The UI never prints a format term raw. Kind slugs (`library`, `stack`), coordinate kinds (`vendored`, `upstream`), revision hashes, and words like compile, compose, resolution, or coordinate get their label and a sentence from `apps/web/src/lib/vocabulary.ts`, which says what the thing does for the agent. APM's own words (`apm.yml`, `apm install`, skills, prompts, instructions, MCP) stay as they are.
- Every Node dependency is pinned exactly, once, in the `catalog` of `pnpm-workspace.yaml`. A `package.json` names `catalog:` and never a version.
- `oxlint` lints with Ultracite's presets plus the vendored anti-slop rules in `tools/oxlint/anti-slop`, and `oxfmt` formats with Ultracite's settings; `vize` formats and lints the Vue components, and `cargo fmt` and clippy keep the crates. Do not introduce ESLint or Prettier. A rule is disabled only on the line it concerns, with its reason after `--`; a rule that is off for a file or for the repository says why beside its setting in `oxlint.config.ts`.
- A new project joins the workspace through a glob in `.moon/workspace.yml` and a `moon.yml` declaring its tasks.
- Binaries in moon tasks are invoked by their path in `node_modules/.bin`; moon puts toolchain binaries on PATH but not a project's own.

## Branches and commits

- Each task gets its own branch and its own worktree in `.worktrees/<branch>`, created from `main` with `git worktree add .worktrees/<branch> -b <branch> main`. Run `pnpm install` in it and do all the work there. The main checkout stays on `main`.
- Every handoff of a change lists, without being asked: the worktree and branch, the pull request against `main` (open it before the first handoff), the running local review server's URL when the change has a surface a person can open, and the Worker Preview's URL (`CLOUDFLARE_ACCOUNT_ID=<id> moon run worker:preview`, then seed it with `git push <preview>/git/<shelf>.git main` and `shelfkit publish --url <preview>`) when the change touches the web UI or the Worker. A preview's owner key goes only to `shelfkit login <preview>`, never to the chat. When one of these does not apply, say so in a clause.
- Verify behaviour that depends on Cloudflare on Cloudflare, not only under Miniflare: a Preview, or a throwaway Worker deployed from the branch with its own bindings and deleted afterwards.
- Commits and pull requests carry no AI attribution: no `Co-Authored-By` trailer for an assistant, no generated-with footer. gommage enforces it from `.gommage.yml`.
- lefthook checks each commit message with gommage, formatting on commit, and lint and type checks on push. Fix what it reports instead of bypassing it with `--no-verify`.

## Toolchains

Every toolchain is pinned in `.prototools`, and `.moon/toolchains.yml` tells moon to manage them. The two pins must agree: proto resolves `.prototools`, and moon only manages a toolchain this file declares. The filename is plural; moon ignores `toolchain.yml` without warning.

CI runners ship their own rustup default, which can be newer than the pin; a cargo subcommand such as clippy then compiles with it, and two compilers sharing `target/` fail with E0514. The toolchains action makes the `.prototools` pin rustup's default for the whole job, so keep that step when changing CI.

## Testing

`moon run :test` runs every project's tests. Rust tests live beside the code they cover; the compiler's golden-file tests assert the `apm.yml` shape and are what catch an APM change. Regenerate goldens with `SHELFKIT_UPDATE_GOLDEN=1 cargo test --package <crate>` and review the diff. The compiler's plans are parsed by `CompilePlanSchema` in `packages/schema`, and `packages/engine` checks that the WASM module returns `shelfkit compile --dry-run --json` byte for byte. The tests that run `apm install` (on a compiled manifest, and from `shelfkit serve`) skip without an `apm` on `PATH`; `SHELFKIT_TEST_APM_UVX=1` runs them through the pinned `uvx`. The registry conformance suite (`crates/registry/conformance/cases.json`) runs against the library, the `shelfkit serve` binary, and the WASM engine; regenerate its archives with `SHELFKIT_UPDATE_CONFORMANCE=1 cargo test --package shelfkit-registry` and review the diff. Prefer a test that fails for a real reason over one that restates the implementation: the revision test for CRLF normalization caught a genuine hashing bug before the first commit.
