# Prompts

Prompts are the kind a person uses most, so they have a screen of their own, under "For you" in the Shelf's sidebar: a searchable list, and beside it the prompt to fill in and copy as plain text, as a `SKILL.md`, or as a slash command. A prompt is edited in place, and each save is a version in its History, with a diff, and a commit on the shelf's repository that changes only what was edited. Restoring a version makes the prompt that version again, so the History does not grow. The editor follows the prompt as it changes elsewhere until something is typed in it, and versions made within the same second list in the order they were made.

## Sub-features

- `prompt-list` lists the prompts with their favourite mark and how often each was copied, searched by title or text, filtered by "★ Favourites" or a tag.
- `prompt-fill-copy` fills a prompt's variables and copies it with "Copy prompt", "Copy as skill", or "Copy as command".
- `prompt-favourite` marks a favourite with ☆ or `f`.
- `prompt-new` creates a prompt from pasted text, offering its `{{variables}}`.
- `prompt-edit` saves an edit as a new version, which is a commit.
- `prompt-history` lists versions, newest first, with a diff of `prompt.md` and `item.json`.
- `prompt-restore` makes the prompt a chosen version again, without adding one.
- `prompt-editor-follows` updates an untouched editor when the prompt changes elsewhere, and keeps what was typed in it.
- `prompt-same-second` lists versions made within one second in the order they were made.
- `prompt-delete` deletes a prompt, with "Undo".

## How to get to it (user POV)

- The Shelf's sidebar, "For you" → "Prompts", or `$SK/shelves/manual-test/prompts`, or `g` then `l`. Ready when the heading "Prompts" sits above "New prompt" and the search box `Search prompts…  ( / )`.
- One prompt: its row in the list, or `$SK/shelves/manual-test/prompts/greet`. Ready when its title is a heading beside the tabs "Use", "Edit", and "History (n)".
- An item page's "Use this prompt" button, on a prompt's item page (`$SK/shelves/manual-test/items/greet`).

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), signed in as the owner, and the clone with the remote `shelf` ([Git](git.md)'s preconditions).
- The greet prompt's title is "Greet" and its text `Say hello to {{who}}.` (set them with "Edit" if [Git](git.md) changed them), and its "History" count noted as n.

Using a prompt:

- [ ] **A required variable.** Open "Greet" → "Variables" with `who` and a red `*`; "Copy prompt" and "Copy as skill" are disabled, "Copy as command" is not, and "Required: who" shows below them.
- [ ] **Copy the filled text.** Type `Ada` in `who`, click "Copy prompt" → the toast "Prompt copied." and "Copied (text)."; the clipboard holds `Say hello to Ada.`
- [ ] **Copy as a skill.** "Copy as skill" → "Copied as SKILL.md."; the clipboard holds `---`, `name: greet`, `description: Say hello to someone`, `---`, a blank line, and `Say hello to Ada.`
- [ ] **Copy as a slash command.** "Copy as command" → "Copied as a slash command."; the clipboard holds `---`, `description: Say hello to someone`, `argument-hint: "<who>"`, `---`, a blank line, and `Say hello to $1.`
- [ ] **The preview.** Switch "Preview format" between "Prompt", "SKILL.md", and "Slash command" → the preview shows each of the three texts; "Rendered" and "Source" switch the prompt between markdown and its source.
- [ ] **Copies are counted.** Reload → the list's "Greet" row shows `3×`.
- [ ] **Favourite.** Press `f` → the ☆ beside the title becomes ★; "★ Favourites" lists "Greet"; `f` again takes it off.

Writing and editing:

- [ ] **A new prompt.** "New prompt" → "Paste it from a chat or a doc. Write a variable as `{{name}}`." Title `Standup`, text `Summarise what I did on {{project}} yesterday.` → "Id" fills in as `standup` and "Variables: project" shows; "Create prompt" → "Created “Standup”." and the prompt opens. `skgit pull shelf main` in the clone → `items/prompts/standup/item.json` and `prompt.md` arrive.
- [ ] **Edit in place.** On "Greet": "Edit" → "Title", "Description", "Tags, comma-separated", "Offer as a slash command", and "Prompt text. Write a variable as `{{name}}`". Add a line `Keep it short.`, type `Shorter` in "What changed", "Save changes" → "Saved as a new version."; the tab reads "History (n+1)".
- [ ] **Find it by its text.** In the list, press `/` and type `short` → "Greet" is listed: only its text says "short".
- [ ] **An undeclared variable.** In "Edit", add `{{tone}}` to the text → "Used but not declared:" and a chip "+ tone"; click it → a row for `tone` under "Variables". Click "Cancel" → nothing saved.
- [ ] **The History.** "History (n+1)" → "Versions", newest first: "Shorter" marked `current`, then the version before; the diff of `prompt.md` shows `+ Keep it short.`
- [ ] **The edit is a commit.** `skgit pull shelf main && git show --stat HEAD` → the message "Shorter", changing `items/prompts/greet/prompt.md`.

Restoring:

- [ ] **Restore a version.** In "History", select the version below "Shorter", then "Restore this version" → "Restored. The prompt is that version again."; the tab still reads "History (n+1)"; "Edit" shows the text without `Keep it short.`
- [ ] **The restored version is the current one.** In "History" → the restored version carries the `current` badge; the item page, `$SK/shelves/manual-test/items/greet`, reads `version <the restored version's 8 characters>`.
- [ ] **The files are that version's again.** `skgit pull shelf main` → a commit `Restore sha256-<12 hex>`; `git diff HEAD~2 HEAD -- items/prompts/greet` prints nothing: the prompt's files are the restored version's, byte for byte.
- [ ] **Restore a change of title.** "Edit": "Title" `Greeting`, "Save changes"; in "History", select the version before it, "Restore this version" → the title is "Greet" again, and `git pull` brings a commit that changes the title back.

The editor and the History's order:

- [ ] **The editor follows the prompt.** Open "Greet" → "Edit" in two browser tabs. In the second, change the text and "Save changes" → within seconds, the first tab's untouched editor shows the new text, with no reload.
- [ ] **The editor keeps what you typed.** In the first tab, type a word in the text; in the second, change the text again and save → the first tab still shows what you typed. "Cancel" there.
- [ ] **Versions within one second.** Make two edits within a second:

  ```bash
  for text in "First, greet {{who}}." "Then greet {{who}} again."; do
    skcurl -H 'content-type: application/json' "$SK/graphql" -d "$(jq -nc --arg body "$text"$'\n' --arg message "$text" \
      '{query: "mutation($body: String!, $message: String) { updatePrompt(shelf: \"manual-test\", id: \"greet\", body: $body, message: $message) { ok } }", variables: {body: $body, message: $message}}')"
  done
  ```

  → `{"data":{"updatePrompt":{"ok":true}}}` twice; "History" lists "Then greet {{who}} again." above "First, greet {{who}}.", at the same time.

Deleting:

- [ ] **Delete, then undo.** On "Standup": "Edit" → "Delete prompt" → "Deleted “Standup”." with "Undo", and it leaves the list; "Undo" (or `u`) → it is back. Delete it again and leave it deleted.

## Gotchas

- A copy counts as a use per signed-in account or key; the `3×` is this account's.
- Pull in the clone after these checks: the next file that pushes from it would otherwise be refused as not a fast-forward.
