# MCP and Repositories

`/mcp` lets an agent use a shelf with no shell: a stateless MCP endpoint (revision 2026-07-28) serving ShelfKit's six tools, each named by its AcidCat capability id. A CLI key, the one `shelfkit login` keeps, now opens it as the person who approved it: the owner as the owner, anyone else with what each shelf grants them, read on every call. `shelf.compile.plan` returns the `apm.yml` a profile installs as, and `shelf.report` records that a repository installed it, which the Repositories screen (once "Activity") lists, with whether each repository is behind the profile's latest version.

## Sub-features

- `mcp-cli-key` opens `/mcp` with a CLI key, and lists the six tools.
- `mcp-read` searches a shelf, and reads an item, a profile, and recommendations for a repository's markers.
- `mcp-plan` returns a profile's install plan: `apm.yml`, its digest, the profile's revision, the files, and the install command.
- `mcp-report` records an install, which the Repositories screen shows.
- `mcp-refusals` answers a private shelf read without a key as not found, a revoked key with 401, and a report the key may not make as forbidden.
- `repositories` lists each repository's latest install of each profile, with "latest" or "behind", and every install under "Every install".

## How to get to it (user POV)

- An MCP client, or `curl`, at `$SK/mcp`, with `Authorization: Bearer <key>` and `mcp-protocol-version: 2026-07-28`.
- The "Shelf sections" navigation → "Repositories", `$SK/shelves/manual-test/activity`, or `g` then `a`. Ready when the heading "Repositories" sits beside "Profile" ("Every profile"), above "Which repositories installed which profile, and whether they have its latest version. …".

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md): the keychain holds the owner's CLI key from `shelfkit login`, which `skkey` reads.
- An MCP call as a shell function, sending the key through `skcurl` and the protocol version in its header and its `_meta`:

  ```bash
  META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}'
  mcp() { skcurl -H 'content-type: application/json' -H 'mcp-protocol-version: 2026-07-28' "$SK/mcp" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":{$META${2:+,$2}}}"; }
  ```

The tools, with a CLI key:

- [ ] **The six tools.** `mcp tools/list | jq -r '.result.tools[].name'` → `shelf.search`, `shelf.recommend`, `shelf.profile.get`, `shelf.item.get`, `shelf.compile.plan`, `shelf.report`.
- [ ] **Search.** `mcp tools/call '"name":"shelf.search","arguments":{"shelf":"manual-test","query":"hello"}' | jq '.result.structuredContent'` → `items` with the greet prompt (`"id": "greet"`, `"kind": "prompt"`, its revision and a snippet), and `"truncated": false`.
- [ ] **An item.** `mcp tools/call '"name":"shelf.item.get","arguments":{"shelf":"manual-test","item":"release-notes"}' | jq '.result.structuredContent | keys'` → `["files","item","path","revision"]`; its `files` hold `SKILL.md`.
- [ ] **A profile.** `mcp tools/call '"name":"shelf.profile.get","arguments":{"shelf":"manual-test","profile":"default"}' | jq '.result.structuredContent | keys'` → `["profile","resolution"]`, the profile with its `version`.
- [ ] **Recommendations.** `mcp tools/call '"name":"shelf.recommend","arguments":{"shelf":"manual-test","markers":{"files":["package.json"],"dependencies":["vue"]}}' | jq -c '.result.structuredContent'` → `{"items":[],"profiles":[]}`: the test shelf has no tech stack to match.
- [ ] **A plan.** `plan=$(mcp tools/call '"name":"shelf.compile.plan","arguments":{"shelf":"manual-test","profile":"default"}' | jq -c '.result.structuredContent')`; `jq -r .apmYml <<<"$plan"` → an `apm.yml` with the `compilation:` block; `jq -c '{profileRevision, apmYmlDigest, installCommand}' <<<"$plan"` → a `sha256-…` revision, a `sha256:…` digest, and `"installCommand":"apm install"`. Nothing on the shelf changes.
- [ ] **A report.** `mcp tools/call "\"name\":\"shelf.report\",\"arguments\":$(jq -c '{profileRevision, apmYmlDigest} + {shelf: "manual-test", profile: "default", repository: "github.com/me/my-app", outcome: "installed"}' <<<"$plan")" | jq -c '.result.structuredContent'` → an `id`, `recordedAt`, `currentRevision` equal to the plan's `profileRevision`, and `"stale":false`.

The Repositories screen:

- [ ] **It says what records an install.** Open Repositories → under the heading, "An install is recorded when an agent reports it with the `shelf.report` tool; installing from a profile's Install page or with `shelfkit install` records nothing here."

- [ ] **The install is listed.** Open Repositories → "1 repository; 0 behind the latest version of their profile."; a row `github.com/me/my-app`, "Default default", the revision's 8 characters with `latest`, "just now", and "Install…".
- [ ] **Every install.** "Every install (1)" → "When", "Repository", "Profile", "Version", "Result" ("Installed with APM"), and "apm.yml fingerprint".
- [ ] **Other outcomes.** Report again with `outcome: "failed"` and `message: "apm install exited 1"`, then with `outcome: "applied"` → "Every install (3)" shows "Failed" with the message under it, and "Files written".
- [ ] **Behind.** Change the greet prompt in the UI, which changes the profile's revision, and reload Repositories → the row reads `behind`, the summary "1 behind the latest version of their profile.", and the button "Update…", which opens Default's Install page.
- [ ] **Filter by profile.** "Profile" → "Default" → the same rows; "Every profile" → all.

Refusals:

- [ ] **No key, a private shelf.** `curl -sS -H 'content-type: application/json' -H 'mcp-protocol-version: 2026-07-28' "$SK/mcp" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{$META,\"name\":\"shelf.search\",\"arguments\":{\"shelf\":\"manual-test\",\"query\":\"hello\"}}}" | jq -r '.result.isError, .result.content[0].text'` → `true`, then ``{"ok":false,"error":{"_tag":"ShelfNotFound","shelf":"manual-test","message":"there is no shelf `manual-test` this key can read"}}``.
- [ ] **A revoked CLI key.** Revoke the CLI sign-in ([CLI sign-in](cli-sign-in.md)) → `mcp tools/list` answers HTTP 401 (`skcurl -o /dev/null -w '%{http_code}\n' …` with the same arguments); `shelfkit login "$SK"` and approve to go on.
- [ ] **An invited person's CLI key (optional).** Settings → "People": invite a second person with read access to `manual-test` only; they sign in with their own passkey, run `shelfkit login "$SK"` on their computer, and approve it as themselves → with their key, `tools/list` lists the six tools, `shelf.search` on `manual-test` finds the greet prompt, `shelf.search` on another shelf answers `ShelfNotFound`, and `shelf.report` on `manual-test` answers an error tagged `Forbidden` (check the wording). Remove the person afterwards.

## Gotchas

- `/mcp` holds nothing between calls: no session, so every call carries the key and the protocol version, in the header and in `_meta`. Without the `_meta`, a call answers `-32602` "Required request metadata is missing".
- A tool's failure is a result with `"isError": true` and the error as JSON text in `content`, not a JSON-RPC error.
- `shelf.compile.plan` and the other reads change nothing; only `shelf.report` writes, and only its record.
- Reports stay in the Repositories history; there is no delete. Report only `github.com/me/my-app`, or another name that is obviously a test.
- Installing from a profile's Install page or with `shelfkit install` records nothing on the Repositories screen; only `shelf.report` does, as the screen says.
