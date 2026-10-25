# PRD: ShelfKit

**Status:** Draft v3.0\
**Last Updated:** 2026-09-19\
**License:** MIT\
**Repository:** `shelfkit`

---

## 1. What ShelfKit is

ShelfKit is a registry and curation layer for agent context, built on [APM](https://github.com/microsoft/apm) and [OpenAPM](https://microsoft.github.io/apm/specs/openapm-v01/).

A **shelf** is a Git repository of selected context: skills, prompts, instructions, agents, hooks, plugins, MCP servers, LSP servers, libraries, tech stacks, and docs. A **profile** is a named selection from a shelf. Compiling a profile writes an `apm.yml`, which `apm install` turns into a configured repository.

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
4. **A thin slice.** No organizations, no roles, no policy engine. A shelf has an owner, the people the owner invites with scopes, and optional read-only links.
5. **A published contract is a dependency, not a reimplementation.** Manifest validation uses OpenAPM's published JSON Schemas. Registry serving uses OpenAPM's Registry HTTP API.
6. **Everything is curated or copied, never generated.** ShelfKit assembles; it does not invent conventions.

---

## 3. Relationship to APM

| Concern | Owner |
| --- | --- |
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
targets: [copilot, claude, cursor, codex] # APM's own target slugs
registries:
  acme:
    url: https://shelf.acme.dev/apm
  default: acme
dependencies:
  apm:
    - anthropics/skills/skills/frontend-design
    - id: acme/team-conventions # from the registry above
      version: ^1.2.0
    - ./vendor/local-conventions # compiled from shelf-authored items
  mcp:
    - name: io.github.upstash/context7
      transport: http
```

Three things worth noting. A ShelfKit instance can be declared as a **registry**, with `default` as a sibling key rather than a per-entry field, so a shelf is installable by stock APM without the ShelfKit CLI installed. Registry-routed dependencies use the object form with `id` and `version`, since a version selector is not a Git ref. And shelf-authored items compile into a local `.apm/` package under `vendor/`, because that is APM's layout for "N independent primitives" and it is exactly what those items are, with one deliberate exception: instructions, tech stacks, and library notes go into the package's `.github/instructions/`, for the reason in section 4.2.

Two parser rules the compiler must respect, because getting either wrong produces a manifest APM rejects. A Git pin is `#<ref>` and nothing else, where the ref is a tag, branch, or commit. That object form also accepts a semver range in `ref:` resolved against remote tags. `@` is never a ref separator, though it may appear inside a literal ref.

Registry URLs are `https://` by requirement. APM 0.33.0 allows plain `http://` only for a loopback host and has no insecure opt-in, so ShelfKit refuses plain `http://` to any other host, RFC 1918 addresses included. That loopback allowance is what lets a self-hosted `shelfkit serve` run on a laptop without a certificate; on a LAN, use https or a loopback tunnel.

---

## 4. Client architecture

APM is a Python program, published as `apm-cli` on PyPI and as per-platform PyInstaller binaries. ShelfKit's CLI is Rust. **They are separate binaries, and ShelfKit never embeds a Python runtime.**

| Question | Decision |
| --- | --- |
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

**Distribution.** A tag `v<version>` publishes the binary for Linux and macOS (x86-64 and ARM) and Windows (x86-64) as a GitHub release with a `SHA256SUMS`. Every deployment serves `/install.sh` and `/install.ps1`, which install the release of the deployment's own version into `~/.local/bin` (or `SHELFKIT_INSTALL_DIR`) after checking its checksum, and change nothing else on the machine. The CLI a deployment hands out therefore always speaks its API.

| Command | Purpose |
| --- | --- |
| `shelfkit init` | Scaffold a shelf |
| `shelfkit add <source>` | Import items from a git repo, an APM registry, a catalog, a marketplace, or another shelf |
| `shelfkit search <query>` | Search the shelf, and optionally federated sources |
| `shelfkit serve` | Run a shelf locally as an OpenAPM registry |
| `shelfkit compile` | Write `apm.yml` and vendored content |
| `shelfkit install [<shelf>/<profile> --url <deployment>]` | Add a hosted profile to the repository's `apm.yml` (its registry, and the profile pinned to its newest published version, which running it again moves), then run APM, resolved from the path or through `uvx`, handing it the key `shelfkit login` keeps for each ShelfKit registry `apm.yml` names. Without a profile, run APM on the `apm.yml` there |
| `shelfkit check` | Validate the shelf: schemas, coordinates, references, unratified keys, target conformance |
| `shelfkit verify` | The manifest still matches the profile it came from |
| `shelfkit recommend` | Propose items and profiles from detected stack markers |
| `shelfkit doctor` | Detect `apm`, harnesses, and source drift |
| `shelfkit login` / `push` | The hosted service. `login` signs the CLI in through the browser (section 10.3); `--key` reads a key instead, as CI does |

### 4.2 How a profile reaches the agents

APM decides where each kind lands, and for most kinds its choice is the only sensible one: a skill folder in `.claude/skills/` and `.agents/skills/`, a prompt as a slash command, an MCP server in each harness's configuration. Instructions are the exception. APM 0.33's installer turns each one into a rule file per agent (`.claude/rules/`, `.cursor/rules/`, `.github/instructions/`); Codex reads none of those, and Cursor and Copilot read AGENTS.md as well, so the same text arrives twice. **ShelfKit sends instructions, tech stacks, and library notes through AGENTS.md instead, for every agent:**

- The compiler writes them to the package's `.github/instructions/`, which `apm install` does not deploy and `apm compile` reads. No rule file is written for any agent.
- The repository's `apm.yml` gets `compilation: { strategy: single-file, agents_md: { mode: managed_section } }`: `apm compile` writes every instruction into the root AGENTS.md, a scoped one as a section naming the files it applies to, between `<!-- apm:start -->` and `<!-- apm:end -->`, and keeps the rest of the file byte for byte.
- `shelfkit install` adds those two lines to the end of an AGENTS.md that lacks them (or writes a file with only them), makes CLAUDE.md import AGENTS.md with `@AGENTS.md` (appending the line to a CLAUDE.md that lacks it, writing one that is only it, and leaving a symbolic link alone), and runs `apm compile --target codex`, whose only output is AGENTS.md. Codex, Cursor, and Copilot read AGENTS.md; Claude Code reads CLAUDE.md and, through the import, AGENTS.md. Not compiling for `claude` or `copilot` keeps APM from writing CLAUDE.md or `.github/copilot-instructions.md` copies of the same text.
- These marker and import lines are the only lines ShelfKit writes outside `apm.yml`, and only to make APM's own managed-section mode work; the instructions themselves are written by APM.

Docs, the longer documents instructions link to, travel the same way through a skill folder of the profile's, with the instructions' links pointed at it (section 5.2, `doc`).

Two limits. This rests on APM 0.33's installer and compiler reading different directories, which nothing in APM promises; the compiler's APM test installs ShelfKit's own shelf and fails if a rule file appears or AGENTS.md lacks the instructions, so an APM release that changes it is caught before the pin moves. And an instruction that is an upstream dependency (a file in another repository, pinned) is installed by APM as a package of its own, so it still becomes rule files.

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
    {
      "id": "anthropics",
      "kind": "git",
      "repo": "https://github.com/anthropics/skills"
    },
    {
      "id": "acme",
      "kind": "apm-registry",
      "url": "https://shelf.acme.dev/apm",
      "tier": 1
    },
    {
      "id": "sam",
      "kind": "shelfkit",
      "url": "https://shelf.sam.dev",
      "profile": "frontend"
    },
    { "id": "clawhub", "kind": "catalog", "url": "https://clawhub.ai/api/v1" }
  ]
}
```

### 5.2 Item kinds

Every item has `id`, `kind`, `title`, `description`, `tags`, and `targets`. An item either **references** something upstream, with provenance and a resolved revision, or is **authored** in the shelf.

A **revision** is an immutable snapshot of one item: `sha256` over a canonical serialization of its directory, with files sorted by path, LF line endings, and timestamps, permissions, and ownership excluded. Two clones of the same shelf therefore produce identical revisions, and a revision is what a profile pins and what a scan verdict attaches to. Item ids are kebab-case and may not contain a double underscore, which is what makes the MCP namespace separator in §8 unambiguous.

#### `skill`

A directory with `SKILL.md`, following [agentskills.io](https://agentskills.io/specification). A skill fails to load only when an agent could not use it: no frontmatter, frontmatter that is not a YAML mapping, a `name` that is not the item id, or no `description`. Every other deviation from the spec (an unknown key such as Claude Code's `disable-model-invocation`, a description over 1024 characters, nested `metadata`) is a `skill-frontmatter` notice from `check`, and the file is kept as written: harnesses read such skills, while strict clients and uploaders, such as claude.ai's skill upload, may refuse them. Each notice says what the deviation costs in each agent. `disable-model-invocation: true` (the skill runs only when a person asks for it) is read by Claude Code, Cursor, and Copilot at the top level only, and by Codex not at all, so the compiled skill gets `agents/openai.yaml` with `policy: allow_implicit_invocation: false`, Codex's own setting for the same thing. A skill that has its own `agents/openai.yaml` keeps it; when it disagrees, `check` says so.

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

Project conventions as structured `sections`, plus `markers` that make a stack detectable. Compiles into an `.instructions.md` file that reaches every agent through one section of the repository's AGENTS.md (section 4.2).

#### `agent`

#### `hook`

#### `plugin`

Agent definition markdown, hook JSON, and an Agent Plugins v1 package respectively.

Two constraints carried over from APM. An agent is a file dependency (`.agent.md`) and can be pinned individually. **A hook cannot**: APM classifies virtual files only by `.prompt.md`, `.instructions.md`, and `.agent.md`, so `.json` never resolves as a file dependency and hooks arrive only through a package. A shelf `hook` item therefore always compiles into the vendored `.apm/hooks/` package rather than a direct reference, and hooks are executable primitives that APM gates behind approval, which the UI states before compile rather than after install.

#### `mcp`

An MCP server, in three flavours:

| Flavour | Shape | Install |
| --- | --- | --- |
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
  "notes": [
    "Migrations are generated, never hand-written.",
    "Prefer `db.query` over `db.select`."
  ],
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
    {
      "heading": "Data",
      "body": "D1. Prepared statements. Migrations in ./migrations."
    }
  ],
  "recommends": ["vue-sfc-patterns", "context7", "drizzle", "wrangler"],
  "tags": ["vue", "cloudflare"]
}
```

