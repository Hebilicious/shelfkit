# Publishing

`shelfkit publish` packages every profile of the shelf in the current directory and publishes it to the deployment's registry at the profile's `version`; it uploads no shelf files, which reach the deployment only through Git. A published version is immutable: the same bytes again are reported and left, other bytes under the same version fail until the profile gets a new version. Each published profile is also a Git repository of its own, `$SK/git/<shelf>/<profile>.git`, which nobody pushes to: every published version is a commit of exactly its archive's files, tagged `v<version>`, and `main` is the newest. APM installs a profile from that repository with a version range as the `ref` and no experimental flag, or from the registry with its experimental registry client, and gets the same files either way. `shelfkit publish` ends by printing both forms of `apm.yml`.

## Sub-features

- `publish-every-profile` publishes each profile at its `version`, and prints how APM installs one, both ways.
- `publish-immutable` reports a version published with the same bytes, and fails on one published with other bytes.
- `publish-needs-version` refuses a shelf with a profile that has no version.
- `profile-repository` serves `$SK/git/<shelf>/<profile>.git`: each version a commit tagged `v<version>`, its parent the version before, `main` the newest.
- `profile-repository-files` holds exactly the files of the registry's archive for that version.
- `profile-repository-no-push` answers a push with 403.
- `profile-repository-private` needs a key that can read the package, as the registry does.
- `apm-from-git` installs with `{ git: <url>, ref: "^x.y.z" }` and no experimental flag.
- `apm-from-registry` installs with `{ id: <shelf>/<profile>, version: "^x.y.z" }` behind `apm experimental enable registries`.

## How to get to it (user POV)

- Terminal, in the clone: `shelfkit publish` (to `$SK`, the deployment `shelfkit login` remembered, or `--url`). Ready when `shelfkit --help` lists `publish`.
- Git: `$SK/git/manual-test/default.git`, after the first publish.
- APM: an `apm.yml` with one of the two forms `shelfkit publish` prints.
- The registry: `$SK/apm/v1/packages/manual-test/default/versions`.
- The web UI shows what was published on Profiles ("In this shelf's registry as …", [Profiles](profiles.md)) and on the Install page ([Installing](install.md)).

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), and the clone `~/manual-test/shelf`, pulled, with `profiles/default.json` at `"version": "0.1.0"`.
- No version of `manual-test/default` published yet. On a later run, use the next unused patch version wherever these checks say `0.1.0` and `0.1.1`.

Publishing:

- [ ] **Publish.** `cd ~/manual-test/shelf && shelfkit publish` → `Published manual-test/default@0.1.0 (sha256:<64 hex>).`, a blank line, then:

  ```text
  To install manual-test/default with APM, add to apm.yml, from its Git repository:

  dependencies:
    apm:
      - git: https://shelfkit.hebilicious.workers.dev/git/manual-test/default.git
        ref: "^0.1.0"

  or from the registry, after `apm experimental enable registries` once:

  registries:
    shelfkit:
      url: https://shelfkit.hebilicious.workers.dev/apm
    default: shelfkit
  dependencies:
    apm:
      - id: manual-test/default
        version: "^0.1.0"
  ```

- [ ] **The same bytes again.** `shelfkit publish` → `manual-test/default@0.1.0 is already published with these bytes.`, the same two forms, exit 0.
- [ ] **Other bytes, same version.** `printf 'Say hello to {{who}}, kindly.\n' > items/prompts/greet/prompt.md && shelfkit publish; echo "exit $?"` → ``shelfkit: manual-test/default@0.1.0 is already published with other bytes, and a version is immutable: give the profile a new `version` `` on standard error, and `exit 1`.
- [ ] **A new version.** `jq '.version = "0.1.1"' profiles/default.json > p.tmp && mv p.tmp profiles/default.json && shelfkit publish` → `Published manual-test/default@0.1.1 (sha256:<64 hex>).` and the two forms with `^0.1.1`. Commit and push it: `git commit -am "Default 0.1.1" && skgit push shelf main`.
- [ ] **No version, no publish.** `cp profiles/default.json /tmp/default.json && jq 'del(.version)' /tmp/default.json > profiles/default.json && shelfkit publish; echo "exit $?"` → ``profiles/default.json: a profile needs a `version`, a semantic version such as `0.1.0`: it is the version the profile publishes as``, `shelfkit: 1 error(s)`, and `exit 1`; nothing is published. Put it back: `cp /tmp/default.json profiles/default.json`.
- [ ] **The registry lists both.** `skcurl "$SK/apm/v1/packages/manual-test/default/versions" | jq -c '[.versions[].version]'` → `["0.1.1","0.1.0"]`, newest first.

Each published profile's repository:

