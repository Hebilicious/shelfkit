# Installing a profile

A profile's Install page hands out the ways to install it into a repository. The default is the ShelfKit CLI: a prompt that has an agent install the CLI if it is missing and run `shelfkit install <shelf>/<profile>`, or the same as commands for a terminal. "With APM alone" gives a prompt and commands that need no ShelfKit tool, and names the profile's own Git repository, which APM installs from with a version range. Every deployment serves `/install.sh` and `/install.ps1`, which install the CLI release of its own version. `shelfkit install` adds the profile to the repository's `apm.yml`, pinned to its newest published version, and runs APM; a private shelf's key comes from the OS keychain, where `shelfkit login` put it, and is never in a file, on a command line, or in front of an agent. Instructions go into AGENTS.md for every agent, between two marker lines `shelfkit install` adds, with CLAUDE.md importing it as `@AGENTS.md`, and no rule file is written.

## Sub-features

- `install-page` shows "With the ShelfKit CLI", "With APM alone", and "What lands in the repository" for one profile.
- `install-cli-prompt` copies a prompt for an agent, or terminal steps, that install the CLI and run `shelfkit install`; a private shelf's add `shelfkit login`.
- `install-apm-alone` copies a prompt or terminal steps for stock APM, pinned to the newest published version, and names `$SK/git/<shelf>/<profile>.git`.
- `install-unpublished` warns when the profile is not in the registry yet.
- `install-scripts` `/install.sh` and `/install.ps1` install the deployment's CLI release into `~/.local/bin`, or `SHELFKIT_INSTALL_DIR`, after checking its checksum.
- `shelfkit-install` writes or updates `apm.yml`, turns on APM's registries flag, names a private registry in APM's user config, runs `apm install`, and writes AGENTS.md through `apm compile --target codex`.
- `agents-md` adds the markers to the end of an AGENTS.md and keeps the rest; writes CLAUDE.md as `@AGENTS.md`, or adds the line; leaves a symbolic link alone.
- `move-pin` moves `apm.yml` to the newest version on a second run, and the lockfile with `apm update`.
- `install-errors` explains a malformed name, a missing profile, a private shelf with no key, and a key the deployment does not know.

## How to get to it (user POV)

- Profiles → "Install" on a profile (or its title), `$SK/shelves/manual-test/compile/default`, `g` then `k`, "Install…" in the editor, or "Install…" and "Update…" on Repositories. Ready when the heading reads "Install Default" above "With the ShelfKit CLI".
- `$SK/install.sh` and `$SK/install.ps1`, as the page's steps fetch them.
- Terminal: `shelfkit install <shelf>/<profile> --url "$SK"` in a repository; in these checks, `skinstall`, the baseline's wrapper that gives APM its own HOME.

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), signed in as the owner; `manual-test` private, with `manual-test/default` published at `0.1.1` ([Publishing](publishing.md)).
- A fresh `APM_HOME` (`export APM_HOME="$(mktemp -d)"`), so every folder below starts with APM's settings untouched.

The page:

- [ ] **Open it.** Profiles → "Install" on Default → "← Profiles", "Install Default", a "Profile" list on "Default", "Edit profile", and "Installing puts each item of this profile into a repository, in the files each agent reads. APM does the installing, from this shelf's registry; the ShelfKit CLI, your agent, or you only tell it which profile to fetch."
- [ ] **The CLI, for an agent.** "With the ShelfKit CLI" → "One command adds the profile to the repository's apm.yml, keeping what is there, and runs APM. The CLI installs itself once per computer, and for this private shelf `shelfkit login` signs the CLI in through your browser and keeps its key in the OS keychain, so the key is never copied, in a file, or in front of an agent."; the tab "Ask your agent" is selected; "Paste to Claude Code, Codex, or any agent working in the repository"; the prompt starts `Install the ShelfKit profile "Default" (manual-test/default) into this repository with the ShelfKit CLI.`, gives `curl -fsSL $SK/install.sh | sh` and `irm $SK/install.ps1 | iex` in step 1, `shelfkit install manual-test/default --url $SK` in step 2, and "The shelf is private. If shelfkit says it has no key for $SK, stop and ask me to run `shelfkit login $SK` in my own terminal, …". "Copy prompt" → "Prompt copied: paste it to your agent in the repository."
- [ ] **The CLI, for a terminal.** The "Terminal" tab → "Run in the repository's folder" and "Copy"; the steps: `curl -fsSL $SK/install.sh | sh`, `export PATH="$HOME/.local/bin:$PATH"`, the comments "# Once per computer: sign the CLI in to read this private shelf. …" and "# (In CI, with no browser, pipe it a key from Settings → Keys instead.)", `shelfkit login $SK`, and `shelfkit install manual-test/default --url $SK`. "Copy" → "Commands copied: paste them in the repository's folder."
- [ ] **APM alone names the profile's repository.** "With APM alone" ("no ShelfKit CLI") → "Show" → "The repository's apm.yml names the shelf's registry and the profile, and APM, run through uv, installs it. For a private shelf, APM needs the registry in its user config and a key in the environment. APM also installs a published version from the profile's own Git repository, `$SK/git/manual-test/default.git`, with a version range as the `ref` and no experimental flag."
- [ ] **APM alone's text.** "Ask your agent" → a prompt whose YAML has `registries:` `manual-test:` `url: $SK/apm`, a dependency `registry: manual-test`, `id: manual-test/default`, `version: "0.1.1"`, and the `compilation:` block; for the private shelf, `uvx --from apm-cli==0.33.0 apm config set registry.manual-test.url $SK/apm` and `APM_REGISTRY_TOKEN_MANUAL_TEST`. "Terminal" → "Run in the repository's folder, which has no apm.yml yet"; `cat > apm.yml <<EOF`, `read -rs APM_REGISTRY_TOKEN_MANUAL_TEST && export APM_REGISTRY_TOKEN_MANUAL_TEST`, the AGENTS.md and CLAUDE.md lines, `uvx --from apm-cli==0.33.0 apm compile --target codex`, and "# Later, to move to a newer version: …". "Hide" folds it.
- [ ] **What lands.** "What lands in the repository" → "4 items. Commit what APM writes along with apm.yml and apm.lock.yaml, so everyone working in the repository gets the same."; "**Instructions, tech stacks, and library notes** install the same way: …"; folds "Prompts · Greet", "Instructions · Team conventions", "Skills · release-notes", and "Docs · Glossary"; "Docs" names `.agents/skills/manual-test-default-docs/<path>`.
- [ ] **Not published yet.** Profiles → "New profile", "Title" `Unpublished`, add "Greet", "Save profile", then "Install…" → a warning that the profile is not in the shelf's registry yet, so nothing on the page can fetch it, naming the command that publishes it: `shelfkit publish`. Delete the profile from Profiles afterwards.

