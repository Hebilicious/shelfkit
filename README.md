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
  registry/    the OpenAPM Registry HTTP API, shared by `shelfkit serve` and the Worker
  wasm/        the crates as a WebAssembly module
packages/
  engine/      the typed port over the WebAssembly module
  schema/      boundary validation shared by the Worker and the CLI
  tokens/      CSSForge design tokens
shelf/         ShelfKit's own shelf, describing how ShelfKit is built
docs/          the PRD
```

The Rust crates are the product. Everything else is a client of them, and they compile native for the CLI and to WASM for the Worker so the browser preview and the CLI cannot disagree about what a profile compiles to.

## Development

Node, pnpm, moon, uv, and Rust all come from [proto](https://moonrepo.dev/proto), pinned in `.prototools`, with `moon setup` installing them. Tasks are orchestrated by [moon](https://moonrepo.dev); there are no npm scripts, so `moon query tasks` is the list of things you can run.

```bash
moon setup             # install every pinned toolchain
pnpm install           # install workspace dependencies
moon run :build        # build every project
moon run :check        # lint and typecheck every project
moon run :test         # test every project
moon run web:dev       # run the SPA
moon run worker:dev    # run the Worker locally
moon run worker:setup  # provision a Cloudflare account and deploy
```

`moon run :build` and friends run a task in every project that defines it. `moon query tasks` lists every task.

## A shelf as a registry

`shelfkit serve` publishes every profile of a shelf as `{registry.namespace}/{profile}` and serves the OpenAPM Registry HTTP API on `http://127.0.0.1:7878`, in memory. APM installs from it with its experimental registry client:

```bash
shelfkit --shelf shelf serve           # prints the apm.yml lines that install each profile
apm experimental enable registries     # once, in APM's own configuration
apm install                            # in a repository whose apm.yml declares the printed registry and id
```

A profile publishes at its `version`, or at `0.0.0+sha256.<profile revision>` when it has none, and a version is immutable. APM sends no credentials over plain http, so it installs only from a public shelf on loopback. Without the flag, `shelfkit compile` and `apm install` take the Git and vendored path.

## Self-hosting

One Worker on Cloudflare, with a Durable Object per shelf, R2 for content, and a queue for imports. Workers Paid is the floor (Queues need it).

```bash
pnpm install
moon run worker:setup                           # R2, queues, owner key, session secret, deploy, /health, your browser
moon run worker:setup -- --keychain             # the same, handing a new owner key to `shelfkit login` instead of printing it
moon run worker:setup -- --github-sign-in       # also let people sign in with GitHub (creates a GitHub App)
```

Setup is a moon task, not `pnpm setup`: `pnpm setup` is pnpm's own built-in command, and this repository has no npm scripts. Wrangler is the only deployment path. Setup is idempotent: run again, it creates nothing that exists and keeps the owner key (`--rotate-owner-key` replaces it) and the session secret (`--rotate-session-secret`, which signs every browser out). Pass `CLOUDFLARE_ACCOUNT_ID` when Wrangler can reach more than one account.

It creates, in order: the R2 bucket `shelfkit-blobs`, with a bucket lock that retains everything under `archives/` indefinitely (published registry archives, addressed by `sha256`, so a published version cannot be overwritten or deleted at the storage layer; file contents under `objects/` are not locked); the queues `shelfkit-jobs-dlq` and `shelfkit-jobs`; the owner key, of which the Worker keeps only the SHA-256 as the secret `OWNER_KEY_HASH`; the session secret `SESSION_SECRET`; and the deploy, which creates the Durable Object namespaces and applies their migrations. A new owner key is shown once and stored nowhere else. Every secret is set after the deploy with `wrangler secret put`, on its standard input, so none is ever written to a file; until then the Worker authenticates nobody. If Wrangler cannot list the Worker's secrets for a reason other than the Worker not existing yet, setup stops instead of replacing them.

### Signing in

People sign in to the web UI with passkeys; nobody pastes a key into a browser.

