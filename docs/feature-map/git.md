# The shelf as a Git repository

Each hosted shelf is the Git repository `$SK/git/<shelf>.git`, and Git is the one way a checkout's files reach it: `shelfkit push` and `shelfkit fetch` are gone. Git clones, fetches, and pushes it with a key, given as HTTP Basic (any user name, the key as the password) or as a Bearer header; a public shelf clones with no key, and the owner's first push creates a shelf. After a push the Worker indexes the new head. A head the engine cannot load is refused: Settings' Repository panel shows it with its errors, and the shelf stays at the last commit that loaded until a push fixes it. Every change made in the UI is a commit that `git pull` brings back, and an edit changes only what it edits. A shelf of its own has the deployment as a remote; a shelf inside a larger repository is a submodule of it; and `git subtree split` moves a directory out with its history.

## Sub-features

- `first-push` the owner's first push creates a shelf.
- `no-upload-command` the CLI has no `push` or `fetch`.
- `key-basic` Git's password prompt takes a key; a revoked key fails at once.
- `key-bearer` a key as an `http.extraHeader` Bearer header, through the environment.
- `anonymous` a public shelf clones with no key; a private one answers 401 with a Basic challenge.
- `push-indexed` a push shows up in the UI, and in Settings' "Indexed at".
- `push-refused` a head that does not load is shown in Settings with its errors, and the shelf stays as it was.
- `ui-edit-is-a-commit` an edit in the UI (a prompt, a profile, the registry's visibility) is a commit `git pull` brings back.
- `minimal-edit` an edit rewrites only the `item.json` members it changed.
- `non-fast-forward` a push that does not fast-forward is refused, as on any Git host.
- `repository-panel` Settings → "Repository": the URL, "Copy" (the clone command), and "Indexed at".
- `submodule` a shelf inside a larger repository, pushed and pulled from inside the submodule.
- `subtree-split` a directory moved out of a larger repository into a new shelf, with its history.

## How to get to it (user POV)

- Git: `$SK/git/manual-test.git`, with `skgit` (the baseline's Bearer header), Git's own password prompt, or nothing for a public shelf.
- Settings → "Repository" panel, `$SK/shelves/manual-test/settings`. Ready when it shows "The shelf's files, as a Git repository. Clone it with a key as the password:", the URL, "Copy", and "Indexed at" with 12 hexadecimal characters.
- The home screen of an owner with no shelf names the push: see [Browsing](browsing.md).

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), with the test shelf pushed.
- In the clone, the deployment as a remote: `cd ~/manual-test/shelf && git remote add shelf "$SK/git/manual-test.git"`.

Reaching the repository:

- [ ] **The first push created the shelf.** The baseline's `skgit push` printed `* [new branch]      main -> main` → `$SK/shelves/manual-test` shows the shelf with "Everything 4"; Settings → "Repository" shows `$SK/git/manual-test.git` and "Indexed at" the first 12 characters of `git rev-parse HEAD`.
- [ ] **There is no upload command.** `shelfkit push` → `error: unrecognized subcommand 'push'`, exit 2; `shelfkit --help` lists neither `push` nor `fetch`.
- [ ] **A private shelf asks for a key.** `curl -sS -i "$SK/git/manual-test.git/info/refs?service=git-upload-pack"` → `401`, `www-authenticate: Basic realm="shelfkit", charset="UTF-8"`, and `{"detail":"this shelf's repository needs a key","status":401,"title":"Unauthorized"}`; `GIT_TERMINAL_PROMPT=0 git ls-remote "$SK/git/manual-test.git"` → `fatal: could not read Username for '$SK': terminal prompts disabled`.
- [ ] **A key as the password.** Settings → "Keys": name `manual-test git`, tick "Read the shelf", "Create key", "Copy", "Done". `git -c credential.helper= clone "$SK/git/manual-test.git" /tmp/basic-clone` → Git asks `Username for '$SK':` (type anything) and a password (paste the key) → the clone holds `shelf.json`, `profiles/`, and `items/`.
- [ ] **A revoked key fails at once.** Revoke `manual-test git` in Settings → "Keys" ("Revoke", "Revoke: sure?"), then `git -C /tmp/basic-clone -c credential.helper= fetch` and paste the same key → Git reports the authentication failed (check the wording). `rm -rf /tmp/basic-clone`.
- [ ] **A malformed key.** `curl -sS -u "x:sko_not-a-key" "$SK/git/manual-test.git/info/refs?service=git-upload-pack"` → `{"detail":"the key is not valid: it is malformed, unknown, or revoked","status":401,"title":"Unauthorized"}`.
- [ ] **A key as a Bearer header.** `skgit clone "$SK/git/manual-test.git" /tmp/bearer-clone` → cloned with no prompt, and the key was never on a command line (it reaches Git through the environment). `rm -rf /tmp/bearer-clone`.
- [ ] **A public shelf clones with no key.** Settings → "Registry" → "Make it public" → "The registry is **public**: anyone can install this shelf's profiles." and the toast "Anyone can now install this shelf's profiles." with "Undo". `GIT_TERMINAL_PROMPT=0 git clone "$SK/git/manual-test.git" /tmp/anon-clone` → cloned with no prompt. A push from it with no key (`git -C /tmp/anon-clone commit --allow-empty -m x && GIT_TERMINAL_PROMPT=0 git -C /tmp/anon-clone push`) is refused for want of a user name.
- [ ] **Back to private.** "Make it private" → "Installing from the registry now needs a key."; `GIT_TERMINAL_PROMPT=0 git -C /tmp/anon-clone fetch` now fails for want of a user name. `rm -rf /tmp/anon-clone`.
- [ ] **The visibility changes were commits.** `skgit pull shelf main` → two new commits, each changing `"public"` in `shelf.json` (`git log -2 --format='%an %s'`: `owner edit shelf.json`, check the wording).

Pushing:

- [ ] **A push is indexed.** `printf 'Say hello to {{who}}, warmly.\n' > items/prompts/greet/prompt.md && git commit -am "Warmer greeting" && skgit push shelf main` → accepted; by the time Git reports it done, `$SK/shelves/manual-test/prompts/greet`, open in the browser, shows the new text without a reload, its "History" lists "Warmer greeting" as `current`, and Settings → "Indexed at" is the first 12 characters of `git rev-parse HEAD`.
- [ ] **A head that does not load is refused.** `jq 'del(.version)' profiles/default.json > p.tmp && mv p.tmp profiles/default.json && git commit -am "Drop the version" && skgit push shelf main` → Git reports the push done, and by then Settings → "Repository" shows, in red, "The repository's head, `<12 hex>`, does not load, so the shelf stays at the commit before it. Push a fix:" and ``profiles/default.json: a profile needs a `version`, a semantic version such as `0.1.0`: it is the version the profile publishes as``; "Indexed at" is still the commit before.
- [ ] **The shelf stays as it was.** "Profiles" → "Edit" on Default → the "Version" field still holds `0.1.0`, and the greet prompt still reads "Say hello to {{who}}, warmly."
- [ ] **Writes wait for the fix.** Edit the greet prompt in the UI and click "Save changes" → refused with an error starting `<repository>:` that says the branch moved (check the wording); nothing is committed.
- [ ] **Push the fix.** `git revert --no-edit HEAD && skgit push shelf main` → by the time Git reports it done, the red panel is gone and "Indexed at" is the new head.
- [ ] **Not a fast-forward.** Edit the greet prompt in the UI and save. Without pulling, `git commit --allow-empty -m "Behind" && skgit push shelf main` → `! [rejected]        main -> main (fetch first)` and "Updates were rejected because the remote contains work that you do not have locally." Then `git reset --hard HEAD~1 && skgit pull shelf main`.

Edits made in the UI:

- [ ] **Pull an edit made in the UI.** On the greet prompt: "Edit", change the text, "What changed" `From the UI`, "Save changes" → "Saved as a new version."; `skgit pull shelf main` → a fast-forward; `git log -1 --format='%an %s'` → `Owner From the UI` (check the wording); `git show --stat HEAD` lists only `items/prompts/greet/prompt.md`.
- [ ] **An edit changes only what it edits.** Push a prompt written by hand, whose `item.json` has no `tags` or `asCommand`:

  ```bash
  mkdir -p items/prompts/wave
  printf '{\n  "id": "wave",\n  "kind": "prompt",\n  "title": "Wave",\n  "description": "Wave at someone",\n  "variables": [{ "name": "who", "required": false }]\n}\n' > items/prompts/wave/item.json
  printf 'Wave at {{who}}.\n' > items/prompts/wave/prompt.md
  git add items/prompts/wave && git commit -m "A hand-written prompt" && skgit push shelf main
  ```

  Open `$SK/shelves/manual-test/prompts/wave`: "Edit", "Title" `Waving`, "Save changes". Then `skgit pull shelf main && git show HEAD -- items/prompts/wave/item.json` → exactly one line changes, `"title": "Wave",` to `"title": "Waving",`; the other lines, their order, and the `variables` line with `"required": false` stay as written. Remove the prompt afterwards: `git rm -r -q items/prompts/wave && git commit -m "No wave" && skgit push shelf main`.

The README's workflows:

- [ ] **A shelf inside a larger repository.** Run, from an empty directory:

  ```bash
  git init -b main project && cd project && echo '# A project' > README.md && git add README.md && git commit -m "A project"
  skgit submodule add "$SK/git/manual-test.git" shelf
  git commit -m "The shelf, as a submodule"
  printf 'Say hello to {{who}}, from the project.\n' > shelf/items/prompts/greet/prompt.md
  git -C shelf commit -am "Edited in the project"
  skgit -C shelf push origin HEAD:main
  git commit -am "The shelf, updated"
  git ls-tree HEAD shelf
  ```

  → the push is accepted; the greet prompt reads "Say hello to {{who}}, from the project." in the UI; the last command prints `160000 commit <the head of git -C shelf rev-parse HEAD>	shelf`.

- [ ] **Pull the UI's edits into the submodule.** Edit the greet prompt in the UI, then `skgit -C shelf pull origin main` → the edit arrives in `shelf/`; `git commit -am "The shelf, updated again"` records the new commit in the project.
- [ ] **Clone the larger repository.** `skgit clone --recurse-submodules project project-clone` → `project-clone/shelf` holds the shelf at the commit the project records.
- [ ] **Move a directory out with its history (local mode).** In [local mode](local-mode.md), where a new shelf costs nothing:

  ```bash
  git init -b main mono && cd mono
  cp -r ~/manual-test/shelf shelf && rm -rf shelf/.git
  jq '.name = "split-test" | .registry.namespace = "split-test"' shelf/shelf.json > s.tmp && mv s.tmp shelf/shelf.json
  git add -A && git commit -m "A repository with a shelf inside"
  printf 'Say hello to {{who}}, from the monorepo.\n' > shelf/items/prompts/greet/prompt.md && git commit -am "Monorepo greeting"
  echo '# Mono' > README.md && git add README.md && git commit -m "Outside the shelf"
  git subtree split --prefix=shelf -b shelf-history
  skgit push "$SK/git/split-test.git" shelf-history:main
  git rm -r -q shelf && git commit -m "The shelf moves to its own repository"
  skgit submodule add "$SK/git/split-test.git" shelf
  git commit -m "The shelf, as a submodule"
  git branch -D shelf-history
  ```

  → the push creates `split-test`, whose page lists its items; `git -C shelf log --format=%s` lists "Monorepo greeting" and "A repository with a shelf inside", not "Outside the shelf".

## Gotchas

- A push is indexed before `git push` returns, on production and on a Worker Preview alike; the queue then retries an index that failed, so a shelf that lags its head catches up within seconds.
- While the head is refused, every write the Worker makes is refused too: UI edits, imports, "Copy the shelf", and visibility changes. Push the fix before going on.
- Git's credential helper keeps a password it was given. `-c credential.helper=` keeps the test key out of it; if one was stored, `printf 'url=%s\n\n' "$SK" | git credential reject` removes it.
- `shelf.json`'s `registry.namespace` must be the shelf's id: a head whose `shelf.json` names another namespace is refused with "`registry.namespace` is `<other>`, but this is the shelf `manual-test`".
- A change in Settings (the registry's visibility) rewrites only the `shelf.json` members that changed, so `git log -p` shows the `registry` line and nothing else.
- `git subtree split` and a push that creates a shelf are for local mode: a shelf cannot be deleted from production.