The install scripts:

- [ ] **`/install.sh`.** `curl -fsSL "$SK/install.sh" | head -3` → `#!/bin/sh`, `# Installs the ShelfKit CLI 0.1.0-rc.8, the version $SK runs.`, and `# Usage: curl -fsSL $SK/install.sh | sh`. Then `d="$(mktemp -d)" && curl -fsSL "$SK/install.sh" | SHELFKIT_INSTALL_DIR="$d" sh` → `Downloading shelfkit 0.1.0-rc.8 for x86_64-unknown-linux-gnu` (or this machine's platform), `Installed $d/shelfkit`, and `$d is not on your PATH: add it, or run $d/shelfkit`; `"$d/shelfkit" --version` → `shelfkit 0.1.0-rc.8`, and `"$d/shelfkit" --help` lists `publish` and neither `push` nor `fetch`. No shell profile changed.
- [ ] **`/install.ps1` (optional, Windows).** In PowerShell, `$env:SHELFKIT_INSTALL_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP 'sk')).FullName; irm https://shelfkit.hebilicious.workers.dev/install.ps1 | iex` → `Downloading shelfkit 0.1.0-rc.8 for x86_64-pc-windows-msvc`, `Installed <dir>\shelfkit.exe`, and the PATH note.

`shelfkit install`:

- [ ] **Install into a repository with its own AGENTS.md.**

  ```bash
  mkdir -p "$APM_HOME/cli-app" && cd "$APM_HOME/cli-app"
  printf '# My app\n\nHand-written notes.\n' > AGENTS.md
  skinstall manual-test/default --url "$SK"; echo "exit $?"
  ```

  → on standard error, in order: ``Wrote apm.yml: the registry `manual-test` ($SK/apm) and manual-test/default@0.1.1, its newest version. Run this again to move to a newer one.``; ``APM reads registries only behind its experimental `registries` flag, turned on once per computer:`` and `$ uvx --from apm-cli==0.33.0 apm experimental enable registries`; ``APM sends `manual-test`'s key only to the URL its user config names for it:`` and `$ uvx --from apm-cli==0.33.0 apm config set registry.manual-test.url $SK/apm`; `$ uvx --from apm-cli==0.33.0 apm install` and APM's output; `apm.lock.yaml written by APM`; ``Added `<!-- apm:start -->` and `<!-- apm:end -->` to the end of AGENTS.md: APM writes the instructions between them, and keeps everything else in the file as it is.``; ``Wrote CLAUDE.md as `@AGENTS.md`: Claude Code reads CLAUDE.md, and the import brings AGENTS.md in.``; `$ uvx --from apm-cli==0.33.0 apm compile --target codex`; then `exit 0`. No key appears.

- [ ] **The manifest.** `cat apm.yml` → `name: cli-app`, `version: "0.0.0"`, `targets:` claude, codex, copilot, cursor, `registries:` `manual-test:` `url: "$SK/apm"`, the dependency `registry: manual-test`, `id: manual-test/default`, `version: "0.1.1"`, and the `compilation:` block.
- [ ] **AGENTS.md and CLAUDE.md.** AGENTS.md still starts `# My app` and "Hand-written notes.", then `<!-- apm:start -->`, APM's section with "Team conventions" and the link `.agents/skills/manual-test-default-docs/docs/glossary.md`, and `<!-- apm:end -->`; that file exists. CLAUDE.md is the one line `@AGENTS.md`.
- [ ] **The files each agent reads.** `.claude/commands/greet.md`, `.cursor/commands/greet.md`, `.github/prompts/greet.prompt.md`; `.claude/skills/` and `.agents/skills/` each with `release-notes/` and `manual-test-default-docs/`; `.agents/skills/release-notes/agents/openai.yaml` with `allow_implicit_invocation: false`; `.gitignore` lists `apm_modules/`.
- [ ] **No rule files.** `ls -d .claude/rules .cursor/rules .github/instructions .github/copilot-instructions.md` → four "No such file or directory".
- [ ] **Run it again.** `skinstall manual-test/default --url "$SK"` → `apm.yml already installs manual-test/default@0.1.1, its newest version, from $SK`; APM runs; AGENTS.md has one pair of markers and the hand-written lines once; CLAUDE.md is still one line.
- [ ] **Move to a newer version.** In the clone, change the greet prompt's text, set `"version": "0.1.2"`, `shelfkit publish`, commit, and `skgit push shelf main`. Back in `cli-app`, `skinstall manual-test/default --url "$SK"` → ``Updated apm.yml: the registry `manual-test` ($SK/apm) and manual-test/default@0.1.2, its newest version. …``, then `The pin moved, so the lockfile moves with it:` and `$ uvx --from apm-cli==0.33.0 apm update --yes manual-test/default`; `.claude/commands/greet.md` has the new text.
- [ ] **A CLAUDE.md that is a link.** `mkdir -p "$APM_HOME/link-app" && cd "$APM_HOME/link-app" && ln -s AGENTS.md CLAUDE.md && skinstall manual-test/default --url "$SK"` → no line about CLAUDE.md; `CLAUDE.md` is still a symbolic link to AGENTS.md, which holds the markers and the section.
- [ ] **Errors that explain.** In an empty folder: `skinstall default --url "$SK"` → ``shelfkit: `default` is not a profile: name it as <shelf>/<profile>, as the shelf's Install page shows it``; `SHELFKIT_KEY=sko_not-a-key skinstall manual-test/default --url "$SK"` → ``shelfkit: $SK does not know the key this computer holds for it: it was revoked or mistyped. Run `shelfkit login $SK` with a key that can read `manual-test` ``; `skinstall manual-test/nope --url "$SK"` → `shelfkit: $SK has no profile manual-test/nope: check the name on the shelf's Install page, or publish it with` the command that publishes, `shelfkit publish`; `skinstall` with no profile → ``shelfkit: <folder> has no apm.yml. Name a profile to install (`shelfkit install <shelf>/<profile> --url https://<host>`), or run `shelfkit compile` from a shelf``. Each exits 1.
- [ ] **A private shelf with no key.** `shelfkit logout "$SK"`, then `skinstall manual-test/default --url "$SK"` in an empty folder → ``shelfkit: the shelf `manual-test` on $SK is private. Once per computer, run `shelfkit login $SK`, which signs this computer in through your browser, then run this again``. `shelfkit login "$SK"` and approve; run it again → installed.

Pasting the page's steps:

- [ ] **The CLI's terminal steps.** In a new folder `"$APM_HOME/paste-cli"`, save the copied CLI "Terminal" steps as `steps.sh` (`wl-paste > steps.sh`, or with an editor) and run `HOME="$APM_HOME" XDG_CONFIG_HOME="$APM_HOME/.config" bash -e steps.sh` → the release CLI lands in `$APM_HOME/.local/bin`; `shelfkit login` opens the approval page (approve it); the install ends with the same files as above. A new "CLI on `<hostname>`" row appears in Settings.
- [ ] **APM alone's terminal steps.** Make a read key (Settings → "Keys", "Read the shelf", "Create key", "Copy"). In a new folder, save APM alone's "Terminal" steps as `steps.sh` and run them the same way; at `read -rs` paste the key → installed with stock APM: AGENTS.md has the section, CLAUDE.md is `@AGENTS.md`, and `.claude/commands/greet.md` exists. Revoke the key afterwards.
- [ ] **The prompt for an agent (optional).** In a new folder, give a fresh Claude Code or Codex session the copied "Ask your agent" prompt → it runs `shelfkit install manual-test/default --url $SK`, reports the files it wrote, and never asks for or shows a key.

## Gotchas

- `/install.sh` and `/install.ps1` install the release named by the deployment's version, so a deployment and its CLI move together: deploy before testing the scripts, or they hand out the release the last deploy named.
- Both the page's APM-alone `apm.yml` and `shelfkit install` pin the newest published version exactly (`version: "0.1.1"`), not a range; running `shelfkit install` again is what moves it.
- `skinstall` runs with `APM_HOME` as HOME, so it finds no remembered deployment: keep `--url "$SK"`. The keychain is still the real one.
- `shelfkit install` exits with APM's own code when an APM step fails.
- A pasted login from the release CLI replaces the keychain's key for `$SK` with a new CLI key: the baseline's `skkey` keeps working, and Settings lists one more CLI sign-in.