1. Setup ends by opening a one-time **sign-in link** for the owner in your browser. It prints the link only when it could not open one, or with `--no-open`. It works once, within 15 minutes, and signs that browser in as the owner. The page offers to **add a passkey** on that device: your browser's or system's password manager, a password manager's extension, or a security key keeps it. Then "Sign in with a passkey" signs you back in.
2. On another device, open Settings on a signed-in one and "Make a sign-in link", or run `shelfkit open` on a machine whose keychain holds the owner key (`shelfkit login`). Either opens that device signed in, and it adds its own passkey. A rerun of setup that kept the owner key cannot make a link; it tells you to run `shelfkit open`.
3. To let someone else in, **invite** them from a shelf's Settings ("People"): their name and the scopes they hold on that shelf, the same scopes a key has. The invite is a link, used once within 7 days. They open it, add a passkey, and are in. "Remove access" ends their grant on that shelf at their next request; "Remove the person" removes their access on every shelf, deletes their passkeys, and signs them out, closing any live view they have open.

A link opened in a browser signed in as someone else asks first, naming both accounts, before it switches.

On Linux, a browser needs a passkey provider: its built-in password manager, a password manager's extension, or a hardware key. A device without one still signs in with a link.

The session cookie names who signed in and holds no key; sessions last 30 days, and rotating the signing secret (`--rotate-session-secret`) signs every browser out. Passkeys live in one Durable Object per person (the owner's and each invited person's); grants live in each shelf's object; nothing is shared across them.

### Signing in with GitHub (optional)

`moon run worker:setup -- --github-sign-in` also lets people sign in with GitHub. Setup records the owner's GitHub account by numeric id (`gh api --hostname github.com user`, printed before it is recorded; `--github-owner <login>` names another), and after the deploy it creates the deployment's own GitHub App through GitHub's app-manifest flow:

1. Setup prints a `http://127.0.0.1:<port>/` address and opens it. The page holds the app's manifest: no repository or organization permissions, no webhook, and a callback `https://<address>/auth/github/callback` for every `https:` address Wrangler reports for the deployment, which is its workers.dev address (Wrangler reports routes and custom domains without a scheme, and cron and queue triggers alongside them; none of those is registered). The page answers only on that address, once.
2. "Continue to GitHub" posts the manifest to github.com (`--github-org <org>` creates the app under an organization). Click **Create GitHub App**. GitHub may ask you to change the name if it is taken.
3. GitHub sends the browser back to the local page with a code. Setup converts it, sets the app's client id and secret as the Worker secrets `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and keeps nothing else: the app's private key and webhook secret are never written anywhere.

GitHub sends the browser back only to a registered callback. A custom domain added after setup needs its `https://<domain>/auth/github/callback` added in the app's settings (Settings, Developer settings, GitHub Apps, your app, "Callback URL"); a GitHub App holds up to ten. The app is public so that the accounts you grant access can authorize it; installing it grants nothing. Instead of the app, you can create a GitHub OAuth App by hand with the same callback URL and set its two values with `wrangler secret put GITHUB_CLIENT_ID` and `wrangler secret put GITHUB_CLIENT_SECRET`; setup then finds them and skips the app (`--recreate-github-app` makes a new one). A rerun of setup without the flag leaves GitHub sign-in as it is; `moon run worker:setup -- --no-github-sign-in` turns it off by deleting its three secrets, which ends every GitHub session (the owner's included) at its next request and makes GitHub accounts' grants hold nothing. Delete the GitHub App on github.com too.

The owner's GitHub account signs in as the owner. Others hold what you grant their GitHub account in a shelf's Settings. The Worker uses GitHub's token once to learn who signed in, then revokes it, and looks logins up with the app's client id and secret (GitHub documents that for OAuth apps as 5,000 requests an hour instead of 60 per IP address); if GitHub runs out, the grant says until when.

### A hosted shelf is a Git repository

Each shelf is the repository `https://shelfkit.<you>.workers.dev/git/<shelf>.git`, and Git is the one way a checkout's files reach it. The owner's first push creates the shelf; an edit in the UI is a commit you pull; a push the engine cannot load is shown on the shelf with its errors and leaves the shelf as it was.

```bash
shelfkit login https://shelfkit.<you>.workers.dev   # approve it in your browser; the key goes to the OS keychain
git push https://shelfkit.<you>.workers.dev/git/<shelf>.git main
shelfkit publish                                    # publish every profile to the deployment's registry
shelfkit open                                       # open the web UI in your browser, signed in as you
```

`shelfkit login` shows a code and opens the deployment's approval page: sign in there, check the page shows the same code as your terminal, and approve. The CLI then holds a key that acts as you (the owner, or what each shelf grants you), listed under "CLI sign-ins" in Settings, where revoking it signs that CLI out. Approve only a code you see in your own terminal. In CI, or with `--key`, it reads a key made in Settings from standard input instead.