`markers` are what make `shelfkit recommend` work, and they are the difference between a stack item and an instructions item.

#### `doc`

A reference document that instructions link to: a glossary, a guide to one subsystem, a runbook. It is longer than an instruction and read only when an instruction or the task points to it, so it costs an agent nothing until then. `path` is where it lives in the repository it was written for, which is how that repository's instructions link to it; `doc.md` is the document.

```json
{
  "id": "domain",
  "kind": "doc",
  "title": "Domain docs",
  "description": "The words the code uses, and what each means.",
  "path": "docs/agents/domain.md"
}
```

A profile's docs install together as one skill, `<namespace>-<profile>-docs`, each at its `path` inside the skill's folder, so links between docs keep working; the skill's `SKILL.md`, which the compiler writes, lists them, so an agent sees them among its skills. A link in an instruction to a doc of the profile, written `docs/agents/domain.md`, `./docs/agents/domain.md`, or climbing to the repository's root with `../`, with or without a `#fragment`, is pointed at the installed copy, `.agents/skills/<namespace>-<profile>-docs/docs/agents/domain.md`; a link to anything else is left as written. A skill that links to a doc gets a copy of it, and of the docs that one links to, inside its own folder at the doc's path, and its link points there: APM 0.33 keeps a link that stays inside a skill's folder as written, but rewrites one that leaves it, even to a sibling skill of the same package, to the package's copy under `apm_modules/`, which a repository does not commit. A link from an instruction or a skill to a markdown file the profile does not ship (a doc of the shelf the profile leaves out, or a file no doc provides) is a `doc-link` note in the plan and in `check`: installed elsewhere, it leads nowhere. Links to the profile's own skills and to AGENTS.md are fine and not noted. APM 0.33 has no primitive for a document and installs no loose file, but it copies a skill folder whole into `.agents/skills/` and `.claude/skills/`, which a repository commits. The compiled `apm.yml` therefore sets `compilation.resolve_links: false`, without which `apm compile` would paste every linked document into AGENTS.md, and adds `agent-skills` to `targets` that install no skills into `.agents/skills/` (only `claude` does not). An instruction that needs a doc lists it in `requires`, so a profile that selects the instruction gets the doc. `shelfkit add <file>.md` imports any other markdown file as a doc, its `path` taken from where it sits in its repository. `shelfkit add <dir>` and the hosted importer read a repository's root AGENTS.md as instructions and import each markdown file its relative links reach (inline or reference links, `./` and `#fragment` allowed, followed from doc to doc up to 40 docs) as a doc, its `path` relative to the imported directory; each item requires the docs it links to and is imported with, so selecting AGENTS.md brings them. APM installs instructions from upstream only from an `.instructions.md` file and installs no document at all, so an imported AGENTS.md and its docs compile from their copies: one whose licence permits no copy imports as a link (section 6), and a profile that selects it fails to compile, saying why.

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
| --- | --- | --- |
| `git` repo, `.apm/` layout | Typed primitives under `.apm/` | One item per primitive, kind from directory |
| `git` repo, root `SKILL.md` | One skill bundle | One `skill` item, bundled as a unit |
| `git` repo, `skills/<n>/SKILL.md` | N nested skills | N `skill` items, installable individually |
| `git` repo, `hooks/*.json` | A hook bundle | N `hook` items |
| `git` repo, `plugin.json` | A Claude plugin collection **or** an Agent Plugin, depending on `$schema` | N items, or one `plugin` item |
| `git` repo, marketplace with inline `mcpServers`/`lspServers` | Synthesized server definitions | `mcp` items |
| `git` repo, single `*.prompt.md` / `*.instructions.md` / `*.agent.md` at a known path | One file dependency | One item pinned to that path |
| `git` repo, root `AGENTS.md` (a regular file, not a symbolic link) | The repository's conventions, and the markdown files its relative links reach, directly or through another of them | One `instructions` item, its text copied, and one `doc` per linked file at its path in the tree; each requires the docs it links to |
| `git` repo, single other `*.md` at a known path | One document | One `doc` item, at that path |
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
- a **plain Git repo**, discovering primitives through APM's package layouts, and its AGENTS.md with the docs it links to;
- a **catalog** (official MCP registry, Docker, Cline, ClawHub, awesome-copilot), importing server definitions and skill records with licence metadata.

