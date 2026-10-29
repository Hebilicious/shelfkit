# ShelfKit verification map

**Every unchecked box (`- [ ]`) in these files is a manual test: a check a person runs by hand.**

This directory lists what the stack of pull requests [below](#the-stack), #34 at the bottom and the one that adds this map at the top, adds or changes, as a feature map: one file per area a user meets (a screen, a command, a Git remote), each with every way in, then the checks, each one an action and what you should see. The automated suites run against Miniflare, with a stand-in for GitHub and Cloudflare's local Artifacts simulator; these checks are for what they cannot reach: a real deployment with Artifacts, queues, and passkeys, the OS keychain, real APM installs, and the wording a person reads.

Read this index, set up the [baseline](#baseline-preconditions), then work through the [features](#features) in the order listed: the early files create the state the later ones use.

## The stack

Bottom to top. Each pull request's base is the one above it; the first is based on `main`.

| PR | Branch | Title | What to test |
| --- | --- | --- | --- |
| [#34](https://github.com/Hebilicious/shelfkit/pull/34) | `web-ux-overhaul` | feat: instant navigation, a Shelf organised by kind, and plain words across the web UI | [Browsing](browsing.md), [Prompts](prompts.md), [Profiles](profiles.md), [Installing](install.md), [CLI sign-in](cli-sign-in.md), [Import](import.md), [MCP and Repositories](mcp.md), [Authoring](authoring.md), [Deployment](deployment.md) |
| [#35](https://github.com/Hebilicious/shelfkit/pull/35) | `e2e-own-ports` | test: each e2e run listens on ports of its own, and a cached build restores the CLI it built | [Developer tooling](#developer-tooling) |
| [#36](https://github.com/Hebilicious/shelfkit/pull/36) | `git-library` | feat(git): Git objects, packs, and both sides of smart HTTP, in Rust (ABI 7) | No surface of its own: [Git](git.md) and [Publishing](publishing.md) run it |
| [#33](https://github.com/Hebilicious/shelfkit/pull/33) | `artifacts-storage` | feat!: every shelf is a Git repository at /git/{shelf}.git, and Git is the one way in | [Git](git.md), [Publishing](publishing.md) (`shelfkit publish`), [Browsing](browsing.md) (the home screen), [Prompts](prompts.md) (an edit is a commit), [Deployment](deployment.md) (the Artifacts namespace, a Preview indexes a push) |
| [#37](https://github.com/Hebilicious/shelfkit/pull/37) | `ui-edits-minimal` | fix(worker): an edit in the UI changes only what it edits, and a restore is that version again | [Prompts](prompts.md), [Git](git.md) |
| [#38](https://github.com/Hebilicious/shelfkit/pull/38) | `forge-any-git-host` | feat(worker): index a shelf from any public Git host, through an Artifacts import | [Import](import.md) |
| [#39](https://github.com/Hebilicious/shelfkit/pull/39) | `profile-version` | feat!: every profile has a version | [Profiles](profiles.md), [Authoring](authoring.md), [Git](git.md), [Publishing](publishing.md) |
| [#40](https://github.com/Hebilicious/shelfkit/pull/40) | `published-profile-repositories` | feat: each published profile is a Git repository of its own | [Publishing](publishing.md), [Installing](install.md) |
| [#42](https://github.com/Hebilicious/shelfkit/pull/42) | `local-artifacts` | refactor!: local mode and the tests run Cloudflare's local Artifacts simulator, and the Worker's own Git server goes | [Local mode](local-mode.md), [Git](git.md) and [Publishing](publishing.md) again (every repository is in Artifacts now, a published profile's too), [Deployment](deployment.md) (a Preview's namespace) |
| [#43](https://github.com/Hebilicious/shelfkit/pull/43) | `manual-testing` | docs: a feature map of what to test by hand across the stack | Nothing: it is this map |

## Where to test

- **Production**, `https://shelfkit.hebilicious.workers.dev`, runs the top of this stack: deployed from `local-artifacts` (`0.1.0-rc.8`) on 2026-10-29, with its Artifacts namespace in the EU, and its `/install.sh` hands out the matching CLI release, `v0.1.0-rc.8`. It is the realistic target, with real Artifacts, queues (imports run there), and passkeys. **A shelf cannot be deleted**, so every check there uses one private test shelf, `manual-test`, and imports go into it. Create nothing else.
- **A Worker Preview** (`moon run worker:preview`, see [Deployment](deployment.md)) has Durable Objects of its own and keeps its repositories in the Artifacts namespace `shelfkit-preview`, which every Preview shares and production never sees. A `git push` is indexed before it returns, but no queue consumers run in a Preview, so imports and "Copy the shelf" never run there. A shelf made on a Preview stays in that namespace when the Preview is deleted.
- **[Local mode](local-mode.md)** (`moon run worker:dev`) runs on Miniflare with no Cloudflare account.

## Baseline preconditions

Every file starts from this baseline unless its preconditions say otherwise. In a shell (zsh or bash):

```bash
export SK=https://shelfkit.hebilicious.workers.dev

# The CLI built from the top of the stack, first on PATH. Run this in a checkout of manual-testing.
cargo build --package shelfkit-compiler
export PATH="$PWD/target/debug:$PATH"
shelfkit --help | grep publish        # "publish    Publish every profile to a hosted deployment's registry"

# Sign this computer's CLI in, once (cli-sign-in.md tests this step by step).
shelfkit login "$SK"

# The key `shelfkit login` keeps, read from the OS keychain only where a command needs it. Never print it.
skkey() { secret-tool lookup service shelfkit username "$SK"; }   # macOS (not tried): security find-generic-password -s shelfkit -a "$SK" -w
skgit() { GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $(skkey)" git "$@"; }
skcurl() { printf 'Authorization: Bearer %s\n' "$(skkey)" | curl -sS -H @- "$@"; }

# APM 0.33.0, the version ShelfKit pins (crates/compiler/src/cli/apm.rs), with a HOME of its own, so its settings
# (the experimental registries flag, registry URLs) never reach your real one.
export UV_CACHE_DIR="${UV_CACHE_DIR:-$HOME/.cache/uv}"
export APM_HOME="$(mktemp -d)"
apm() { HOME="$APM_HOME" XDG_CONFIG_HOME="$APM_HOME/.config" uvx --from apm-cli==0.33.0 apm "$@"; }
skinstall() { HOME="$APM_HOME" XDG_CONFIG_HOME="$APM_HOME/.config" shelfkit install "$@"; }
```

- A browser signed in to `$SK` as the owner, with a passkey.
- **The test shelf.** Built once, outside any repository, then pushed. [Git](git.md) checks what that first push did; if `manual-test` exists from an earlier run, `skgit clone "$SK/git/manual-test.git" shelf` instead.

  ```bash
  mkdir -p ~/manual-test && cd ~/manual-test
  mkdir -p team-conventions/docs team-conventions/skills/release-notes
  cat > team-conventions/AGENTS.md <<'EOF'
  # Team conventions

  Write plain words. The words we use are in [the glossary](docs/glossary.md).
  EOF
  cat > team-conventions/docs/glossary.md <<'EOF'
  # Glossary

  - **Shelf**: a Git repository of agent context.
  EOF
  cat > team-conventions/skills/release-notes/SKILL.md <<'EOF'
  ---
  name: release-notes
  description: Write release notes from the merged pull requests.
  disable-model-invocation: true
  ---

  List the merged pull requests since the last tag, and group them by kind.
  EOF

  shelfkit init shelf --name manual-test
  cd shelf
  shelfkit add ../team-conventions      # added skill release-notes, instructions team-conventions, doc glossary
  mkdir -p items/prompts/greet
  cat > items/prompts/greet/item.json <<'EOF'
  {
    "id": "greet",
    "kind": "prompt",
    "title": "Greet",
    "description": "Say hello to someone",
    "variables": [{ "name": "who", "required": true }]
  }
  EOF
  printf 'Say hello to {{who}}.\n' > items/prompts/greet/prompt.md
  # A hosted shelf's registry namespace is its id. Keep it private.
  jq '.registry = {namespace: "manual-test", public: false}' shelf.json > shelf.tmp && mv shelf.tmp shelf.json
  jq '.items = ["team-conventions", "release-notes", "greet"]' profiles/default.json > profile.tmp && mv profile.tmp profiles/default.json
  shelfkit check                        # ok: 4 items, 1 profiles, every profile compiles to a manifest that validates
  git init -b main && git add -A && git commit -m "The manual test shelf"
  skgit push "$SK/git/manual-test.git" main
  ```

  `~/manual-test/shelf` is "the clone" in every file: pull there (`skgit pull "$SK/git/manual-test.git" main`, or add the remote as [Git](git.md) does) before you change it.

## Driving conventions

- `→` separates what you do from what you should see. Quoted button, link, tab, and heading names are literal, as the UI shows them; messages are quoted as the code writes them, with `$SK`, `<hostname>`, and the like standing for your values.
- A check marked **(check the wording)** describes text whose exact form the code did not settle (an Artifacts or GitHub message, a title read from a file): what it says matters, not each word.
- A check marked **(optional)** costs something (a second account, a throwaway Cloudflare account, minutes of waiting) and can be skipped without leaving a feature untested.
- Keys never go on a command line, into a file, a screenshot, or a test report: use `skgit`, `skcurl`, Git's own password prompt, or the browser. A link from `shelfkit open --print` signs a browser in, so it is a key too.
- Start every check from the [baseline](#baseline-preconditions) unless its file's preconditions say otherwise, and run a file's checks in order: a check may use the state the one before it left.

## Proof and skip reporting

- Record a run in a comment on the pull request that adds this map: the environment (production, a Preview's URL, or local mode), the date, and the commit or deployment tested (`curl -s "$SK/health"` gives the version).
- Paste the checks of the files you ran into the comment and tick a box only when you saw exactly what it says. Leave a failed one unticked and add, under it: what you did, what you saw (the exact text), and a screenshot or the terminal output with every key removed.
- A check that cannot be reached (a precondition missing, a step that errors before the check) is a failure of its own: say which step stopped it. Reaching the result another way does not pass the check.
- Leave the boxes in these files unchecked: they are the list. When a pull request changes what a check expects, it changes the check too.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing what a user sees. Then come exactly four H2 sections, in this order:

1. `Sub-features`: short IDs, one line for each behavior.
2. `How to get to it (user POV)`: every way in, from a screen, a command, or a URL.
3. `Driving it with a browser and a terminal`: `Preconditions:` first, then the checks. Each check is a checkbox with a bold label, the action, `→`, and what you should see.
4. `Gotchas`: traps that waste or invalidate a run.

Keep implementation details out of the map: name only user paths, the names a person reads, required state, commands, and what proves the result.

## Features

1. [CLI sign-in](cli-sign-in.md): `shelfkit login` through the browser, the approval page, CLI sign-ins in Settings, `--key`, `logout`, `open`, and the login's rate limits (PRs #34).
2. [Authoring a shelf with the CLI](authoring.md): `shelfkit init`, `add` (an AGENTS.md and the docs it links), `check` (a missing version, skill frontmatter notices), and `compile` (Codex's `agents/openai.yaml`, the docs folder) (PRs #34, #39).
3. [The shelf as a Git repository](git.md): clone, fetch, and push with a key or anonymously, a push that is indexed or refused, Settings' Repository panel, edits made in the UI pulled back, and the README's three workflows (PRs #33, #36, #37, #39, #42).
4. [Browsing a shelf](browsing.md): the home screen, the Shelf's sidebar of kinds, kind pages, item pages in plain words, instant navigation, and a private shelf seen signed out (PRs #33, #34).
5. [Prompts](prompts.md): finding, filling, and copying a prompt, editing it in place, its History, restoring a version, and the editor that follows the prompt (PRs #33, #34, #37).
6. [Profiles and the profile editor](profiles.md): the Profiles list, Edit and New profile, the required Version, the problems beside a profile, and saving (PRs #34, #39).
7. [Publishing](publishing.md): `shelfkit publish`, immutable versions, each published profile's own Git repository with a tag per version, and installing from it or from the registry with APM (PRs #33, #39, #40, #42).
8. [Installing a profile](install.md): the Install page, `/install.sh` and `/install.ps1`, `shelfkit install`, a private shelf through the keychain, APM alone, and what lands in the repository (PRs #34, #40).
9. [Import](import.md): importing from a Git repository (an AGENTS.md and the docs it links), and copying a whole shelf from GitHub or any public Git host (PRs #33, #34, #38).
10. [MCP and Repositories](mcp.md): `/mcp` with a CLI key, ShelfKit's six tools, and the Repositories screen that `shelf.report` fills (PRs #34).
11. [Deployment](deployment.md): setup's Artifacts namespace and jurisdiction, and a branch as a Worker Preview (PRs #33, #34, #42).
12. [Local mode](local-mode.md): the Worker on Miniflare with Cloudflare's local Artifacts simulator, and what differs from production (PRs #33, #42).
13. [Developer tooling](developer-tooling.md): e2e runs on ports of their own, and a cached build that restores its CLI (PR #35).

Settings has no file of its own: its Account panel's "CLI sign-ins" is in [CLI sign-in](cli-sign-in.md), its Registry and Repository panels in [Git](git.md), and its Keys in [CLI sign-in](cli-sign-in.md) and [Installing](install.md).
