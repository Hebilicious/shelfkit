# Profiles and the profile editor

A profile is the set of items one kind of repository gets. The Profiles screen lists every profile with what it installs, its problems, and whether the shelf's registry has it, and leads to two pages: Install, the default, and Edit, the profile editor (which was "Compose"). The editor shows the shelf's items, the profile, what it installs with its problems, and the `apm.yml` installing it writes, compiled in the browser as you edit. Every profile has a version, the semantic version it publishes as: a new profile starts at `0.1.0`, and one with no version is a problem that stops it installing and saving.

## Sub-features

- `profiles-list` lists each profile with its item count and names, its problems and warnings, its registry name once published, and "Install", "Edit", and "Delete".
- `profile-new` opens the editor on a new profile, from "New profile", from an item's "Add to a profile", or from items selected on the Shelf.
- `profile-version` gives a new profile the Version `0.1.0`, and refuses one without a version in the editor's Problems and on save.
- `profile-problems` lists problems by weight: "Must fix before it installs", "Warnings" (a skill's frontmatter), and "Notes".
- `profile-preview` shows "What installing writes": the `apm.yml`, the copied files, and the plan, compiled in the browser.
- `profile-save` saves the profile as a commit, with a note, or reverts it.
- `profile-delete` deletes a profile, with "Undo".

## How to get to it (user POV)

- The "Shelf sections" navigation → "Profiles", `$SK/shelves/manual-test/profiles`, or `g` then `p`. Ready when the heading "Profiles" sits above the list with "Default" and its `default` badge.
- "Edit" on a profile's row, or `$SK/shelves/manual-test/compose/default`. Ready when the heading reads "Edit Default" and the status beside it reads "compiled in your browser".
- "New profile" on Profiles, or `$SK/shelves/manual-test/compose`. Ready when the heading reads "New profile".
- "Add to a profile" on an item's page (`$SK/shelves/manual-test/compose?add=<id>`), and "Add to profile" for items selected on the Shelf.
- "Edit profile" on a profile's Install page; "Install…" in the editor, for a saved profile with nothing unsaved.

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), signed in as the owner; the head of `manual-test` loads (Settings shows no refused head).
- The clone with the remote `shelf`, pulled.

- [ ] **The list.** Open Profiles → "A profile is the set of items one kind of repository gets: …"; a row "Default" with `default` (hovered: "What shelfkit compile installs when no profile is named"), "4 items: Glossary, Greet, release-notes, Team conventions" (in some order, with the greet prompt under its current title), "1 warning", and the buttons "Install", "Edit", and "Delete"; "New profile" above.
- [ ] **Its registry name.** After [Publishing](publishing.md) published Default, the row adds "In this shelf's registry as `manual-test/default`"; clicking the name → "Registry name copied." and the clipboard holds `manual-test/default`.
- [ ] **The editor.** "Edit" on Default → "← Profiles", "Edit Default", "compiled in your browser", "Install…", "Note about this change (optional)", "Revert" (disabled), and "Save profile"; the panes "Items on this shelf", the profile's "Title", "Id" (read-only), "Version" (`0.1.0`), and "Description" with "Items in this profile", "What this profile installs", "What installing writes", and "Which tech stacks match a repository".
- [ ] **A skill frontmatter warning.** "What this profile installs" → "Problems": "Warnings (1)", whose message starts "`disable-model-invocation` is not an agentskills.io key", on `items/skills/release-notes/SKILL.md`.
- [ ] **What installing writes.** The "apm.yml" tab → the manifest, with `compilation:` `strategy: single-file`, `agents_md:` `mode: managed_section`, and `resolve_links: false`, "Copy apm.yml", and the install command; "Copied files (n)" lists `.apm/skills/manual-test-default-docs/…` and `.apm/skills/release-notes/agents/openai.yaml` among them.
- [ ] **No version, a problem.** Empty the "Version" field → "unsaved" appears; within a second "Problems" shows "Must fix before it installs (1)": "a profile needs a `version`, a semantic version such as `0.1.0`: it is the version the profile publishes as", on `profiles/default.json`; "What installing writes" reads "This profile cannot be installed yet: the problems listed beside it say why."; the Version field shows the placeholder `0.1.0`.
- [ ] **No version, no save.** Click "Save profile" → above the panes, in red, ``<profile>: `version` must be a semantic version, such as `0.1.0` ``; nothing is committed (`skgit pull shelf main` brings nothing).
- [ ] **Revert.** Click "Revert" → "Reverted to the saved profile." with "Undo", and "Version" reads `0.1.0` again.
- [ ] **A version that is not semantic.** Type `one` in "Version" → "Problems" shows `` `version` `one` is not a semantic version (`MAJOR.MINOR.PATCH`, with an optional `-prerelease` and `+build`) `` on `profiles/default.json`; "Save profile" refuses it as above. Click "Revert".
- [ ] **A new profile starts at 0.1.0.** Profiles → "New profile" → "New profile", "Id" editable, and "Version" `0.1.0`. "Title" `Prompts only` → "Id" becomes `prompts-only`; add "Greet" from "Items on this shelf" (its "Add Greet" button) → it appears under "Items in this profile", and "Problems" reads "None.".
- [ ] **Save is a commit.** "Note about this change" `A prompts-only profile`, "Save profile" → "Saved profile “Prompts only”.", the address becomes `/compose/prompts-only`, "unsaved" goes; `skgit pull shelf main && git show --stat HEAD` → the message "A prompts-only profile", adding `profiles/prompts-only.json`, which has `"version": "0.1.0"`.
- [ ] **From an item.** On the "Glossary" item's page, "Add to a profile" → a new profile in the editor with "Glossary" already in it. Leave without saving.
- [ ] **From the Shelf.** On Everything, tick "Select Glossary", choose "Prompts only" under "Add to", click "Add to profile" → "Edit Prompts only" with "Glossary" added to its items and "unsaved". Click "Revert".
- [ ] **Delete, then undo.** Profiles → "Delete" on "Prompts only" → "Deleted profile “Prompts only”." with "Undo", and the row goes; "Undo" → it is back. Delete it again and leave it deleted.

## Gotchas

- The editor compiles the profile in the browser with the WebAssembly engine, and says so ("compiled in your browser"); "compiled on the server" means the preview came from the Worker instead.
- A profile's `version` is its own and is not inherited through "Also include profile".
- A published version is immutable: the editor does not bump `version` for you, so a profile changed after [Publishing](publishing.md) needs a new version before `shelfkit publish` takes it.
- "Install…" in the editor shows only for a saved profile with nothing unsaved.
