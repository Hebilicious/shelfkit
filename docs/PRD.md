# PRD: ShelfKit

**Status:** Draft v3.0
**Last Updated:** 2026-09-19
**License:** MIT
**Repository:** `shelfkit`

---

## 1. What ShelfKit is

ShelfKit is a registry and curation layer for agent context, built on [APM](https://github.com/microsoft/apm) and [OpenAPM](https://microsoft.github.io/apm/specs/openapm-v01/).

A **shelf** is a Git repository of selected context: skills, prompts, instructions, agents, hooks, plugins, MCP servers, LSP servers, libraries, and tech stacks. A **profile** is a named selection from a shelf. Compiling a profile writes an `apm.yml`, which `apm install` turns into a configured repository.

ShelfKit does three things APM does not:

1. **Registers.** It serves an OpenAPM-conformant registry, so a shelf is installable through APM's own resolver, and it indexes and curates from other registries and other public ShelfKit instances.
2. **Hosts.** A self-hosted service on Cloudflare with a web UI for browsing, composing, and copying, plus an MCP endpoint so an agent can pull context mid-session with no shell.
3. **Serves MCP.** It can host MCP servers itself and expose them under one endpoint, covering the local ones no registry can describe.

**APM is the installer. ShelfKit is the shelf.**

### How to read this document

It is deliberately short. Where a decision needs a specific version, a limit, or a wire format, the detail lives in the artifact that owns it: the OpenAPM schemas for the manifest, the Registry HTTP API for the registry routes, and the Cloudflare and library documentation for platform constraints. This document states intent and boundaries so an implementer is not locked into a mechanism that will move.

---

## 2. Principles

1. **Build on APM, never beside it.** The only manifest in a target repository is `apm.yml`. No ShelfKit-specific repository state, no second lockfile, no parallel format.
2. **The shelf is a Git repository.** Portable, diffable, reviewable, and readable with nothing installed.
3. **Pinned by default.** Every compiled reference is a resolved revision. Reproducibility is the point of compiling rather than copying.
4. **A thin slice.** No organizations, no roles, no policy engine. A shelf has an owner and optional read-only links.
5. **A published contract is a dependency, not a reimplementation.** Manifest validation uses OpenAPM's published JSON Schemas. Registry serving uses OpenAPM's Registry HTTP API.
6. **Everything is curated or copied, never generated.** ShelfKit assembles; it does not invent conventions.

---

## 3. Relationship to APM

| Concern | Owner |
|---|---|
| Manifest, lockfile, transitive resolution | APM |
| Dependency resolution and install across harnesses | APM |
| Policy (`apm-policy.yml`) | APM |
| Drift detection (`apm audit`) | APM |
| Registry protocol for serving packages | **ShelfKit** (implements OpenAPM's Registry HTTP API) |
| Curation, profiles, and composition | **ShelfKit** |
| Hosting, browsing, sharing | **ShelfKit** |
| MCP-native discovery and hosting | **ShelfKit** |

APM publishes OpenAPM v0.1 with JSON Schemas and a self-contained [Registry HTTP API](https://microsoft.github.io/apm/reference/registry-http-api/) written for server implementers, and APM ships a registry client behind an experimental flag.

One correction to the obvious framing, because it matters for what ShelfKit can honestly claim: **v0.1 is an editor's working draft, and it reserves the Registry conformance class for v0.2.** It states that a conforming Consumer must not claim normative Registry conformance against v0.1, and it carries the registry HTTP API as non-normative in that revision. So ShelfKit implements the documented wire contract, which APM's client consumes today, and claims **Producer** conformance, which v0.1 does define. It does not claim Registry conformance, and it moves to claim it when v0.2 defines it.

The manifest key `lsp` is in the CLI and the working draft but absent from the published v0.1 JSON Schema, so the PRD treats it as an unratified surface rather than a conformant one.

### 3.1 What ShelfKit compiles

```yaml
# apm.yml, written by `shelfkit compile`
name: my-cool-app
version: 1.0.0
targets: [copilot, claude, cursor, codex]      # APM's own target slugs
registries:
  acme:
    url: https://shelf.acme.dev/apm
  default: acme
dependencies:
  apm:
    - anthropics/skills/skills/frontend-design
    - id: acme/team-conventions          # from the registry above
      version: ^1.2.0
    - ./vendor/local-conventions         # compiled from shelf-authored items
  mcp:
    - name: io.github.upstash/context7
      transport: http
```

Three things worth noting. A ShelfKit instance can be declared as a **registry**, with `default` as a sibling key rather than a per-entry field, so a shelf is installable by stock APM without the ShelfKit CLI installed. Registry-routed dependencies use the object form with `id` and `version`, since a version selector is not a Git ref. And shelf-authored items compile into a local `.apm/` package under `vendor/`, because that is APM's layout for "N independent primitives" and it is exactly what those items are.

Two parser rules the compiler must respect, because getting either wrong produces a manifest APM rejects. A Git pin is `#<ref>` and nothing else, where the ref is a tag, branch, or commit. That object form also accepts a semver range in `ref:` resolved against remote tags. `@` is never a ref separator, though it may appear inside a literal ref.

Registry URLs are `https://` by requirement, and plain `http://` is refused unless the host is loopback or an RFC 1918 private address, or the dependency explicitly opts into insecure transport. That private-range allowance is what lets a self-hosted `shelfkit serve` run on a LAN or a laptop without a certificate.

---

## 4. Client architecture

APM is a Python program, published as `apm-cli` on PyPI and as per-platform PyInstaller binaries. ShelfKit's CLI is Rust. **They are separate binaries, and ShelfKit never embeds a Python runtime.**

| Question | Decision |
|---|---|
| Rust client, or reimplement APM? | Rust client. Install, resolution, and lockfile writing stay APM's job. |
| Wrap the Python CLI? | No. Wrapping it adds a parser for human-oriented output and buys nothing the published schemas do not already give us. |
| Bundle APM? | No. A vendored interpreter is a maintenance trap. |
| Depend on APM being installed? | **No.** ShelfKit resolves APM in this order: `apm` on the path, then a version-pinned `uvx --from apm-cli apm`, then an offer to install nothing and stop with instructions. `uv` is a single self-contained binary, so this gives a working install without a global Python 3.10+ or a `pip install`. |
| Does ShelfKit run APM for the user? | Yes, when asked. `shelfkit install` resolves the APM runner, executes it with the flags the profile compiled to, and reports the result. `shelfkit compile` never invokes APM. |
| What exactly gets executed? | `uvx --from apm-cli==<pinned> apm <args>`, or `apm <args>` when the binary is present. The command is printed before it runs, and `shelfkit doctor` shows which runner it would pick. |
| What if `uv` is missing too? | `doctor` reports all three states, and `install` fails with the exact command for the user's platform. ShelfKit does not silently install a package manager. |
| How does Rust validate an `apm.yml`? | Against OpenAPM's published JSON Schema, compiled into the binary. It does not re-implement APM's parser. Note the schema URL in the reference docs (`manifest-v0.1.41.schema.json`) is a 404; `manifest-v0.1.schema.json` is the one that resolves. |
| How does ShelfKit talk to APM? | By writing files APM reads, and by serving a registry APM fetches. |
| Can ShelfKit get structured output from APM? | Partly, and the limits matter. `apm audit -f json`, `apm deps why --json`, `apm pack --json`, `apm policy status --json`, `apm targets --json`, and `apm lock export` all emit structured data. **`apm install`, `apm update`, `apm lock`, `apm list`, `apm view`, and `apm search` have no structured mode**, so they are driven by exit codes and by reading `apm.lock.yaml` afterwards. ShelfKit therefore never parses human-oriented stdout. |
| Who writes the lockfile? | APM, always. `apm lock` resolves and writes `apm.lock.yaml` without deploying anything, which is exactly the boundary ShelfKit wants: it writes the manifest, then optionally tells the user to run `apm lock`, and reads the result. |

ShelfKit pins the APM version it runs through `uvx`, so the runner is reproducible even when the user has no APM installed. When an `apm` binary is already on the path, ShelfKit checks it against the supported range and warns rather than overriding it.

One consequence to accept: because APM owns install, **an APM breaking change is a ShelfKit breaking change**. The defence is that the compiler's golden-file tests generate manifests, validate them against the published schema, and assert the `apm.yml` shape.

### 4.1 The Rust CLI

`packages/compiler` and `packages/core` are Rust crates with no Cloudflare dependency, compiled to a single static binary. The same crates are compiled to WASM for the Worker, so the browser preview and the CLI cannot disagree about what a profile compiles to.

| Command | Purpose |
|---|---|
| `shelfkit init` | Scaffold a shelf |
| `shelfkit add <source>` | Import items from a git repo, an APM registry, a catalog, a marketplace, or another shelf |
| `shelfkit search <query>` | Search the shelf, and optionally federated sources |
| `shelfkit serve` | Run a shelf locally as an OpenAPM registry |
| `shelfkit compile` | Write `apm.yml` and vendored content |
| `shelfkit install` | Run APM, resolved from the path or through `uvx`, with the compiled flags |
| `shelfkit check` | Validate the shelf: schemas, coordinates, references, unratified keys, target conformance |
| `shelfkit verify` | The manifest still matches the profile it came from |
| `shelfkit recommend` | Propose items and profiles from detected stack markers |
| `shelfkit doctor` | Detect `apm`, harnesses, and source drift |
| `shelfkit login` / `push` | The hosted service |

---

## 5. Shelf format

```
my-shelf/
├── shelf.json
├── profiles/
│   ├── default.json
│   └── vue-cloudflare.json
├── items/
│   ├── skills/            # SKILL.md per skill
│   ├── prompts/           # prompt.md
│   ├── instructions/      # AGENTS.fragment.md
│   ├── agents/            # agent.md
│   ├── hooks/             # hook.json
│   ├── plugins/           # plugin.json (Agent Plugins v1)
│   ├── mcp/               # server.json, or a self-hosted definition
│   ├── libraries/         # library.json
│   ├── stacks/            # stack.json
│   └── lsp/               # lsp.json
├── compiled/              # optional, checked in, generated
│   └── vue-cloudflare/apm.yml
└── README.md
```

Ten kinds, mapped to APM in §6. `items/` is the source of truth; there is no generated index file, because two sources of truth for the same data is the failure mode the format exists to avoid.

Item `targets` use APM's slugs verbatim, and `apm targets --json` is the authority for which exist. There is a wrinkle worth stating because it constrains the compiler: **the v0.1 producer rules fix a smaller canonical set** than the CLI supports (roughly `copilot`, `claude`, `cursor`, `codex`, `gemini`, `antigravity`, `opencode`, `windsurf`, `agent-skills`, `all`), and require a producer to reject anything outside it. The CLI additionally supports `kiro`, `grok-build`, `hermes`, and others, and it rejects `intellij` in a manifest outright.

So the compiler emits the canonical set by default, treats CLI-only targets as an explicit opt-in that makes the manifest Producer-nonconformant, and `shelfkit check` says so rather than silently producing a manifest a conforming producer would reject.

### 5.1 Manifest

```json
{
  "$schema": "https://shelfkit.dev/schemas/shelf.json",
  "name": "hebi-shelf",
  "owner": "Hebilicious",
  "description": "Agent context for Vue, Cloudflare, and Rust work",
  "defaultProfile": "default",
  "registry": { "namespace": "hebilicious", "public": true },
  "sources": [
    { "id": "anthropics", "kind": "git", "repo": "https://github.com/anthropics/skills" },
    { "id": "acme", "kind": "apm-registry", "url": "https://shelf.acme.dev/apm", "tier": 1 },
    { "id": "sam", "kind": "shelfkit", "url": "https://shelf.sam.dev", "profile": "frontend" },
    { "id": "clawhub", "kind": "catalog", "url": "https://clawhub.ai/api/v1" }
  ]
}
```

### 5.2 Item kinds

Every item has `id`, `kind`, `title`, `description`, `tags`, and `targets`. An item either **references** something upstream, with provenance and a resolved revision, or is **authored** in the shelf.

A **revision** is an immutable snapshot of one item: `sha256` over a canonical serialization of its directory, with files sorted by path, LF line endings, and timestamps, permissions, and ownership excluded. Two clones of the same shelf therefore produce identical revisions, and a revision is what a profile pins and what a scan verdict attaches to. Item ids are kebab-case and may not contain a double underscore, which is what makes the MCP namespace separator in §8 unambiguous.

#### `skill`
A directory with `SKILL.md`, following [agentskills.io](https://agentskills.io/specification). Only spec frontmatter is used (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), because clients and uploaders reject unknown keys.

#### `prompt`
The highest-value kind in practice, because prompts are what people actually copy and hoard. A prompt is markdown plus variables.

APM treats prompts and commands as one primitive with one source layout, `.apm/prompts/*.prompt.md`, deploying them as commands on the harnesses that have them. ShelfKit follows: there is no separate command kind, and the `prompt` item carries an optional `asCommand` flag for harnesses where it should surface as a slash command.

```json
{
  "id": "pr-description",
  "kind": "prompt",
  "title": "PR description",
  "description": "Write a PR description from the staged diff",
  "asCommand": true,
  "variables": [
    { "name": "ticket", "required": false },
    { "name": "audience", "default": "reviewers" }
  ],
  "tags": ["git", "review"]
}
```

#### `instructions`
Project conventions as structured `sections`, plus `markers` that make a stack detectable. Compiles into an APM `.apm/instructions/` primitive, or into a harness instruction file for the harnesses APM does not cover.

#### `agent`

#### `hook`

#### `plugin`
Agent definition markdown, hook JSON, and an Agent Plugins v1 package respectively.

Two constraints carried over from APM. An agent is a file dependency (`.agent.md`) and can be pinned individually. **A hook cannot**: APM classifies virtual files only by `.prompt.md`, `.instructions.md`, and `.agent.md`, so `.json` never resolves as a file dependency and hooks arrive only through a package. A shelf `hook` item therefore always compiles into the vendored `.apm/hooks/` package rather than a direct reference, and hooks are executable primitives that APM gates behind approval, which the UI states before compile rather than after install.

#### `mcp`
An MCP server, in three flavours:

| Flavour | Shape | Install |
|---|---|---|
| `remote` | URL, transport, auth header reference | `dependencies.mcp` entry |
| `stdio` | `command`, `args`, env references | `dependencies.mcp` entry |
| `hosted` | ShelfKit runs or fronts it; the item carries a URL on the ShelfKit origin | `dependencies.mcp` entry pointing at ShelfKit, or nothing when the agent reaches it through `/mcp` |

`stdio` exists because most MCP servers are local and no registry can describe a working install for them without the command. `hosted` is §8, and it is the exception rather than the default: APM already deploys MCP servers into every harness it targets.

Secret values are references, never literals, and a literal that looks like a credential fails the load.

#### `lsp`
A language server, using APM's `dependencies.lsp` shape: `name`, `command`, and the rest of the documented fields. It exists because a shelf that pins a language's tooling should be able to pin its language server in the same breath, and because LSP deployment differs per harness in ways APM already handles.

One caveat carried into the compiler: `lsp` is present in the CLI and the working-draft manifest but **absent from the published v0.1 JSON Schema**. Because that schema sets `additionalProperties: true`, validation will not flag it, which is worse than a warning: the key passes a v0.1 check while depending on a surface v0.1 does not define. `shelfkit check` reports it explicitly and the compiler notes it in the compile output, rather than relying on schema validation to catch it.

#### `library`
A library or tool the shelf has opinions about. Not a dependency manager: APM handles packages. A library item carries what an agent needs to use it correctly, plus an optional detection marker for `recommend`.

APM has no library primitive, no tech-stack primitive, and no manifest key for either. That is the point of these two kinds: they are the shelf's own vocabulary, and both compile into an APM instructions package, which is the primitive APM does have for "here is how we do things here".

```json
{
  "id": "drizzle",
  "kind": "library",
  "title": "Drizzle ORM",
  "description": "Schema-first ORM. Use the relational query builder, not string SQL.",
  "detect": { "dependencies": ["drizzle-orm"] },
  "docs": "https://orm.drizzle.team/docs/overview",
  "notes": ["Migrations are generated, never hand-written.", "Prefer `db.query` over `db.select`."],
  "tags": ["db"]
}
```

#### `stack`
A tech stack: markers for detection plus the conventions that follow from it.

```json
{
  "id": "vue-cloudflare",
  "kind": "stack",
  "title": "Vue on Cloudflare Workers",
  "markers": {
    "files": ["wrangler.jsonc", "vite.config.ts"],
    "dependencies": ["vue", "wrangler"],
    "packageManager": "pnpm"
  },
  "conventions": [
    { "heading": "Runtime", "body": "Workers. No Node built-ins." },
    { "heading": "Data", "body": "D1. Prepared statements. Migrations in ./migrations." }
  ],
  "recommends": ["vue-sfc-patterns", "context7", "drizzle", "wrangler"],
  "tags": ["vue", "cloudflare"]
}
```

`markers` are what make `shelfkit recommend` work, and they are the difference between a stack item and an instructions item.

### 5.3 Profiles

```json
{
  "id": "vue-cloudflare",
  "title": "Vue on Cloudflare",
  "items": [
    "vue-cloudflare",
    "vue-sfc-patterns@sha256-3f1c…",
    "pr-description",
    "context7",
    "drizzle"
  ],
  "bundles": ["code-quality"],
  "extends": [],
  "compile": {
    "name": "vue-cloudflare",
    "targets": ["copilot", "claude", "cursor", "codex"],
    "pin": "revision",
    "onConflict": "fail"
  }
}
```

- `items` takes `id` (latest) or `id@revision` (pinned). `pin: revision` compiles pinned refs; it is the default. `pin: latest` compiles unpinned refs and is what a personal shelf uses.
- `bundles` names reusable groups of items. A bundle is a named item list with no compile settings, exists so several profiles can share a cluster without repeating it, and is not itself installable. Bundles expand before `extends`.
- `extends` composes profiles breadth-first, children win, cycles are a load error.
- `onConflict` decides what happens when the target repository already declares something equivalent. `fail` stops the compile so a human decides, `shelf-wins` overwrites the local declaration, and `local-wins` keeps it and drops the shelf's. It is not a merge: no partial adoption, because a half-applied convention is worse than either whole one.

---

## 6. How sources map to primitives

A source is anything items can come from. Each source kind has its own discovery rule, and discovery reuses APM's package layouts rather than inventing one.

The fact that shapes this whole section: **`apm.yml` has no per-primitive dependency key.** `dependencies` knows only `apm`, `mcp`, and `lsp`. Instructions, skills, prompts, agents, hooks, commands, and plugins all arrive through a package or virtual-package reference in `dependencies.apm`, and the primitive type is inferred from the fetched layout or from a file extension. MCP servers are the single exception, with their own typed list.

That gives discovery two shapes:

- **Package references** fetch a repo or directory and yield whatever primitives its layout contains.
- **Virtual-package references pin a single file**, using an extension APM classifies: `x.prompt.md`, `x.instructions.md`, or `x.agent.md` is a file dependency. So `github/awesome-copilot/agents/api-architect.agent.md` is a valid, pinned dependency on one agent.

ShelfKit uses both. Importing a repository yields many items; importing one prompt from someone else's repository yields exactly one, with a coordinate that pins the file.

| Source kind | What discovery finds | Becomes |
|---|---|---|
| `git` repo, `.apm/` layout | Typed primitives under `.apm/` | One item per primitive, kind from directory |
| `git` repo, root `SKILL.md` | One skill bundle | One `skill` item, bundled as a unit |
| `git` repo, `skills/<n>/SKILL.md` | N nested skills | N `skill` items, installable individually |
| `git` repo, `hooks/*.json` | A hook bundle | N `hook` items |
| `git` repo, `plugin.json` | A Claude plugin collection **or** an Agent Plugin, depending on `$schema` | N items, or one `plugin` item |
| `git` repo, marketplace with inline `mcpServers`/`lspServers` | Synthesized server definitions | `mcp` items |
| `git` repo, single `*.prompt.md` / `*.instructions.md` / `*.agent.md` at a known path | One file dependency | One item pinned to that path |
| `apm-registry` | Versioned packages via `GET /v1/packages/{owner}/{repo}/versions` | Items whose `apm.coordinate` pins a resolved version and digest |
| `shelfkit` (another instance) | Its public profiles and items | Items re-exported with provenance pointing at that instance |
| `catalog` (MCP registry, Docker, Cline, ClawHub) | Server definitions and skill records | `mcp`, `skill`, and `plugin` items |
| APM marketplace (`marketplace.json`, plain HTTPS or Git) | Catalog entries with server metadata | `mcp` and `plugin` items |
| `path` (local directory) | Anything above | Items with no upstream, marked `local` |

The rule that keeps this coherent: **a shelf never rewrites a package's internal layout.** A skill collection stays a skill collection, a plugin stays a plugin, and the compile step references it as APM would. ShelfKit adds selection, provenance, and pinning on top; it does not restructure what it imported.

Every imported item records the source, the resolved commit or version, the digest, the licence, and the attribution the source requires. **Attribution is data on the item**, not UI copy, because one catalog's terms require a per-record credit with a deep link and two lists are unlicensed or share-alike.

---

## 7. Registers and curates

### 7.1 Serving an OpenAPM registry

`GET /apm/v1/packages/{owner}/{repo}/versions`, `GET .../versions/{version}/download`, and `PUT .../versions/{version}` implement the [OpenAPM Registry HTTP API](https://microsoft.github.io/apm/reference/registry-http-api/). A shelf publishes each profile as a package.

Conformance points that matter:

- **Versions are immutable.** A repeat `PUT` returns `409`. Clients depend on this for the lockfile trust model.
- `sha256:` digests over archive bytes, lowercase hex, `snake_case` field names, and RFC 7807 problem bodies. **Archives are `tar.gz` and `application/gzip` only**: the v0.1 consumer rejects `application/zip`, so serving zip would break the only client. HTTP Basic is accepted as an alternative auth form, and anonymous reads are a server choice that ShelfKit enables for public shelves.
- Bearer authentication with the `read`, `read:{owner}/{repo}`, `publish:{owner}/{repo}`, and `publish:{owner}/*` scopes. The same key is the ShelfKit API key.
- Public shelves serve anonymous reads.

APM's client side of registries is behind `apm experimental enable registries`. ShelfKit documents that, and the Git-repo path works today without it.

### 7.2 Curating from other registries and shelves

ShelfKit is not a silo. A shelf can subscribe to:

- another **ShelfKit instance**, importing a public profile and re-exporting it with provenance and a pin;
- an **APM registry**, resolving packages through the same protocol it serves;
- a **plain Git repo**, discovering primitives through APM's package layouts;
- a **catalog** (official MCP registry, Docker, Cline, ClawHub, awesome-copilot), importing server definitions and skill records with licence metadata.

Imports are pinned to a resolved commit, version, or digest, and the UI shows drift when upstream moves. Curation is then a local act on imported material: rename, tag, bundle, exclude, or override the description, without rewriting the artifact.

---

## 8. The MCP endpoint

ShelfKit runs an MCP endpoint at `/mcp` so an agent can use a shelf without a shell. Almost all of it is ShelfKit's own stateless tools. The one addition is a relay for a remote server whose credential should not be copied into every client config, and that relay is argued for carefully below because the pattern has a real failure mode.

**ShelfKit's tools.** `shelf_search`, `shelf_recommend`, `shelf_get_profile`, `shelf_get_item`, and `shelf_plan_compile`, which returns the `apm.yml` that would be written plus vendored files and the install command. `shelf_plan_compile` never mutates anything: ShelfKit plans, the agent applies, APM installs. Each call reads from a Durable Object or R2 and returns, holding nothing between calls.

**The relay, and why it is not a gateway.** A shelf can list a remote MCP server and declare that ShelfKit relays it. This is not a general aggregation layer: ShelfKit does not host several servers behind one endpoint as a convenience, and it never hosts a local one. What the relay buys is one holder for a credential, and §8.1 explains the hazard that comes with it.

### 8.1 Why the relay is not a transparent proxy

ShelfKit targets MCP spec revision **2026-07-28**, which is stateless: sessions and `Mcp-Session-Id` were removed along with the initialize handshake and the GET stream. That simplifies the transport considerably, and it retires a class of proxy bug that older gateways hit when they dropped session headers.

What did not go away is the aggregation problem. Docker's MCP gateway shipped a security advisory for **tool-name shadowing across aggregated servers**, where two backends offering a tool with the same name let one impersonate the other, last writer wins. The specification itself addresses this: an aggregating proxy SHOULD implement a disambiguation strategy such as prefixing tool names with a server identifier, and `serverInfo.name` is explicitly not unique. Rule 1 below is that guidance taken literally.

There is a structural reason this is fragile, not just an implementation detail. Aggregating N backends behind one connection means the client holds one authorization relationship while the gateway holds N. Whatever credential the client presents authenticates it to the *gateway*, not to each upstream, so the gateway becomes an ambient authority that can reach everything it knows about. That is a confused deputy, and no amount of careful implementation makes it disappear.

So ShelfKit does not pretend to be transparent. Four rules:

1. **Every hosted tool is namespaced by its owning item**, as `<item>__<tool>`, and item ids may not contain `__`, which makes the separator unambiguous rather than merely unlikely to collide. Names are length-checked, since MCP asks for tool names of 128 characters or fewer.
2. **A key grants access to declared items, not to everything the shelf knows.** Hosting is opt-in per item and per key, and the endpoint's tool list is computed from the key, so an agent cannot discover a backend it was not granted.
3. **ShelfKit's own tools are never merged into a backend's namespace**, and a hosted backend can never claim a `shelf_*` name.
4. **Credentials belong to the item, not to the caller.** ShelfKit injects a credential it holds, which is the only reason the relay exists. Role-based scoping also keeps the ambient authority small: a key reachable by a relayed server sees that server's tools and nothing else.

### 8.2 What is relayed, and what is not

| Item flavour | Default | What ShelfKit does |
|---|---|---|
| `remote` | Not hosted | The `dependencies.mcp` entry is compiled and APM writes it into each harness's config. Direct client-to-server is better than a hop through ShelfKit whenever it is possible. |
| `remote`, hosted | Opt-in | Proxies with credential injection and namespacing, for servers whose token the user does not want in every client config. |
| `stdio` | Never hosted | The command is compiled into client config and the agent runs it. See §8.3. |
| ShelfKit's own tools | Served | Stateless tools on the Worker or a Durable Object, never namespaced with a backend. |

The row that matters most is the first one. APM already deploys MCP servers into every harness it targets, so a gateway is not the primary way an agent gets an MCP server. It exists for one narrow case: a remote server whose credential should live in one place rather than in every client config.

### 8.3 ShelfKit does not run servers

This is a boundary, not a roadmap gap. **ShelfKit never runs a stateful MCP server and never will.** No containers, no bridge processes, no long-lived child processes, no stdin plumbing.

The reasoning is that the capability is not worth owning. An MCP `stdio` server is a local process: the agent runs it, on the machine where its files and credentials already are. Putting ShelfKit in the middle of that means operating someone else's process, on someone else's behalf, with someone else's credentials, forever. The value is negative, because the agent can already do it, and the failure modes are all ShelfKit's.

What ShelfKit does instead:

| Need | What happens |
|---|---|
| An agent wants an MCP server | The item compiles into `dependencies.mcp`, APM writes the harness config, and the client runs the server itself. This is the normal path and it covers `stdio` and remote alike. |
| An agent has no local process | It calls `shelf_search` and `shelf_plan_compile` to learn what to configure, and the orchestration layer it runs on starts the process. |
| ShelfKit wants to expose its own capability | It adds a **stateless tool on the Worker or a Durable Object**: search, read an item, resolve a profile, compile a manifest. Request in, answer out. |
| A remote server needs a credential it should not hand out | The hosted remote variant in §8.2 relays the call and holds the credential. It owns no process and keeps no session. |

The published `hosted` flavour for `stdio` items is gone. Those items are `stdio`: the shelf distributes the definition, and the agent runs the process. That is also the honest reading of what an agent wants, which is to be told which MCP servers exist, what they are for, and how they are configured, and then to run them in its own environment where the tools they need actually live.

Every MCP tool ShelfKit serves is therefore stateless by construction: it reads from a Durable Object or R2, returns a result, and holds nothing between calls. That is what the current spec revision expects, and it is also the only kind of MCP surface a Worker can serve well.

---

## 9. Web UI

Vue 3, Vite, Vize, CSSForge. Everything goes through the same API as the CLI.

| Screen | Purpose |
|---|---|
| **Shelf** | Inventory. Search, filter by kind and tag, bulk-select into a profile. |
| **Prompts** | The prompt library, treated as a first-class surface rather than a filtered list. |
| **Item** | Rendered content, revisions and diffs, provenance, reverse dependencies, the APM coordinate. |
| **Compose** | Build a profile: drag items in, watch resolution and conflicts, see the `apm.yml` update live. |
| **Compile** | Pick a profile and repository, read the manifest, copy the install command. |
| **Import** | Paste a repo, registry, catalog, or shelf URL; pick items; set pins. |
| **Activity** | Which repositories compiled which profile revision, and what is stale. |
| **Settings** | API keys, sources, secret names, registry visibility. |

### 9.1 The prompts screen

Prompts are the most-used kind and deserve more than a list, because the actual job is "get this prompt into my clipboard or my agent, now."

- **Copy, with variables.** A prompt with variables renders a small form in the detail pane; filling it produces the final text and copies it. Variables have defaults and can be marked required.
- **Copy for a harness.** One click copies the prompt as a skill (`SKILL.md` with frontmatter), as a slash command, or as plain text.
- **Favourites and recents**, stored per key so the list opens on what is actually used.
- **Full-text search over prompt bodies**, since that is how people find the prompt they half-remember.
- **Editing in place**, with revision history. A prompt is short enough that the list, the editor, and the preview fit on one screen.
- **Import from anywhere**, because prompts are collected from chats, docs, and other people's shelves.

### 9.2 The composer

The composer is the profile editor: a three-pane screen with the item inventory on the left, the profile in the middle as an ordered, grouped list, and a live resolution rail on the right showing resolved items, unpinned items, conflicts by severity, and the resulting APM coordinates. Underneath, a `apm.yml` preview updates as items move, so the authored selection and the compiled output are visible at the same time. A stack-marker tester takes a sample `package.json` and reports which stacks match.

---

## 10. Architecture

```
Cloudflare Worker  (single deployable)
  /apm/v1/*      registry wire contract
  /mcp           MCP tools
  /graphql       API for the UI and the CLI, including key management
  /*             static SPA

  Resolver (Rust/WASM)   Importer   Registry
        │
   Durable Object per shelf (SQLite)        R2              Queues + Cron
   items, profiles, revisions, scan records content by hash imports, upstream checks
```

### 10.1 Storage

**One Durable Object per shelf, with its own SQLite database, accessed through Drizzle.** Items, profiles, revisions, and scan records live in the shelf's object. Content lives in R2 keyed by `sha256`, so no database ever holds a blob.

A shelf is the natural boundary: every read and write in the product happens in the context of one shelf, publishing a revision is a local transaction rather than contention on a shared database, and Drizzle supports `drizzle-orm/durable-sqlite` officially. Storage is also cheaper per gigabyte than D1.

Four consequences to accept, all of them real:

- **Every query is a round trip to a named object**, so the API layer batches work into single object methods rather than issuing many small calls.
- **A shelf is single-threaded and pinned to one location**, with a soft ceiling around 1,000 requests per second for a pass-through object and considerably less for one doing work. A hot shelf is bounded by its object.
- **There is no cross-object query of any kind.** No join, no global index, no cross-shelf transaction. This is the constraint that shapes the next paragraph.
- **Migrations run inside the object at runtime**, in the constructor behind `blockConcurrencyWhile`, because there is no CLI path to a Durable Object's SQLite. `PRAGMA user_version` is unsupported, so schema versioning is explicit. **The cap is 10 GB per object**, not per class, so capacity scales with shelf count. A full object fails writes with `SQLITE_FULL` while reads and deletes keep working, which is why the shelf reports its own storage usage instead of waiting to discover the ceiling.

#### Search is per shelf

There is no cross-shelf index and no D1 database. Search covers the shelf you are in, which is the only shelf the service holds.

This is a deliberate limit, not a missing feature. The product is a shelf you own, not a directory of everyone's shelves, and a global index would be the beginning of a marketplace the principles rule out. Reaching someone else's shelf is an explicit act: you add it as a source, and ShelfKit reads it on demand and imports what you choose. Nothing is mirrored, nothing is indexed behind your back, and no query spans shelves.

A useful side effect is that removing D1 removes a second datastore, a second migration mechanism, and the consistency problem of keeping a derived catalog in step with objects. The service has exactly one place where shelf data lives.

### 10.2 API

GraphQL Yoga with Pothos, served over HTTP and over SSE for subscriptions. The registry, MCP, and raw-artifact routes stay plain fetch handlers, because their wire formats are fixed by a spec.

The Rust resolver compiles to WASM and runs in the Worker, so the preview in the browser, the `compile --dry-run` in the CLI, and the server's own resolution all execute the same code.

Subscriptions work: a Durable Object per shelf already exists, so it fans out changes to connected clients over SSE or a hibernating WebSocket, and Queues carry work that outlives a request. Polling with `ETag` is the fallback, not the design.

### 10.3 Auth

Deliberately minimal. A deployment has an **owner key** and any number of **scoped API keys**. Nothing else: no accounts, no sessions, no passkeys, no device flow, no roles.

Keys are managed over GraphQL, not REST. Key management is a UI and CLI concern, so it lives with every other UI and CLI operation:

```graphql
type Mutation {
  createKey(input: CreateKeyInput!): KeySecret!   # plaintext returned once
  revokeKey(id: ID!): Boolean!
}
```

There is no `/api/auth` surface. A request is authenticated by an `Authorization: Bearer <key>` header, the same header the registry wire contract defines, and a middleware in the Worker resolves the key to a scope set before any resolver runs. The scope vocabulary is shared with the registry, so one key can read, publish, or both.

- The browser holds a key in an `HttpOnly` cookie so the SPA never sees it, or the owner puts Cloudflare Access in front of the whole deployment for an edge gate.
- The CLI and agents send the header. `shelfkit login` asks for a key created in the UI and stores it in the OS keychain.
- The registry endpoints read the same header, which is why declaring a ShelfKit instance in `apm.yml` needs no separate credential.

Read-only share links are unguessable URLs to a public profile and require no key at all.

### 10.4 Stack

| Concern | Choice |
|---|---|
| UI | Vue 3, Vite 8, `@vizejs/vite-plugin` |
| Vue tooling | Vize (`fmt`, `lint`, `check`) |
| Styling | CSSForge on JSR, generated as a prebuild step, output committed |
| API | GraphQL Yoga 5.24, Pothos 4.15, Drizzle v1-rc with the relational query builder v2 |
| Core and compiler | Rust, compiled native for the CLI and WASM for the Worker |
| Storage | Durable Object SQLite per shelf, R2 for content |
| Async | Queues and Cron Triggers for imports and upstream checks |

| Deploy | Wrangler, the platform's own CLI, and nothing else. |
| Validation | OpenAPM JSON Schemas, compiled in, plus Valibot at the API edge |

Two caveats. Vize is not production-ready by its own documentation, so `@vitejs/plugin-vue` plus `vue-tsc` is the fallback and both paths stay green in CI. CSSForge is explicitly experimental with an unstable schema, which is affordable because its output is generated and committed.

### 10.5 Self-hosting

```
git clone https://github.com/Hebilicious/shelfkit && cd shelfkit
pnpm install
pnpm shelfkit setup      # create resources, write secrets, migrate, deploy
```

**Wrangler is the deployment path, and the only one.** Wrangler is the platform's own CLI, has no third-party state to keep in sync, and owns Durable Object migrations directly. ShelfKit keeps `wrangler.jsonc` as the source of truth and drives it from `pnpm shelfkit setup` and `pnpm shelfkit deploy`.

The one place Wrangler is weak is Durable Object migration ergonomics, where a first deploy and a class change both need care. ShelfKit handles that by generating the migration entries from the shelf model rather than expecting an operator to hand-write them, and by checking migration state in CI.

A local mode runs everything on Miniflare, including the registry, with no Cloudflare account. The Deploy to Cloudflare button is offered from a separate flattened template repository, since it does not support monorepos. Workers Paid at $5/month is the documented floor. Workers Free caps CPU at 10 ms per invocation, and a cold GraphQL request that parses, validates, and resolves through WASM is expected to exceed that. The exact figure is unmeasured, so M2 confirms it before this is stated as fact. D1 and Durable Object free allowances are enforced daily.

---

## 11. Provenance

Kept deliberately small. This is not a governance product; it is a record so a reviewer knows what they are looking at.

1. **Pinned by default.** Compiled manifests carry resolved refs.
2. **Verified by digest.** Item content is `sha256`-addressed in R2; the registry publishes the same digest APM checks.
3. **Verdicts bind to our hash.** Third-party scan results are stored against the hash ShelfKit computed, never against a provider timestamp. A stale `safe` reading is otherwise indistinguishable from a fresh one, and only one source in the ecosystem publishes a hash next to a verdict.
4. **Disagreement is visible.** Every scanner that has seen a revision is listed, including contradicting verdicts. `unscanned` is a distinct state from `clean`.
5. **Attribution and licence travel with the item.** `creditText`, `linkTarget`, `recordUrl`, `licenseId`, and `shareAlike` are fields, and a source with no licence contributes URLs and never content.
6. **Secrets are references.** A literal that looks like a credential fails the load.
7. **ShelfKit runs no server code from a shelf.** Scanning is the only execution, it happens in an isolated environment, and a `stdio` MCP server is never started by ShelfKit.

---

## 12. Milestones

### M1: Format, compiler, CLI, and local registry
- [ ] Shelf format: ten kinds, profiles, bundles, revisions, hashing
- [ ] Rust compiler: profile to `apm.yml` and vendored `.apm/` content
- [ ] Validation against the OpenAPM published JSON Schema
- [ ] `init`, `add`, `search`, `compile`, `verify`, `doctor`
- [ ] Import from a Git repo using APM's package layouts, and from an `apm.yml`
- [ ] `shelfkit serve`: a local OpenAPM registry, conformant to the Registry class
- [ ] Golden-file tests: compiled manifests pass schema validation and install with `apm install`

**Exit criterion:** a shelf in Git serves as a registry from a laptop, and APM with `apm experimental enable registries` installs a profile from it. The flag is part of the criterion because APM's registry client is experimental. The Git dependency path needs no flag and is the fallback acceptance test.

### M2: Hosted service
- [ ] Worker with Durable Object SQLite per shelf, R2, Queues, Cron
- [ ] Registry HTTP API with immutability, digests, scopes, and RFC 7807 errors
- [ ] GraphQL API with SSE subscriptions
- [ ] API keys with read and publish scopes
- [ ] Indexing a shelf repo through the forge API, with R2 content addressing
- [ ] `/mcp` with discovery and planning tools
- [ ] Wrangler deployment path and local Miniflare mode, with generated Durable Object migration entries

**Exit criterion:** a self-hosted instance serves a registry that a remote `apm install` consumes, and an agent plans a compile over MCP against a repository it has never seen.

### M3: UI, prompts, and composition
- [ ] Shelf inventory, item detail, revisions, diffs, provenance
- [ ] Prompts screen: copy with variables, copy as skill or command, favourites, search, inline editing
- [ ] Composer with the resolution rail, conflict panel, stack-marker tester, and live `apm.yml` preview
- [ ] Compile screen and import flow
- [ ] Public read-only profile pages

**Exit criterion:** someone finds a prompt, copies it into their agent, then composes and compiles a profile without touching the CLI.

### M4: Curation and reach
- [ ] Sources: APM registries, catalogs, marketplaces, and other ShelfKit instances read on demand
- [ ] Federated search across sources
- [ ] Drift detection between a shelf item and its upstream
- [ ] MCP surface: stateless ShelfKit tools, plus the relay variant for remote servers whose credential should not be distributed.
- [ ] Recommendation from stack markers
- [ ] Per-source licence enforcement and attribution rendering, plus read-only public profile pages. No roles and no organizations: a shelf has an owner and links.

**Exit criterion:** a shelf that consists mostly of curated, pinned imports from three public sources, one of which is another ShelfKit instance, where an agent discovers those MCP servers through `/mcp` and runs them in its own environment.

---

## 13. Open questions

| # | Question | Lean |
|---|---|---|
| 1 | Do profiles need a version beyond a revision hash? | No. A profile revision is a hash; semver is generated only when publishing to the registry, from a `version` field if one is set. |
| 2 | Local authoring versus importing. | Curation is the primary flow, but authoring stays because a stack or a library is inherently personal and cannot be imported from anywhere. Prompts are the most-authored kind. |
| 3 | Running Git in a Durable Object versus the forge REST API. | Start with the forge API, behind an interface. A DO that speaks Git is viable today and would let a shelf be cloned directly and work with self-hosted forges, but the available library (`durable-git`, 0.0.x, single-maintainer, first published weeks before this draft) documents a failure mode on first full-history clones of very large repositories. Cloudflare Artifacts would be the right long-term home and entered beta in April 2026, with no general availability or public free tier as of this draft. This stays behind a flag. Cloudflare Artifacts is the right long-term home and is still closed beta with a missed public-beta target, so the interface exists to swap it in. |
| 4 | OpenAPI surface alongside GraphQL for third parties. | Generate one from the same operations if integrators ask. Not in v1. |
| 5 | What the composer must show that a text editor cannot. | The compiled manifest, live. Everything else in the composer is convenience. |
| 6 | APM version tracking. | Pin a supported range and check it in `doctor`. APM is at 0.31.0, ships weekly, and OpenAPM v0.1 is an editor's working draft with no backward-compatibility guarantee before 1.0, though breaking changes carry a 90-day migration window. That cadence is the strongest argument for the golden-file tests in M1 and for never parsing human-oriented output. |
| 7 | Vize's readiness. | Confined to the Vite config, with both toolchains green in CI. |
| 8 | APM may absorb registry and curation features. | Stay conformant. If APM ships a hosted registry, ShelfKit's value is curation, the prompts library, MCP hosting, and the UI. |
| 9 | Cloudflare Access versus nothing. | Nothing by default, since API keys cover the real threat model. Access remains documented as the optional edge gate. |
| 10 | `lsp` depends on a surface APM has not ratified in the published schema. | Ship the kind and validate leniently, warning in `check` and `doctor`. Drop it to an instructions note if APM removes `dependencies.lsp`. |
| 11 | How much of the registry to implement before APM's client path leaves experimental. | Serve the read endpoints fully, and the `PUT` publish endpoint too. Publishing into ShelfKit from APM is a smaller win than installing from it. |
