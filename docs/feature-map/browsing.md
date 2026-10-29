# Browsing a shelf

The home screen lists the shelves you can read, and goes straight to the only one when there is one. A shelf opens on its Shelf section: a sidebar lists every kind of item, empty ones too, grouped by what they do ("For you", "What the agent knows", "What the agent can use"), beside everything on the shelf, one kind's page (what it is, what the agent gets, an example, and where it goes), or one item's page. An item page shows its content as text and the exact files installing it writes, in plain words rather than the format's terms. Once a shelf has loaded, moving between sections and items never waits on the network. A private shelf opened by a browser that cannot read it says so and stays still.

## Sub-features

- `home-list` lists your shelves with their item and profile counts and a `public` badge; one shelf opens directly.
- `home-empty` tells an owner with no shelf to push one with `git push $SK/git/<id>.git main`, or import one.
- `sidebar` lists every kind, with a count, under "For you", "What the agent knows", and "What the agent can use", below "Everything".
- `everything` shows the shelf's name, "How a shelf works" (Collect, Pick, Install), search, tags, and every item grouped by kind.
- `kind-page` shows one kind: what it is, "What the agent gets", "For example", "Where it goes", and its items.
- `search` finds items as you type, in the whole shelf or one kind; `/` focuses it.
- `bulk-select` selects items and adds them to a new or existing profile.
- `item-page` shows the item's kind in a sentence, its content as text, and the tabs "What it installs", "Used by", "History", "Origin", "Scans", "Files".
- `item-installs` names each agent's file or folder, and shows the exact text the agent gets.
- `instant-navigation` paints sections and items with no loading state once the shelf has loaded; `g` and a letter go to a section.
- `live` shows "● live" while the page receives changes made elsewhere.
- `private-signed-out` shows "No shelf `<id>`" and "It may be private. Sign in to read it." without reloading.

## How to get to it (user POV)

- `$SK/`, the home screen. Ready when "Your shelves" lists `manual-test` with "4 items · 1 profiles", or, for an account that reads one shelf, when the address becomes `/shelves/<that shelf>`.
- `$SK/shelves/manual-test`, or "Shelf" in the "Shelf sections" navigation (Shelf, Profiles, Repositories, Import, Settings). Ready when the sidebar "What the shelf holds" shows "Everything 4" and the heading `manual-test`.
- A kind's page: its sidebar entry, a group heading in the item list, or `$SK/shelves/manual-test/<slug>`, with the slugs `instructions`, `tech-stacks`, `library-notes`, `skills`, `docs`, `mcp-servers`, `agents`, `hooks`, `language-servers`, and `plugins`. Prompts have their own screen, [Prompts](prompts.md).
- An item's page: its title in a list, or `$SK/shelves/manual-test/items/<id>`. Ready when the heading is the item's title, above the tab "What it installs".
- The keyboard: `?` or the "? Keys" button in the header opens "Keyboard"; `g` then `s`, `l`, `p`, `a`, `i`, or `,` goes to Shelf, Prompts, Profiles, Repositories, Import, or Settings.

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), with the test shelf pushed; the browser signed in as the owner, at 1440×900 or wider.
- A private window, not signed in, for the last checks.