Imports are pinned to a resolved commit, version, or digest, and the UI shows drift when upstream moves. Curation is then a local act on imported material: rename, tag, bundle, exclude, or override the description, without rewriting the artifact.

---

## 8. The MCP endpoint

ShelfKit runs an MCP endpoint at `/mcp` so an agent can use a shelf without a shell. Almost all of it is ShelfKit's own stateless tools. The one addition is a relay for a remote server whose credential should not be copied into every client config, and that relay is argued for carefully below because the pattern has a real failure mode.

**ShelfKit's tools.** `shelf.search`, `shelf.recommend`, `shelf.profile.get`, `shelf.item.get`, `shelf.compile.plan`, which returns the `apm.yml` that would be written plus vendored files and the install command, and `shelf.report`, which records that an agent applied a plan to a repository. They are [AcidCat](https://github.com/Hebilicious/acidcat) capability ids, served by AcidCat's MCP binding, which names each tool by its id; the contract is `packages/schema/acidcat.catalog.json`. `shelf.compile.plan` never mutates anything: ShelfKit plans, the agent applies, APM installs. Each call reads from a Durable Object or R2 and returns, holding nothing between calls; `shelf.report` writes only its activity record.

**The relay, and why it is not a gateway.** A shelf can list a remote MCP server and declare that ShelfKit relays it. This is not a general aggregation layer: ShelfKit does not host several servers behind one endpoint as a convenience, and it never hosts a local one. What the relay buys is one holder for a credential, and §8.1 explains the hazard that comes with it.

