# CLI sign-in

`shelfkit login <deployment>` signs a computer's CLI in through the browser, so nobody copies a key: the terminal shows a code and opens the deployment's approval page, the person approves it there while signed in, and the CLI picks up a key that acts as that person and keeps it in the OS keychain. Each person lists and revokes their CLIs under "CLI sign-ins" in Settings, and a revoked key fails everywhere at once. `--key`, or a standard input that is not a terminal, reads a key made in Settings instead, as CI does. `shelfkit open` uses the held key to sign a browser in. Starting, polling, and approving logins are rate limited.

## Sub-features

- `login-start` prints the approval page and an 8-character code, opens the page, and waits.
- `login-approve` makes a key named "CLI on `<hostname>`", which the CLI checks and keeps in the OS keychain.
- `login-deny` leaves the CLI with nothing.
- `login-code-page` takes a typed code, and says when a code is no longer waiting.
- `login-signed-out` sends a browser that is not signed in through sign-in and back to the approval page.
- `cli-sign-ins` lists a person's CLI keys in Settings and revokes them.
- `login-key` reads a key made in Settings (`--key`, or standard input that is not a terminal).
- `logout` removes the key from this computer's keychain.
- `open` signs a browser in with the held key, on the page a URL names.
- `rate-limits` refuse a login polled more often than every second, exactly, and too many starts per address.

## How to get to it (user POV)

- Terminal: `shelfkit login "$SK"`. Ready when standard error prints `To sign this computer in, approve the login in your browser:`, the page `$SK/cli/XXXX-XXXX`, `Check that the page shows the code XXXX-XXXX, the same as here. Approve only a code you see in your own terminal.`, then `Opened the page in your browser. Waiting for approval (Ctrl-C to stop)…`.
- Browser: `$SK/cli/XXXX-XXXX`, the page the CLI opens. Ready when it shows the heading "Sign in the ShelfKit CLI" and the code. `$SK/cli` with no code asks for one.
- Browser: any shelf's Settings, `$SK/shelves/manual-test/settings`, the "Account" panel's "CLI sign-ins" heading.
- Terminal: `shelfkit logout "$SK"`, `shelfkit open "$SK/shelves/manual-test"`, `shelfkit login --key "$SK"`.

## Driving it with a browser and a terminal

Preconditions:

- The baseline from the [map index](README.md), except `shelfkit login`, which this file tests. Run it in a real terminal, on Linux with a Secret Service (GNOME Keyring, KWallet), macOS, or Windows.
- A browser signed in to `$SK` as the owner, and a private window that is not.

Signing in and out:

- [ ] **Start a login.** `shelfkit login "$SK"` → the lines under "How to get to it" on standard error; the browser opens on `$SK/cli/XXXX-XXXX`, a code of 8 letters and digits with a dash in the middle.
- [ ] **Read the approval page.** → the heading "Sign in the ShelfKit CLI"; the same code; a note "Approve only if your own terminal shows this code right now, because you just ran `shelfkit login`. If someone sent you this page or the code, deny it: approving would give them your account."; "Computer" `<hostname> (the name it sent)`; "Signs in as" `Owner`; "May do" "Everything you can as the owner: read and change every shelf, publish profiles, and manage keys and people."; "Waits until" a time 10 minutes after the start; the buttons "Approve" and "Deny".
- [ ] **Approve.** Click "Approve" → "Approved. **CLI on `<hostname>`** is signed in as Owner: go back to your terminal." and "Its key is listed under “CLI sign-ins” in any shelf's Settings, where you can revoke it. You can close this page."; within a few seconds the terminal prints ``Logged in to $SK as the owner. The key is in the OS keychain (service `shelfkit`, account `$SK`), and $SK is the default deployment.`` and exits 0. No key appears in either.
- [ ] **The key is in the keychain.** `skkey | wc -c` → a number above 0 (a byte count, never the key).
- [ ] **The key acts as you.** `skcurl -H 'content-type: application/json' "$SK/graphql" -d '{"query":"{ viewer { authenticated owner } }"}'` → `{"data":{"viewer":{"authenticated":true,"owner":true}}}`.
- [ ] **It is listed.** Settings → "CLI sign-ins" → a table with a row "CLI on `<hostname>`", its key prefix, "Approved" and "Last used" times, and "Revoke".
- [ ] **Deny a login.** `shelfkit login "$SK"` again; on its page click "Deny" → "Denied. That CLI is not signed in and holds nothing. You can close this page."; the terminal prints ``shelfkit: the login was denied in the browser, so this computer is not signed in. Run `shelfkit login $SK` to try again`` and exits 1. The viewer check above still passes: the earlier key is untouched.
- [ ] **A used code is not waiting.** Reload the denied page → "The code `XXXX-XXXX` is not waiting for approval: it was used, denied, or has expired. Run `shelfkit login` again for a new one."
- [ ] **Type a code.** Open `$SK/cli` → "Type the code `shelfkit login` shows in your terminal.", a "Code" field (`ABCD-EFGH`) and "Continue". Start `shelfkit login "$SK"`, type its code in lower case, click "Continue" → that code's approval page. Click "Deny".
- [ ] **Approve from a signed-out browser.** Start `shelfkit login "$SK"` and open its page in the private window → "Sign in first: the CLI will act as the account you approve it with." and "Sign in". Sign in with your passkey → back on the same code's approval page. Click "Deny", and close the private window.
- [ ] **Open the web UI.** `shelfkit open "$SK/shelves/manual-test"` → `Opened $SK in your browser, signed in as you. Add a passkey there to sign in on that device without a link; the link itself works once, within 15 minutes.`; the browser shows "Sign-in link", "You are signed in as Owner.", "Add a passkey" and "Not now"; "Not now" lands on `/shelves/manual-test`.