- [ ] **A private shelf's needs a key.** `GIT_TERMINAL_PROMPT=0 git ls-remote "$SK/git/manual-test/default.git"` → `fatal: could not read Username for '$SK': terminal prompts disabled`.
- [ ] **A tag per version.** `skgit ls-remote "$SK/git/manual-test/default.git"` → `HEAD`, `refs/heads/main`, `refs/tags/v0.1.0`, and `refs/tags/v0.1.1`; `HEAD` and `main` are the commit `v0.1.1` names.
- [ ] **One commit per version, in publish order.** `skgit clone "$SK/git/manual-test/default.git" /tmp/package && git -C /tmp/package log --format='%an <%ae> | %s'` → `ShelfKit <registry@shelfkit.invalid> | manual-test/default 0.1.1`, then the same for `0.1.0`.
- [ ] **A version's files are its archive's.** `git -C /tmp/package switch --detach v0.1.0 && mkdir /tmp/archive && skcurl "$SK/apm/v1/packages/manual-test/default/versions/0.1.0/download" | tar -xz -C /tmp/archive && diff -r -x .git /tmp/package /tmp/archive && echo same` → `same`. The files include `apm.yml`, `.apm/prompts/greet.prompt.md`, `.apm/skills/manual-test-default-docs/SKILL.md`, `.apm/skills/release-notes/agents/openai.yaml`, and `.github/instructions/team-conventions.instructions.md`.
- [ ] **Nobody pushes to it.** `git -C /tmp/package switch -q main && git -C /tmp/package commit --allow-empty -m x && skgit -C /tmp/package push origin HEAD:main` → `The requested URL returned error: 403`; `skcurl "$SK/git/manual-test/default.git/info/refs?service=git-receive-pack"` → ``{"detail":"a published profile's repository is written by publishing the profile (`shelfkit publish`), not by a push","status":403,"title":"Forbidden"}``. `rm -rf /tmp/package /tmp/archive`.
- [ ] **A profile never published.** `skcurl "$SK/git/manual-test/nope.git/info/refs?service=git-upload-pack"` → `{"detail":"this shelf has published no such profile","status":404,"title":"Not Found"}`.

Installing with APM:

- [ ] **From Git, with no flag.** Make the shelf public (Settings → "Make it public"), and use an APM home where no experimental flag was ever turned on: `export APM_HOME="$(mktemp -d)" && mkdir -p "$APM_HOME/git-app" && cd "$APM_HOME/git-app"`, then write `apm.yml`:

  ```bash
  cat > apm.yml <<EOF
  name: git-app
  version: 0.0.0
  targets: [claude, codex]
  dependencies:
    apm:
      - git: $SK/git/manual-test/default.git
        ref: "^0.1.0"
  EOF
  apm install
  ```

  → APM installs `manual-test/default`: `.claude/commands/greet.md`, `.claude/skills/release-notes/`, and `.agents/skills/release-notes/agents/openai.yaml` exist, and `grep -c "$(skgit ls-remote "$SK/git/manual-test/default.git" refs/tags/v0.1.1 | cut -f1)" apm.lock.yaml` is at least 1: the range `^0.1.0` resolved to the tag `v0.1.1`.

- [ ] **From the registry, behind the flag.** In a second folder, `mkdir -p "$APM_HOME/registry-app" && cd "$APM_HOME/registry-app"`, write the registry form `shelfkit publish` printed, with `name: registry-app`, `version: 0.0.0`, and `targets: [claude, codex]` above it, then `apm experimental enable registries && apm install` → the same files; `diff -r "$APM_HOME/git-app/.claude" "$APM_HOME/registry-app/.claude"` prints nothing.
- [ ] **A private registry needs the key.** Make the shelf private again. In `registry-app`, `rm -rf apm_modules apm.lock.yaml .claude .agents && apm install` → APM fails for want of a key (check the wording). Then `apm config set registry.shelfkit.url "$SK/apm" && APM_REGISTRY_TOKEN_SHELFKIT="$(skkey)" apm install` → installed again.
- [ ] **A private shelf's Git repository, through the environment (optional).** In `git-app`, `rm -rf apm_modules apm.lock.yaml .claude .agents && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Bearer $(skkey)" apm install` → installed, if APM's Git passes its environment on (not tried).

## Gotchas

- `shelfkit publish` packages the files in the current directory, not the hosted shelf's: commit and push what you publish, or the hosted shelf and its published versions drift apart.
- Leave the shelf private when these checks end: Settings → "Make it private".
- `^0.1.0` is `>=0.1.0 <0.2.0`: a range follows patch releases in `0.x`, so publish `0.1.1`, not `0.2.0`, to see it move.
- APM 0.33.0 lists a Git dependency's tags over `https://` even when its URL is `http://` with `allow_insecure: true` (an APM bug, still on its `main`: semver resolution drops the `http` transport). So against local mode's `http://127.0.0.1:8787`, a range such as `ref: "^0.1.0"` fails with `Git failed during ls-remote (exit 128)`; an exact tag (`ref: v0.1.0`) with `allow_insecure: true` and `apm install --allow-insecure` installs. `Skipping 127.0.0.1/git/...` is only the lockfile's key, which never holds a port. APM sends no key over plain `http`, so only a public shelf installs there.
- Every `apm` and `shelfkit install` here runs with `APM_HOME` as its HOME, so `apm experimental enable registries` and `apm config set` never touch your real APM settings. A new `APM_HOME` starts with the flag off.
