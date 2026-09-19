# ShelfKit

A registry and curation layer for AI agent context, built on [APM](https://github.com/microsoft/apm) and [OpenAPM](https://microsoft.github.io/apm/specs/openapm-v01/).

A **shelf** is a Git repository of selected context: skills, prompts, instructions, agents, hooks, plugins, MCP servers, LSP servers, libraries, and tech stacks. A **profile** is a named selection from a shelf. Compiling a profile writes an `apm.yml`, which `apm install` turns into a configured repository.

ShelfKit does three things APM does not:

1. **Registers.** It serves an OpenAPM-conformant registry, so a shelf is installable through APM's own resolver.
2. **Hosts.** A self-hosted service on Cloudflare with a web UI for browsing, composing, and copying, plus an MCP endpoint so an agent can pull context with no shell.
3. **Serves MCP definitions.** It tells an agent which MCP servers exist and how they are configured, and the agent runs them in its own environment. ShelfKit never runs a stateful MCP server.

APM is the installer. ShelfKit is the shelf.

**Read [`docs/PRD.md`](docs/PRD.md) before writing code.** It is short by design and it is the source of truth for scope.

## Layout

```
apps/
  worker/      Cloudflare Worker: registry, MCP, GraphQL, static assets
  web/         Vue 3 SPA
crates/
  core/        the shelf format: loading, validation, revisions, resolution
  compiler/    profile to apm.yml, plus the `shelfkit` binary
packages/
  schema/      boundary validation shared by the Worker and the CLI
  tokens/      CSSForge design tokens
shelf/         ShelfKit's own shelf, describing how ShelfKit is built
docs/          the PRD
```

The Rust crates are the product. Everything else is a client of them, and they compile native for the CLI and to WASM for the Worker so the browser preview and the CLI cannot disagree about what a profile compiles to.

## Development

Node, pnpm, moon, and uv are pinned in `.prototools` and installed by [proto](https://moonrepo.dev/proto). Rust is rustup's business rather than proto's: CI installs the pinned channel through `.github/actions/toolchains`, and a local `rustup` install is enough. Tasks are orchestrated by [moon](https://moonrepo.dev); there are no npm scripts, so `moon query tasks` is the list of things you can run.

```bash
proto install          # install node, pnpm, moon, and uv
pnpm install           # install workspace dependencies
moon run :build        # build every project
moon run :check        # lint and typecheck every project
moon run :test         # test every project
moon run web:dev       # run the SPA
moon run worker:dev    # run the Worker locally
moon run worker:setup  # provision a Cloudflare account and deploy
```

`moon run :build` and friends run a task in every project that defines it. `moon query tasks` lists every task.

## Self-hosting

```bash
pnpm install
pnpm setup             # create the R2 bucket and queues, then deploy
```

Wrangler is the deployment path. Durable Object migrations are declared in `apps/worker/wrangler.jsonc` and applied by deploying.

## Conventions

- One Durable Object per shelf, with its own SQLite database. No D1, no cross-shelf query.
- Item content is content-addressed in R2 by `sha256`; databases hold metadata only.
- `shelfkit compile` writes `apm.yml` and stops. `shelfkit install` runs APM, resolved from the path or through a pinned `uvx`.
- Never parse human-oriented `apm` output.

## License

MIT
