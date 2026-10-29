# Import

The Import screen brings items into the shelf from elsewhere. "Import from a source" looks through a Git repository, an APM registry, an MCP server catalog, a plugin marketplace, or another shelf in the background, then lists what it found for you to tick; a repository's AGENTS.md comes as instructions, with each doc it links to, which the instructions then require. A doc left unticked is required as the doc the shelf already has at that path. "Copy a whole shelf from GitHub" reads every item and profile of a shelf in a repository into this one: `owner/repo` through GitHub's API, and now the `https://` URL of a public Git repository on any host, through an Artifacts import, whose ref is then a branch. Every import is a commit on the shelf's repository.

## Sub-features

- `import-source` starts an import from a source ("What it is", "Repository", "URL", "Branch, tag or commit", "Folder in it") with "Look for items".
- `import-jobs` lists imports with their state: "Waiting to start", "Looking for items", "Ready: choose what to keep", "Importing", "Done", or "Failed".
- `import-pick` ticks candidates, renames them, and locks them to a ref or version, then "Import the ticked items".
- `import-agents-md` offers a repository's AGENTS.md as instructions and the docs it links to.
- `import-linked-doc` requires, for a linked doc left unticked, the doc the shelf already has at that path, and warns when more than one doc is there.
- `copy-shelf-github` copies a shelf from `owner/repo` through GitHub's API.
- `copy-shelf-any-host` copies a shelf from a public `https://` Git repository on any host, through Artifacts.
- `import-is-a-commit` brings each import back to a clone with `git pull`.

## How to get to it (user POV)

- The "Shelf sections" navigation → "Import", `$SK/shelves/manual-test/import`, or `g` then `i`. Ready when the heading "Import" sits above the two forms, "Import from a source" and "Copy a whole shelf from GitHub", and "Imports" below them.
- Settings → "Sources" saves a source the Import screen then offers under "A saved source".
- Terminal: `shelfkit add <url>` starts the same import job for a remote source ([Authoring](authoring.md) covers `shelfkit add` with a local directory).

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), on production: imports run on the deployment's queue, which neither a Worker Preview nor (for `https://` URLs) local mode can stand in for.
- The head of `manual-test` loads (Settings → "Repository" shows nothing in red), and the clone is pulled.
- For "Copy a whole shelf" from another host: an empty public repository you own on a Git host that is not GitHub, such as Codeberg or GitLab, and its `https://` clone URL, written `$ELSEWHERE` below.

Importing from a source:

- [ ] **Start an import.** "What it is" "A Git repository of skills, prompts, or a plugin"; "Repository" `https://github.com/Hebilicious/shelfkit`; "Branch, tag or commit" `published-profile-repositories`; "Look for items" → "Looking for items. They appear below for you to choose from when the search finishes."; under "Imports", a job goes from "Waiting to start" through "Looking for items" to "Ready: choose what to keep", without a reload.
- [ ] **AGENTS.md and the doc it links.** The job's table ("Item", "Id on this shelf", "Licence", "Branch, tag or commit", "Version") lists an "Instructions" candidate from `AGENTS.md`, titled "ShelfKit" (check the wording), with "Links to PRD: ShelfKit. Ticked, they come with it; left unticked, it uses the doc this shelf already has at the same path, if there is one.", and a "Doc" candidate for `docs/PRD.md`, titled "PRD: ShelfKit" (check the wording).
- [ ] **Import the doc alone.** Tick only the doc; "Id on this shelf" `prd`; "Import the ticked items" → "Importing 1 item."; the job reads "Done" and "Imported: prd"; the sidebar's "Docs" count goes up by one.
- [ ] **Then AGENTS.md, which requires the doc already there.** Start the same import again; when it is ready, tick only the "Instructions" candidate, "Id on this shelf" `shelfkit-agents`, and import it → "Done"; the "PRD: ShelfKit" doc's page, "Used by (1)", lists "Needed by" the new instructions; `skgit pull shelf main` and `jq .requires items/instructions/shelfkit-agents/item.json` → `["prd"]`.
- [ ] **It compiles with the link pointed at the copy.** In the clone, add `shelfkit-agents` to `profiles/default.json`'s `items` and run `shelfkit compile --dry-run` → among the `would vendor` lines, `vendor/default/.apm/skills/manual-test-default-docs/docs/PRD.md`; and `shelfkit compile --dry-run --json | jq -r '.files[] | select(.path | endswith("shelfkit-agents.instructions.md")) | .contents' | grep -o '([^)]*PRD.md)'` → `(.agents/skills/manual-test-default-docs/docs/PRD.md)`. Put `profiles/default.json` back.
- [ ] **Imports are commits.** `git log --format=%s -3` in the clone → one commit per import (check the wording).

Copying a whole shelf:

- [ ] **Prepare a copy on another host.** In a new clone, change the greet prompt and push it to `$ELSEWHERE`:

  ```bash
  skgit clone "$SK/git/manual-test.git" /tmp/elsewhere && cd /tmp/elsewhere
  printf 'Say hello to {{who}}, from another host.\n' > items/prompts/greet/prompt.md
  git commit -am "From another host" && git push "$ELSEWHERE" main
  ```

  `shelf.json` keeps `"namespace": "manual-test"` and `"public": false`.

- [ ] **Copy it from any host.** "Copy a whole shelf from GitHub" → "Read every item and profile of a shelf (a folder with a `shelf.json`) in a GitHub repository into this one, or from a public Git repository on any other host by its https:// URL, whose ref is then a branch."; "Repository" (`owner/repo, or https://…`) `$ELSEWHERE`, "Branch, tag or commit" `main`, "Folder" empty; "Copy the shelf" → "Copying the shelf: this one updates when that finishes."; within a minute, with no reload, the greet prompt reads "Say hello to {{who}}, from another host."
- [ ] **The copy is a commit.** `skgit pull shelf main && git log -1 --format=%s` → `git $ELSEWHERE@<commit> (main)` (check the wording), and `git show --stat HEAD` lists the greet prompt's `prompt.md`.
- [ ] **A copy from GitHub by name (optional).** Push the same change to a public GitHub repository, then "Copy the shelf" with "Repository" `<owner>/<repo>` → the same result, read through GitHub's API: the commit's subject starts with `github` (check the wording).
- [ ] **Undo the copy.** `git revert --no-edit HEAD && skgit push shelf main` → the greet prompt is back to the text before the copy.

## Gotchas

- "Copy the shelf" replaces the shelf's files with the copy's, `shelf.json` included: a copy whose `shelf.json` says `"public": true` makes the shelf public, and one whose `registry.namespace` is not `manual-test` is refused.
- A failed copy shows nothing on the screen: the shelf just does not change. The reason is only in the Worker's log (`wrangler tail`), for example `indexing <repository> into manual-test was refused`; "Copy the shelf" adds no row under "Imports". A tag or a commit in "Branch, tag or commit" fails for an `https://` URL, since Artifacts imports branches only.
- Artifacts cannot import from a `workers.dev` Worker on the same Cloudflare account, so `$SK/git/<shelf>.git` itself cannot be the source of a copy.
- GitHub imports run without a `GITHUB_TOKEN` on production (as of #34), against GitHub's limit of 60 API requests an hour per address, which Cloudflare's addresses share: an import may fail with "API rate limit exceeded". Wait and start it again.
- An import or a copy is refused while the shelf's head is refused ([Git](git.md)).
- The imported AGENTS.md and PRD stay on the shelf: a shelf's items can be deleted from their pages ("Delete"), but the test shelf itself cannot be.
