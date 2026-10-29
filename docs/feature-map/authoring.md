# Authoring a shelf with the CLI

On a computer, a shelf is a directory the CLI reads and writes, with no deployment involved. `shelfkit init` scaffolds one whose default profile already has a `version`, which every profile now needs. `shelfkit add <dir>` imports a repository's skills, prompts, and its root AGENTS.md as instructions, with every markdown file AGENTS.md links to as a doc that the instructions require; `shelfkit add <file>.md` imports one doc. `shelfkit check` refuses a profile with no version and reports, without failing, a skill whose frontmatter strays from agentskills.io, saying what that costs in each agent. `shelfkit compile` writes the profile's `apm.yml` and package: docs in one skill folder that the instructions' links point at, and `agents/openai.yaml` for Codex beside a skill that sets `disable-model-invocation`.

## Sub-features

- `init-version` scaffolds `profiles/default.json` with `"version": "0.1.0"`.
- `add-agents-md` imports a directory's root AGENTS.md as instructions and the docs it links to, required by it.
- `add-doc` imports one markdown file as a doc.
- `check-version` refuses a profile without a `version`, naming its file.
- `check-skill-frontmatter` reports a `skill-frontmatter` notice for each frontmatter deviation, and passes.
- `compile-docs` installs the profile's docs as one skill folder, `<namespace>-<profile>-docs`, and points the instructions' links at it.
- `compile-codex` writes `agents/openai.yaml` with `policy: allow_implicit_invocation: false` beside a skill that sets `disable-model-invocation: true`.
- `compile-agents-md` gives `apm.yml` the `compilation` settings that have `apm compile` write the instructions into AGENTS.md.

## How to get to it (user POV)

- Terminal, in or below a directory with a `shelf.json`, or with `--shelf <dir>`: `shelfkit init`, `shelfkit add`, `shelfkit check`, `shelfkit compile`. Ready when `shelfkit --help` lists them.
- The files themselves: `shelf.json`, `profiles/<id>.json`, and `items/<kind>/<id>/`.

## Driving it with a browser and a terminal

Preconditions:

- The CLI from the baseline in the [map index](README.md); no deployment, key, or browser is needed.
- The `team-conventions` directory from the baseline's test shelf script, in `~/manual-test`. Work in a new directory, so the test shelf stays as it is: `mkdir -p ~/manual-test/authoring && cd ~/manual-test/authoring`.