### 8.1 Why the relay is not a transparent proxy

ShelfKit targets MCP spec revision **2026-07-28**, which is stateless: sessions and `Mcp-Session-Id` were removed along with the initialize handshake and the GET stream. That simplifies the transport considerably, and it retires a class of proxy bug that older gateways hit when they dropped session headers.

What did not go away is the aggregation problem. Docker's MCP gateway shipped a security advisory for **tool-name shadowing across aggregated servers**, where two backends offering a tool with the same name let one impersonate the other, last writer wins. The specification itself addresses this: an aggregating proxy SHOULD implement a disambiguation strategy such as prefixing tool names with a server identifier, and `serverInfo.name` is explicitly not unique. Rule 1 below is that guidance taken literally.

There is a structural reason this is fragile, not just an implementation detail. Aggregating N backends behind one connection means the client holds one authorization relationship while the gateway holds N. Whatever credential the client presents authenticates it to the _gateway_, not to each upstream, so the gateway becomes an ambient authority that can reach everything it knows about. That is a confused deputy, and no amount of careful implementation makes it disappear.

So ShelfKit does not pretend to be transparent. Four rules:

1. **Every hosted tool is namespaced by its owning item**, as `<item>__<tool>`, and item ids may not contain `__`, which makes the separator unambiguous rather than merely unlikely to collide. Names are length-checked, since MCP asks for tool names of 128 characters or fewer.
2. **A key grants access to declared items, not to everything the shelf knows.** Hosting is opt-in per item and per key, and the endpoint's tool list is computed from the key, so an agent cannot discover a backend it was not granted.
3. **ShelfKit's own tools are never merged into a backend's namespace**, and a hosted backend can never claim a `shelf.*` name. A capability id contains no `_`, so it can never take the `<item>__<tool>` form.
4. **Credentials belong to the item, not to the caller.** ShelfKit injects a credential it holds, which is the only reason the relay exists. Role-based scoping also keeps the ambient authority small: a key reachable by a relayed server sees that server's tools and nothing else.

### 8.2 What is relayed, and what is not