Git asks for a user name and a password the first time it reaches the deployment: any user name, and a key as the password, which your credential helper keeps. A program gives Git the key as a header, through the environment rather than its command line:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Bearer $SHELFKIT_KEY" git push "$SHELFKIT_URL/git/<shelf>.git" main
```

**A shelf that is a repository of its own** has the deployment as a remote:

```bash
git remote add shelf https://shelfkit.<you>.workers.dev/git/<shelf>.git
git push shelf main    # what you committed
git pull shelf main    # edits made in the UI, and other people's pushes
```

A push that does not fast-forward is refused, as on any Git host: pull first. A shelf that also lives on GitHub has two remotes, like any mirrored repository.

**A shelf inside a larger repository** is a submodule of its hosted repository. The larger repository records which commit of the shelf it uses, and the shelf's history, the UI's edits included, stays in the shelf's repository:

```bash
git submodule add https://shelfkit.<you>.workers.dev/git/<shelf>.git shelf
git commit -m "The shelf, as a submodule"

git -C shelf pull                                       # edits made in the UI
git -C shelf commit -am "Tighten the review prompt"     # edits made here
git -C shelf push origin HEAD:main
git commit -am "The shelf, updated"                     # the larger repository moves to that commit
```

A clone of the larger repository gets the shelf with `git clone --recurse-submodules`, or `git submodule update --init` afterwards; a private shelf asks for a key there as well.

To turn a directory that is already in a larger repository into its own shelf, with its history:

```bash
git subtree split --prefix=shelf -b shelf-history       # the directory's commits, as a branch of their own
git push https://shelfkit.<you>.workers.dev/git/<shelf>.git shelf-history:main
git rm -r -q shelf && git commit -m "The shelf moves to its own repository"
git submodule add https://shelfkit.<you>.workers.dev/git/<shelf>.git shelf
git commit -m "The shelf, as a submodule"
git branch -D shelf-history
```

The push creates a shelf that does not exist yet. For one that exists already, bring its history into the branch first: `git switch shelf-history && git pull --no-rebase --allow-unrelated-histories <url> main`, resolve, and push.

`shelfkit publish` is separate from Git: it packages each profile exactly as `shelfkit serve` does and publishes it to the deployment's registry at its `version`, or `0.0.0+sha256.<revision>.format<N>` without one. A published version is immutable, so a changed profile with a `version` needs a new one before it publishes again.

A profile then installs from the deployment with APM's registry client: `registries: { shelf: { url: https://shelfkit.<you>.workers.dev/apm } }` in `apm.yml`, the dependency `{ id: <namespace>/<profile>, version: <version> }`, and `apm experimental enable registries`.

Keys are for programs: the CLI, agents, CI, and APM's registry client, which need a bearer token. They are managed over GraphQL (`createKey`, `revokeKey`) and in Settings, with the registry's scopes: `read`, `read:{shelf}/{profile}`, `publish:{shelf}/{profile}`, `publish:{shelf}/*`, plus `mcp:{shelf}/{item}` for the MCP relay. A key works on the registry, GraphQL, and `/mcp` alike, and a revoked one fails on all three at once. A browser never holds a key; people sign in with passkeys.

File contents no commit takes (from a push the engine refused) stay in `objects/` and are never served: `/raw` serves only objects a committed snapshot names. Removing them is a follow-up: objects are shared by hash across a deployment's shelves, so a sweep must know that no shelf references an object before it deletes it, and there is no cross-shelf query to ask. The plan is per-shelf reference records in R2 (`refs/<sha256>/<shelf>`), written at commit, which a cron sweep reads before deleting an unreferenced object older than a day.

To tear a deployment down: `wrangler delete shelfkit`; `wrangler queues delete shelfkit-jobs` and `shelfkit-jobs-dlq`; `wrangler r2 bucket lock remove shelfkit-blobs --id archives-immutable` (and `--id objects-immutable` on a deployment set up before the lock moved), empty the bucket, and `wrangler r2 bucket delete shelfkit-blobs`.

## Conventions

- One Durable Object per shelf, with its own SQLite database. No D1, no cross-shelf query.
- Item content is content-addressed in R2 by `sha256`; databases hold metadata only.
- `shelfkit compile` writes `apm.yml` and stops. `shelfkit install` runs APM, resolved from the path or through a pinned `uvx`.
- Never parse human-oriented `apm` output.

## License

MIT