- [ ] **Scaffold.** `shelfkit init shelf --name authoring` → `Scaffolded a shelf in <dir>/shelf.` and ``Add items with `shelfkit add <dir>`, select them in profiles/default.json, then `shelfkit compile --dry-run`.``; `cat shelf/profiles/default.json` shows `"id": "default"`, `"items": []`, `"title": "Default"`, and `"version": "0.1.0"`.
- [ ] **Add an AGENTS.md and its docs.** `cd shelf && shelfkit add ../../team-conventions` → `added skill release-notes`, `added instructions team-conventions`, `added doc glossary`, then `Select them in a profile to compile them.`; `items/instructions/team-conventions/item.json` has `"requires": ["glossary"]` and `"source"` `{"id": "team-conventions", "path": "AGENTS.md"}`; `items/docs/glossary/item.json` has `"kind": "doc"`, `"title": "Glossary"`, and `"path": "docs/glossary.md"`.
- [ ] **Add one doc.** `printf '# Release checklist\n\nTag, then publish.\n' > ../release-checklist.md && shelfkit add ../release-checklist.md` → `added doc release-checklist`; `items/docs/release-checklist/` holds `doc.md` and `item.json`.
- [ ] **Check, with a skill frontmatter notice.** `jq '.items = ["team-conventions", "release-notes"]' profiles/default.json > p.tmp && mv p.tmp profiles/default.json && shelfkit check; echo "exit $?"` → one line starting ``items/skills/release-notes/SKILL.md: [skill-frontmatter] `disable-model-invocation` is not an agentskills.io key, so strict validators and claude.ai's skill upload refuse this file.``, which goes on to say Claude Code, Cursor, and Copilot honour it at the top level, Codex ignores it, and the installed skill gets `agents/openai.yaml`; then `ok: 4 items, 1 profiles, every profile compiles to a manifest that validates`, and `exit 0`.
- [ ] **A long description costs Copilot CLI the skill.** Make the `description` in `items/skills/release-notes/SKILL.md` 1,100 characters long and run `shelfkit check` → a `skill-frontmatter` notice: ``items/skills/release-notes/SKILL.md: [skill-frontmatter] `description` is 1100 characters, over agentskills.io's 1024: Copilot CLI refuses to load the skill, and Codex and VS Code cut the description short.`` and more; still `ok:` and exit 0. Put the description back.
- [ ] **A profile needs a version.** `jq 'del(.version)' profiles/default.json > p.tmp && mv p.tmp profiles/default.json && shelfkit check; echo "exit $?"` → ``profiles/default.json: a profile needs a `version`, a semantic version such as `0.1.0`: it is the version the profile publishes as``, `shelfkit: 1 error(s)`, and `exit 1`. Then `jq '.version = "0.1.0"' profiles/default.json > p.tmp && mv p.tmp profiles/default.json`.
- [ ] **A version that is not semantic.** Set `"version": "one"` and run `shelfkit check` → ``profiles/default.json: `version` `one` is not a semantic version (`MAJOR.MINOR.PATCH`, with an optional `-prerelease` and `+build`)``, and exit 1. Put `0.1.0` back.
- [ ] **Compile.** `jq '.registry = {namespace: "authoring", public: false}' shelf.json > s.tmp && mv s.tmp shelf.json && mkdir -p ../repo && shelfkit compile --repo ../repo` → `create` lines for `apm.yml`, `vendor/default/.apm/skills/authoring-default-docs/SKILL.md`, `vendor/default/.apm/skills/authoring-default-docs/docs/glossary.md`, `vendor/default/.apm/skills/release-notes/SKILL.md`, `vendor/default/.apm/skills/release-notes/agents/openai.yaml`, `vendor/default/.github/instructions/team-conventions.instructions.md`, and `vendor/default/apm.yml`; the frontmatter `note:`; and ``next: `shelfkit install`, or with APM alone: `apm install`, then `apm compile --target codex`, with `<!-- apm:start -->` and `<!-- apm:end -->` in AGENTS.md, and `@AGENTS.md` in CLAUDE.md``.
- [ ] **The manifest compiles instructions into AGENTS.md.** `cat ../repo/apm.yml` → `dependencies: apm: - ./vendor/default` and `compilation:` with `strategy: single-file`, `agents_md: mode: managed_section`, and `resolve_links: false`.
- [ ] **Links point at the docs folder.** `cat ../repo/vendor/default/.github/instructions/team-conventions.instructions.md` → the AGENTS.md text, with the link now `[the glossary](.agents/skills/authoring-default-docs/docs/glossary.md)`; no `.claude/rules/` or `.cursor/rules/` file exists under `../repo`.
- [ ] **Codex's setting for a skill used only when asked.** `cat ../repo/vendor/default/.apm/skills/release-notes/agents/openai.yaml` → ``# Written by ShelfKit: SKILL.md sets `disable-model-invocation: true`, which Codex does not read.``, then `policy:` `allow_implicit_invocation: false`.
- [ ] **A skill's own Codex file is kept.** Create `items/skills/release-notes/agents/openai.yaml` holding `policy:` / `  allow_implicit_invocation: true`, then `shelfkit check` → ``items/skills/release-notes/agents/openai.yaml: [skill-frontmatter] SKILL.md sets `disable-model-invocation: true`, but this `agents/openai.yaml` does not set `policy: allow_implicit_invocation: false`, so Codex still uses the skill on its own. The file is the skill's, so ShelfKit leaves it as it is``. Delete the `agents` folder again.
- [ ] **A dry run writes nothing.** `shelfkit compile --dry-run` → `would vendor` lines for the same files, the `note:`, a `then:` line, and the `apm.yml` text; nothing under `../repo` changes.

## Gotchas

- `shelfkit add <dir>` names the instructions item after the directory (`team-conventions` here), and records the directory as a `path` source in `shelf.json` with its absolute path on this computer.
- `shelfkit init` writes no `registry` block. A hosted shelf needs `registry.namespace` equal to its id, so add it before the shelf's first push ([Git](git.md)).
- Without `registry.namespace`, the docs folder is `<profile>-docs` (`default-docs`), not `<namespace>-<profile>-docs`.
- A link in a fenced code block or an inline code span is not followed, and neither is a URL, an absolute path, or one that climbs out of the directory.
