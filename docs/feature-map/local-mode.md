# Local mode

`moon run worker:dev` runs the whole deployment on one computer with no Cloudflare account: the Worker on Miniflare, and every Git repository, each shelf's and each published profile's, in Cloudflare's local Artifacts simulator. A person meets it at `http://127.0.0.1:8787`, with the same screens, Git remotes, and registry as production.

## Sub-features

- `local-simulator` keeps every repository in the local Artifacts simulator, served with `git http-backend`.
- `local-persist` keeps shelves and repositories across a restart.
- `local-import` copies a shelf from an `https://` Git URL through the simulator's import.

## How to get to it (user POV)

- Terminal, at the repository's root: `moon run worker:dev`. Ready when Wrangler prints `Ready on` and the address.
- The browser at `http://127.0.0.1:8787`, signed in with a link from `shelfkit open --print`.
- Git and the CLI against `http://127.0.0.1:8787`.

## Driving it with a browser and a terminal

Preconditions:

- Git 2.32 or newer on `PATH`: the simulator serves repositories with `git http-backend`.
- A checkout of `manual-testing` with `pnpm install` run, so the simulator's patches in `patches/` are applied (the repository's README, "Local mode", says why they exist).
- With no owner key the Worker authenticates nobody, so start it with a test key's hash and a session secret, as the browser tests do:

  ```bash
  export SK=http://127.0.0.1:8787
  export SHELFKIT_KEY=sko_e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee   # the browser tests' owner key, a test value
  moon run worker:dev -- --var "OWNER_KEY_HASH:$(printf %s "$SHELFKIT_KEY" | sha256sum | cut -d' ' -f1)" \
    --var SESSION_SECRET:local-session-secret-0123456789abcdef
  skkey() { printf %s "$SHELFKIT_KEY"; }                                  # in place of the keychain lookup
  shelfkit open --print "$SK"                                              # a sign-in link for the browser
  ```

- [ ] **The simulator is on.** The `worker:dev` output lists the binding as `env.ARTIFACTS (shelfkit)  Artifacts  local`, not `remote`; the first `git push` to `$SK/git/<shelf>.git` creates the shelf, and `ls .wrangler/state` (in `apps/worker`) shows the simulator's state beside the rest.
- [ ] **Local state survives a restart.** Stop `worker:dev`, start it again, and clone the shelf → the clone has every commit pushed before the restart.
- [ ] **Copy a shelf from any Git host (new here).** On the Shelf's "Copy the shelf", give an `https://` URL of a public repository that holds a shelf → the simulator imports it, as Artifacts does on production, and the shelf gains its items. Local mode runs the queue, so this is the one place to try it without a deployment.

## Gotchas

- APM 0.33.0 lists a Git dependency's tags over `https://` even when its URL is `http://` with `allow_insecure: true` (an APM bug, still on its `main`: semver resolution drops the `http` transport). So against local mode's `http://127.0.0.1:8787`, a range such as `ref: "^0.1.0"` fails with `Git failed during ls-remote (exit 128)`; an exact tag (`ref: v0.1.0`) with `allow_insecure: true` and `apm install --allow-insecure` installs. `Skipping 127.0.0.1/git/...` is only the lockfile's key, which never holds a port. APM sends no key over plain `http`, so only a public shelf installs there.
- A new shelf is free, so the [Git](git.md) workflow that moves a directory out with `git subtree split` is tested here.
- The address the simulator gives a repository's own remote changes on every start; the Worker's `$SK/git/...` addresses do not.