Rate limits:

- [ ] **Polling too often.** Start a login by hand and poll it twice within a second:

      ```bash
      started=$(curl -sS -X POST -H 'content-type: application/json' "$SK/auth/cli/start" -d '{"device":"manual-test poll"}')
      jq 'del(.deviceCode)' <<<"$started"
      device=$(jq -r .deviceCode <<<"$started")    # this login's secret: never approve its code
      poll() { curl -sS -i -X POST -H 'content-type: application/json' "$SK/auth/cli/poll" -d "{\"deviceCode\":\"$1\"}"; }
      sleep 2; poll "$device" | tail -n 1; poll "$device" | grep -i '^HTTP\|^retry-after\|^{'
      poll "${device%%.*}.wrong" | tail -n 1
      ```

      → the start prints `expiresIn` `600`, `interval` `2`, a `userCode`, and `verificationUrl` `$SK/cli/<userCode>`; the first poll `{"status":"pending"}`; the second `429`, `retry-after: 2`, and `{"detail":"this login was polled again too soon: poll it every 2 seconds","status":429,"title":"Too Many Requests"}`; the wrong secret `{"status":"expired"}`. Open `$SK/cli/<userCode>` and click "Deny".

- [ ] **Starting too many logins (optional).** `for i in $(seq 60); do curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' "$SK/auth/cli/start" -d '{"device":"manual-test burst"}'; done | sort | uniq -c` → some `429` among the `200`; then, within the minute, `shelfkit login "$SK"` → ``shelfkit: $SK has started too many logins from this address in the last minute: run `shelfkit login $SK` again in <n> seconds``.

A key from Settings, then revoking:

- [ ] **No terminal, no browser.** `shelfkit login "$SK" < /dev/null` → `shelfkit: no key given`, and no browser opens: without a terminal, login reads a key from standard input.
- [ ] **A key made in Settings, as CI.** Settings → "Keys": "New key's name" `manual-test CI`, tick "Read the shelf", "Create key" → "Copy this key now; it is not shown again." with the key and "Copy". Click "Copy", then "Done". Run `shelfkit login --key "$SK"` → `Key for $SK: ` with nothing echoed; paste → ``Logged in to $SK as a key of the shelf `manual-test`. …`` (check the wording), and the viewer check now answers `"owner":false`.
- [ ] **Revoke the Settings key.** Keys → that row's "Revoke", then "Revoke: sure?" → "Key revoked. It fails everywhere from the next request." and a `revoked` badge; the viewer check now answers HTTP 401.
- [ ] **Revoke a CLI sign-in.** `shelfkit login "$SK"` and approve, so the keychain holds a CLI key again. In "CLI sign-ins", click "Revoke" on the row approved last, then "Revoke: sure?" → "Revoked. That CLI is signed out." and the row is gone; the viewer check answers HTTP 401, and `skgit ls-remote "$SK/git/manual-test.git"` is refused (Git asks for a user name, or fails with 401).
- [ ] **Log out.** `shelfkit logout "$SK"` → `Removed the key for $SK from the OS keychain.`; again → `The OS keychain held no key for $SK.`
- [ ] **Sign in for the other files.** `shelfkit login "$SK"` and approve → the viewer check passes as the owner.

## Gotchas

- `shelfkit login --key`, or a login whose standard input is not a terminal, replaces the key the keychain holds for `$SK`. The other files need the owner's CLI key, so finish with a browser login, as the last check does.
- `shelfkit logout` forgets the key on this computer only. The key stays valid, and listed under "CLI sign-ins", until it is revoked there.
- Approve only a code your own terminal shows. Every check above that is not "Approve" denies its login, so no stray key is made; a login nobody answers expires after 10 minutes, and a key approved but never picked up is revoked then.
- Cloudflare's rate limiter counts per location and approximately: the PRD records a Preview that refused 40 starts in a minute only after the 48th. The poll limit is exact, because the login's own object counts it.
- Each approval adds a row to "CLI sign-ins". Revoke the ones you no longer use when the run ends.