- [ ] **The home screen.** Open `$SK/` → "ShelfKit", the lead "One place for the prompts, skills, conventions and MCP servers your coding agents use, and a way to install the right set of them into any repository.", and "Your shelves" with a row `manual-test`, its id, "4 items · 1 profiles", and no `public` badge.
- [ ] **The sidebar.** Open `manual-test` → the sidebar reads "Everything 4"; "For you": "Prompts 1"; "What the agent knows": "Instructions 1", "Tech stacks 0", "Library notes 0", "Skills 1", "Docs 1"; "What the agent can use": "MCP servers 0", "Agents 0", "Hooks 0", "Language servers 0", "Plugins 0". Hovering "Library notes" shows "What an agent needs to know to use one library or tool the way this shelf wants it used."
- [ ] **Everything.** → the heading `manual-test`; "How a shelf works": "Collect", "Pick", "Install"; a search box `Search the shelf…  ( / )`; the items grouped under "Prompts", "Instructions", "Skills", and "Docs", each group heading a link to its kind's page with a sentence about the kind; the head of the list "4 items" and "x selects the highlighted item".
- [ ] **A kind's page.** Click "Instructions" in the sidebar → the heading "Instructions", "The rules of one project or team, written for the agent. Unlike library notes and tech stacks, they are not about a particular tool.", then "What the agent gets", "For example", and "Where it goes" with "Codex, Cursor, Copilot" → `AGENTS.md, between <!-- apm:start --> and <!-- apm:end -->` and "Claude Code" → `CLAUDE.md, which imports AGENTS.md with @AGENTS.md`, and the note "An AGENTS.md you wrote stays yours: …"; below, the search box `Search instructions…  ( / )` and "Team conventions".
- [ ] **An empty kind.** Click "Tech stacks" → its guide, then "This shelf has no tech stacks yet. Import some, or add them to the shelf repository and push it."
- [ ] **The docs kind.** Click "Docs" → "A longer document instructions point to. It costs the agent nothing until it reads it." and "Glossary"; "Where it goes" names `.agents/skills/<shelf>-<profile>-docs/<path>` and, for Claude Code, a second copy under `.claude/skills/`.
- [ ] **Search.** On Everything, press `/` → the search box has focus; type `merged` → only "release-notes", with a "Skill" badge, since only its text says "merged"; clear it → all four.
- [ ] **A skill's page, in plain words.** Open "release-notes" → "← Skills"; the heading `release-notes`; "Add to a profile"; "Delete"; "Imported · version `<8 hex>`, updated …"; "**Skill** · Know-how for one kind of task, loaded on demand rather than in every session." with "What the agent gets:" and "Every skill on this shelf"; "Files in this skill" with `SKILL.md`; no `vendored`, `coordinate`, or revision hash shown as a label anywhere on the page.
- [ ] **What it installs.** The "What it installs" tab → "Installing a profile that includes it puts it in these files of the repository:", "Claude Code" `.claude/skills/release-notes/ (the whole folder)` and "Codex, Copilot, Cursor" `.agents/skills/release-notes/ (the whole folder)`; "**Only when asked.** SKILL.md sets `disable-model-invocation: true`, so no agent uses this skill on its own; you run it by name. Claude Code, Cursor, and Copilot read that from SKILL.md, and Codex from `agents/openai.yaml`, which the installed skill gets."; "ShelfKit writes its text into the profile's own APM package, in the repository, so it installs with nothing else to fetch."; and two panels "The text the agent gets", for `.apm/skills/release-notes/SKILL.md` and `.apm/skills/release-notes/agents/openai.yaml` (`policy:` `allow_implicit_invocation: false`).
- [ ] **The other tabs.** On "Glossary": "Used by (1)" → "Needed by" "Team conventions", a link to it; "History (1)" → one version marked `current`; "Origin" → a table of where it came from; "Scans" → "What security scanners said about each version of this item. Not scanned is not the same as clean." and "No scanner has looked at this item."; "Files" → "The files that define this item in the shelf's repository, under `glossary`." with `item.json` open and `doc.md`.
- [ ] **Add to a profile from the list.** On Everything, tick "Select Greet" and "Select Glossary" → "2 selected", "Add to" with "a new profile" and "Default", "Add to profile", "Clear". Click "Clear" → the bar goes away.
- [ ] **Navigation never waits.** With the browser's developer tools open on Network, filtered to `graphql`, click through Everything, each kind in the sidebar, and back → every page paints at once, with no loading text, and no request to `/graphql` goes out for a kind's page. Opening an item paints at once too, its title and content first.
- [ ] **The keyboard.** Press `g` then `p` → Profiles; `g` then `s` → Shelf; on Everything, `j` and `k` move the highlight and `Enter` opens the highlighted item; `?` → the "Keyboard" dialog listing these, "Close" closes it.
- [ ] **Live.** The navigation shows "● live" (its title "Changes made elsewhere appear here as they happen"). Leave the greet prompt's page open while a push changes it ([Git](git.md), "A push is indexed") → the page updates with no reload.
- [ ] **A private shelf, signed out.** In the private window, open `$SK/shelves/manual-test` → "No shelf `manual-test`", "It may be private. Sign in to read it." with "Sign in" linking to `/sign-in?next=/shelves/manual-test`. Watch it for 10 seconds with developer tools on Network → it does not blink or reload, and no new request goes to `/graphql`.
- [ ] **Signed out, the home screen.** In the private window, open `$SK/` → "Sign in to open your shelf, or open a shelf someone shared with you." and "Sign in".
- [ ] **No shelf yet (local mode).** In [local mode](local-mode.md), on fresh state, open `$SK/` signed in as the owner → "There is no shelf yet. Push one from its repository with `git push http://127.0.0.1:8787/git/<id>.git main`, or import one."
- [ ] **An empty shelf names a way to fill it that exists (local mode).** Push a shelf whose `items/` is empty and open it → "This shelf is empty. Import items, or push its files: git push `$SK`/git/<shelf>.git main", with the deployment's own address.

## Gotchas

- The home screen goes straight to a shelf only when the account reads exactly one; the owner of production reads several, so it shows the list.
- Counts in the sidebar are of the whole shelf; a search narrows the list, not the counts.
- An item page prefetches its details when its title is hovered or focused, so a first visit by typing its address may show its content a moment after its title.