| Item flavour | Default | What ShelfKit does |
| --- | --- | --- |
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
| --- | --- |
| An agent wants an MCP server | The item compiles into `dependencies.mcp`, APM writes the harness config, and the client runs the server itself. This is the normal path and it covers `stdio` and remote alike. |
| An agent has no local process | It calls `shelf.search` and `shelf.compile.plan` to learn what to configure, and the orchestration layer it runs on starts the process. |
| ShelfKit wants to expose its own capability | It adds a **stateless tool on the Worker or a Durable Object**: search, read an item, resolve a profile, compile a manifest. Request in, answer out. |
| A remote server needs a credential it should not hand out | The hosted remote variant in §8.2 relays the call and holds the credential. It owns no process and keeps no session. |

The published `hosted` flavour for `stdio` items is gone. Those items are `stdio`: the shelf distributes the definition, and the agent runs the process. That is also the honest reading of what an agent wants, which is to be told which MCP servers exist, what they are for, and how they are configured, and then to run them in its own environment where the tools they need actually live.

Every MCP tool ShelfKit serves is therefore stateless by construction: it reads from a Durable Object or R2, returns a result, and holds nothing between calls. That is what the current spec revision expects, and it is also the only kind of MCP surface a Worker can serve well.

---

## 9. Web UI

Vue 3, Vite, Vize, CSSForge. Everything goes through the same API as the CLI.

| Screen | Purpose |
| --- | --- |
| **Browse** | The shelf's items. Search, filter by kind and tag, bulk-select into a profile. |
| **Prompts** | The prompt library, treated as a first-class surface rather than a filtered list. |
| **Item** | Rendered content, what installing it writes, history and diffs, origin, what uses it, scans. |
| **Profiles** | Every profile, what it installs, and the way to edit or install it. |
| **Edit profile** | Build a profile: drag items in, see what it installs and any conflicts, see the `apm.yml` update live. Reached from a profile, not the navigation. |
| **Install** | Install a profile from the shelf's registry. The default is the ShelfKit CLI: a prompt that has an agent install the CLI if it is missing and run `shelfkit install`, or the same as terminal steps. APM alone is the other way, again as a prompt or terminal steps. A private shelf's steps sign the CLI in once with `shelfkit login`, so no key is ever in a file or in front of an agent. Below, which file each item becomes for each agent. Reached from a profile. |
| **Import** | Paste a repo, registry, catalog, or shelf URL; pick items; set pins. |
| **Repositories** | Which repositories installed which profile version, and which are behind. |
| **Settings** | Your passkeys and devices, people and invites, API keys for programs, sources, secret names, registry visibility. |

Two rules hold on every screen. **Moving between screens never waits on the network** for what the shelf's index already holds: opening a shelf loads every item once, keeps it across visits, and the live subscription marks it stale. **The UI speaks plainly**: the format's own terms (kind slugs such as `library` and `stack`, `vendored`, compile, resolution, revision hashes) are shown as a label with a sentence saying what they do for the agent, and APM's words (`apm.yml`, `apm install`) are kept because the reader meets them in the repository.

Signing in is "Sign in with a passkey", or a one-time link on a device without one; "Sign in with GitHub" appears only on a deployment that enables it. No key is ever typed into the browser.

### 9.1 The prompts screen

Prompts are the most-used kind and deserve more than a list, because the actual job is "get this prompt into my clipboard or my agent, now."

- **Copy, with variables.** A prompt with variables renders a small form in the detail pane; filling it produces the final text and copies it. Variables have defaults and can be marked required.
- **Copy for a harness.** One click copies the prompt as a skill (`SKILL.md` with frontmatter), as a slash command, or as plain text.
- **Favourites and recents**, stored per key or signed-in account so the list opens on what is actually used.
- **Full-text search over prompt bodies**, since that is how people find the prompt they half-remember.
- **Editing in place**, with revision history. A prompt is short enough that the list, the editor, and the preview fit on one screen.
- **Import from anywhere**, because prompts are collected from chats, docs, and other people's shelves.

### 9.2 The profile editor

The profile editor (the composer): a three-pane screen with the item inventory on the left, the profile in the middle as an ordered, grouped list, and a live resolution rail on the right showing resolved items, unpinned items, conflicts by severity, and the resulting APM coordinates. Underneath, a `apm.yml` preview updates as items move, so the authored selection and the compiled output are visible at the same time. A stack-marker tester takes a sample `package.json` and reports which stacks match.

---

## 10. Architecture

```
Cloudflare Worker  (single deployable)
  /apm/v1/*      registry wire contract
  /mcp           MCP tools
  /graphql       API for the UI and the CLI, including keys, links, invites, and passkeys
  /auth/passkey/* passkey sign-in for the browser
  /auth/github/*  GitHub sign-in, when enabled
  /auth/cli/*     signing the CLI in through the browser (`shelfkit login`)
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
- **Migrations run inside the object at runtime**, behind `blockConcurrencyWhile`, because there is no CLI path to a Durable Object's SQLite. An object that holds a shelf migrates in its constructor, and a wake whose `schema_version` is already current skips the migrator. An object that has never been written migrates on its first write instead, so a read of an unknown shelf id answers "not found" and leaves no storage behind. `PRAGMA user_version` is unsupported, so schema versioning is explicit. **The cap is 10 GB per object**, not per class, so capacity scales with shelf count. A full object fails writes with `SQLITE_FULL` while reads and deletes keep working, which is why the shelf reports its own storage usage instead of waiting to discover the ceiling.

#### Search is per shelf

There is no cross-shelf index and no D1 database. Search covers the shelf you are in, which is the only shelf the service holds.

This is a deliberate limit, not a missing feature. The product is a shelf you own, not a directory of everyone's shelves, and a global index would be the beginning of a marketplace the principles rule out. Reaching someone else's shelf is an explicit act: you add it as a source, and ShelfKit reads it on demand and imports what you choose. Nothing is mirrored, nothing is indexed behind your back, and no query spans shelves.

A useful side effect is that removing D1 removes a second datastore, a second migration mechanism, and the consistency problem of keeping a derived catalog in step with objects. The service has exactly one place where shelf data lives.

### 10.2 API

GraphQL Yoga with Pothos, served over HTTP and over SSE for subscriptions. The registry, MCP, and raw-artifact routes stay plain fetch handlers, because their wire formats are fixed by a spec.

The Rust resolver compiles to WASM and runs in the Worker, so the preview in the browser, the `compile --dry-run` in the CLI, and the server's own resolution all execute the same code.

Subscriptions work: a Durable Object per shelf already exists, so it fans out changes to connected clients over SSE or a hibernating WebSocket, and Queues carry work that outlives a request. Polling with `ETag` is the fallback, not the design.

### 10.3 Auth

Deliberately minimal. People sign in with passkeys; programs present keys, and a person's CLI gets its key by being approved in their browser. There are no passwords and no roles, and nobody pastes a key into a browser.

**People** sign in with a **passkey** (WebAuthn), and a **one-time link** opens a browser that has none:

- `moon run worker:setup` ends by opening a link that signs the owner in, and the page offers to add a passkey on that device. `shelfkit open` makes such a link later with the owner key the CLI holds, for a new device or a lost passkey.
- A signed-in browser makes a link for another device: open it there, and add a passkey.
- The owner **invites** someone with a link carrying a grant on one shelf, in the scope forms a key holds. Whoever opens it gets an account holding that grant (or adds it to theirs, if signed in) and adds a passkey.

A link never quietly switches a browser that is signed in as someone else: it names both accounts and waits for a click. A sign-in link lasts 15 minutes and an invite 7 days. Both are single-use and stored only as hashes, and the token travels in the URL's fragment, which no server and no `Referer` sees. The passkey ceremonies run on the Worker (`/auth/passkey/*`): challenges are single-use and last 5 minutes, the origin and the RP id must be the deployment's own, user verification is required, and a signature counter that does not move forward refuses the assertion. A passkey lives in its person's account object: one Durable Object per principal, the owner's (`owner`) and each invited person's (`person:<id>`), holding their passkeys and sign-in links. The owner's grants to people live in each shelf's own object, read on every request, so revoking a grant, or removing a person, takes effect at once. No query spans objects, and there is no shared database.

The session is an `HttpOnly`, `SameSite=Strict` cookie naming the principal, signed with a Worker secret and expiring after 30 days. Rotating that secret signs every browser out.

On Linux, a browser makes and uses passkeys through a passkey provider: its own password manager, a password manager's extension, or a hardware security key. A device without one still signs in with a link from `shelfkit open` or from a signed-in device.

**GitHub sign-in is opt-in.** With `moon run worker:setup -- --github-sign-in`, setup creates the deployment's own GitHub App (asking for no permissions), records the owner's GitHub account by numeric id, and the sign-in screen offers "Sign in with GitHub". `/auth/github/start` and `/auth/github/callback` run the authorization code flow with PKCE; the Worker uses GitHub's token once, to read who signed in, and revokes it. The owner's GitHub account signs in as the owner principal, and the owner grants other GitHub accounts scopes as for anyone else. Without the flag, no GitHub App exists and no button is shown. `--no-github-sign-in` turns it off again by deleting its secrets: every GitHub session, the owner's included, then ends at its next request, and GitHub accounts' grants hold nothing.

**Signing the CLI in through the browser.** `shelfkit login <url>`, run in a terminal, signs the CLI in the way a device-authorization flow does, so a person never copies a key:

1. The CLI posts `/auth/cli/start` with a name for its computer (the hostname). The Worker answers with a **user code** of 8 characters from an alphabet without look-alikes (`ABCD-EFGH`), a **device code** (`<user code>.<secret>`), the page that approves it (`/cli/ABCD-EFGH`), and a poll interval. The pending login lives in its own Durable Object, named by the user code, which keeps only the SHA-256 of the device code's secret and expires after 10 minutes; an alarm deletes whatever is left.
2. The CLI prints the page and the code and opens the page in the browser. A browser that is not signed in goes through sign-in and back. The page shows the code, the device name the CLI sent (which proves nothing), the account that approves, and what its key may do, and says to approve only a code shown in one's own terminal right now: the code is the phishing surface of any such flow. Only a browser signed in by its cookie approves or denies (`approveCliLogin`, `denyCliLogin`), never a key, under the same-origin rules as every cookie request.
3. Approving makes a **CLI key**, `skc_<account>_<secret>`, named "CLI on <device>", kept by its hash in the approver's account object. It acts as that person on every surface: the owner's is the owner, and an invited person's or a GitHub account's holds what each shelf grants them, read on every request, so a narrowed or revoked grant, or removing the person, takes effect on the CLI at once. The key waits in the login for one pickup.
4. The CLI posts `/auth/cli/poll` with the device code every interval until it hears `approved` (with the key, deleted from the login in the same step), `denied`, or `expired`. A wrong secret and an unknown code are answered as `expired`, so the poll tells nobody more about a code than its CLI may know. A key approved for a CLI that never comes back for it is revoked when the login expires.

The CLI then checks the key and keeps it in the OS keychain, as with a pasted key. Each person sees the keys their CLIs hold under "CLI sign-ins" and revokes them there; the owner also revokes any key from Settings. Rotating the session secret signs browsers out, not CLIs. With 32^8 codes that each live 10 minutes, guessing one that someone else is about to approve is not practical, and the device code's secret is 256 bits; the flow is still **rate limited**, so that nobody can make the deployment hold logins, run objects, or try codes at whatever speed they like. The limits are Workers Rate Limiting bindings declared in `wrangler.jsonc` (again in its `previews` block, with namespaces of their own, so a Preview never spends production's budget), and `src/auth/limits.ts` names the same numbers:

| What | Counted per | Limit | Why that number |
| --- | --- | --- | --- |
| Starting a login (`/auth/cli/start`) | client address (`CF-Connecting-IP`) | 10 a minute | A person needs one login, and each holds a Durable Object for 10 minutes; ten leave room for a few people behind one address and a retry or two. |
| Polling (`/auth/cli/poll`) | client address | 20 every 10 seconds | A CLI polls every 2 seconds, 5 polls in a window, so four CLIs behind one address poll at full speed and a fifth slows down. The short window keeps the wait short. |
| Looking a code up, approving, or denying (`cliLogin`, `approveCliLogin`, `denyCliLogin`) | signed-in account | 20 a minute | Handling one login takes two or three; the limit caps how fast a session, whoever holds its cookie, can try codes. |

A route over its limit answers `429` as an RFC 7807 problem with `Retry-After` in seconds (the limit's window), and GraphQL refuses with `RATE_LIMITED` and `retryAfter` in the error's extensions. The CLI waits a poll's `Retry-After` and polls again, and a refused start tells the person to run `shelfkit login` again in that many seconds. The platform's limiter counts per Cloudflare location and is approximate by design: on a Preview, 40 starts sent within a minute from one address were refused only after the 48th, and 60 polls in 11 seconds were not refused at all, since a burst spends itself before the counts meet. That is enough for the address limits, which bound abuse; the 256-bit secret, not a limit, is what keeps a login safe. One limit is exact, because it costs nothing: each poll already reaches its login's object, which refuses a poll that holds the secret and comes less than a second after the last one (half the CLI's interval, leaving room for a slow answer) with `429` and `Retry-After: 2` (RFC 8628's `slow_down`). A poll with the wrong secret does not count, so seeing a code is not enough to slow its CLI down. A CLI key does not open `/mcp`'s tools, which an agent reaches with a scoped key from Settings.

**Programs.** The CLI, agents, CI, and APM's registry client send `Authorization: Bearer <key>`, the header the registry wire contract defines. A deployment has an **owner key** and any number of **scoped API keys**, and a middleware in the Worker resolves a key to a scope set before any resolver runs. The scope vocabulary is shared with the registry, so one key can read, publish, or both.

Keys, links, invites, passkeys, and CLI logins are managed over GraphQL, not REST, because they are a UI and CLI concern like every other operation:

```graphql
type Mutation {
  createKey(input: CreateKeyInput!): KeySecret! # plaintext returned once
  revokeKey(id: ID!): Boolean!
  createSignInLink: SignInLink!
  createInvite(shelf: ID!, name: String!, scopes: [String!]!): InviteSecret!
  redeemLink(token: String!): LinkRedemption!
  revokeAccess(shelf: ID!, principal: ID!): Boolean!
  removePerson(shelf: ID!, principal: ID!): Boolean!
  approveCliLogin(code: String!): CliLoginApproval! # the CLI picks the key up once, from /auth/cli/poll
  denyCliLogin(code: String!): Boolean!
  revokeCliKey(id: ID!): Boolean!
}
```

- A key never goes into a browser. Settings creates one and shows it once, to copy into CI or an agent's configuration.
- `shelfkit login` signs the CLI in through the browser and stores the key it is given in the OS keychain. With `--key`, or when standard input is not a terminal (CI), it reads a key created in the UI instead. `shelfkit install` hands it to APM in `APM_REGISTRY_TOKEN_<NAME>` for each ShelfKit registry an `apm.yml` names, so installing from a private shelf needs the key typed once per computer, by a person, and never in a file, a command line, or an agent's context.
- The registry endpoints read the same header, which is why declaring a ShelfKit instance in `apm.yml` needs no separate credential.
- A request the cookie authenticates must be same-origin: a `POST` is JSON only and carries this origin's `Origin` header, and there is no CORS. `/mcp` reads the header only.

The owner may still put Cloudflare Access in front of the whole deployment as an edge gate. Read-only share links are unguessable URLs to a public profile and require no sign-in at all.

### 10.4 Stack

| Concern | Choice |
| --- | --- |
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

Setup ends by opening the owner's enrollment link in the browser, which signs the owner in and adds a passkey there. With `--github-sign-in` it first creates the deployment's GitHub App: a page on the operator's loopback posts the app's manifest to github.com, the operator clicks "Create GitHub App", and setup stores the app's client id and secret as Worker secrets and discards its private key. A GitHub OAuth App created by hand, with the same two secrets, works the same way.

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

- [ ] Shelf format: eleven kinds, profiles, bundles, revisions, hashing
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
- [ ] Per-source licence enforcement and attribution rendering, plus read-only public profile pages. No roles and no organizations: a shelf has an owner, invited people, and links.

**Exit criterion:** a shelf that consists mostly of curated, pinned imports from three public sources, one of which is another ShelfKit instance, where an agent discovers those MCP servers through `/mcp` and runs them in its own environment.

---

## 13. Open questions

| # | Question | Lean |
| --- | --- | --- |
| 1 | Do profiles need a version beyond a revision hash? | No. A profile revision is a hash; semver is generated only when publishing to the registry, from a `version` field if one is set. |
| 2 | Local authoring versus importing. | Curation is the primary flow, but authoring stays because a stack or a library is inherently personal and cannot be imported from anywhere. Prompts are the most-authored kind. |
| 3 | Running Git in a Durable Object versus the forge REST API. | Start with the forge API, behind an interface. A DO that speaks Git is viable today and would let a shelf be cloned directly and work with self-hosted forges, but the available library (`durable-git`, 0.0.x, single-maintainer, first published weeks before this draft) documents a failure mode on first full-history clones of very large repositories. Cloudflare Artifacts would be the right long-term home and entered beta in April 2026, with no general availability or public free tier as of this draft. This stays behind a flag. Cloudflare Artifacts is the right long-term home and is still closed beta with a missed public-beta target, so the interface exists to swap it in. |
| 4 | OpenAPI surface alongside GraphQL for third parties. | Generate one from the same operations if integrators ask. Not in v1. |
| 5 | What the composer must show that a text editor cannot. | The compiled manifest, live. Everything else in the composer is convenience. |
| 6 | APM version tracking. | Pin a supported range and check it in `doctor`. APM is at 0.31.0, ships weekly, and OpenAPM v0.1 is an editor's working draft with no backward-compatibility guarantee before 1.0, though breaking changes carry a 90-day migration window. That cadence is the strongest argument for the golden-file tests in M1 and for never parsing human-oriented output. |
| 7 | Vize's readiness. | Confined to the Vite config, with both toolchains green in CI. |
| 8 | APM may absorb registry and curation features. | Stay conformant. If APM ships a hosted registry, ShelfKit's value is curation, the prompts library, MCP hosting, and the UI. |
| 9 | Cloudflare Access versus nothing. | Nothing by default, since passkeys and API keys cover the real threat model. Access remains documented as the optional edge gate. |
| 10 | `lsp` depends on a surface APM has not ratified in the published schema. | Ship the kind and validate leniently, warning in `check` and `doctor`. Drop it to an instructions note if APM removes `dependencies.lsp`. |
| 11 | How much of the registry to implement before APM's client path leaves experimental. | Serve the read endpoints fully, and the `PUT` publish endpoint too. Publishing into ShelfKit from APM is a smaller win than installing from it. |
