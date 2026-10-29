# Deployment

What an operator meets when setting up and previewing a deployment. `moon run worker:setup` now also makes the Artifacts namespace the Worker binds (`shelfkit`), which holds each shelf's Git repository: in the jurisdiction `--artifacts-jurisdiction eu|us` names, or unrestricted without it, through Artifacts' REST API with the token of the Wrangler login it runs as. A namespace that exists in another jurisdiction stops setup, since a jurisdiction cannot change. `moon run worker:preview` uploads the checked-out branch as a Worker Preview named after the branch, with Durable Objects and rate limiters of its own, and its repositories in the Artifacts namespace `shelfkit-preview`, which every Preview shares.

## Sub-features

- `setup-namespace` reports the Artifacts namespace and its jurisdiction, and creates it when it is missing.
- `setup-jurisdiction` refuses a jurisdiction the namespace does not have, and a value other than `eu` or `us`.
- `setup-dry-run` says what setup would do, and creates and deploys nothing.
- `health` answers `/health` with the deployment's version.
- `preview` deploys a branch as a Worker Preview with its own state, its repositories in the `shelfkit-preview` namespace.
- `preview-push` indexes a `git push` to a Preview before the push returns, with no queue consumer.

## How to get to it (user POV)

- Terminal, at the repository's root: `moon run worker:setup -- <options>`, with the account as `CLOUDFLARE_ACCOUNT_ID` when Wrangler can reach more than one. Ready when it prints `==> Wrangler's account`.
- Terminal: `moon run worker:preview`, with `CLOUDFLARE_ACCOUNT_ID`.
- `$SK/health`.

## Driving it with a browser and a terminal

Preconditions:

- A checkout of `manual-testing` with `pnpm install` run, and Wrangler signed in to the production account (`wrangler whoami`).
- `export ACCOUNT=<the production account's id>`.

- [ ] **Health.** `curl -s "$SK/health"` → `{"ok":true,"version":"0.1.0-rc.8"}`.
- [ ] **The namespace, in the EU.** `CLOUDFLARE_ACCOUNT_ID=$ACCOUNT moon run worker:setup -- --dry-run --artifacts-jurisdiction eu` → among its steps, `==> Artifacts namespace shelfkit (eu), for each shelf's Git repository` and `    exists, eu`; later `    would deploy`, and at the end `Dry run: nothing was created or deployed.`
- [ ] **Without the flag.** `CLOUDFLARE_ACCOUNT_ID=$ACCOUNT moon run worker:setup -- --dry-run` → `==> Artifacts namespace shelfkit (unrestricted), for each shelf's Git repository` and `    exists, eu`: an existing namespace is kept as it is.
- [ ] **Another jurisdiction stops setup.** `CLOUDFLARE_ACCOUNT_ID=$ACCOUNT moon run worker:setup -- --dry-run --artifacts-jurisdiction us` → setup stops after the namespace step with `the Artifacts namespace shelfkit: it exists, eu, and a namespace's jurisdiction cannot change: name another namespace in wrangler.jsonc's ARTIFACTS binding` (printed as a Node error, check the wording), before any deploy step.
- [ ] **Not a jurisdiction.** `moon run worker:setup -- --dry-run --artifacts-jurisdiction de` → ``--artifacts-jurisdiction is `eu` or `us` ``, and nothing else runs.
- [ ] **A new namespace (optional, a throwaway account).** On a Cloudflare account with no ShelfKit, `moon run worker:setup -- --artifacts-jurisdiction eu` → `    created, eu` at the namespace step, then the rest of setup; `wrangler artifacts namespaces get shelfkit --json` shows `"jurisdiction": "eu"`; the owner's first `git push` to `<deployment>/git/<shelf>.git` creates a shelf. Tear it down as the README's "Self-hosting" section says.
- [ ] **A Preview.** On a branch of your own, `CLOUDFLARE_ACCOUNT_ID=$ACCOUNT moon run worker:preview` → Wrangler uploads the Worker and prints the Preview's address, which carries the branch's name (check the wording); `<preview>/health` → `{"ok":true,"version":"0.1.0-rc.8"}`; `<preview>/shelves/manual-test` → "No shelf `manual-test`": the Preview's Durable Objects are its own, so production's shelves are not there.
- [ ] **A Preview indexes a push.** With the Preview base config's owner key (see the gotchas) in place of the production one: `skgit push <preview>/git/preview-test.git main` from a copy of the clone whose `shelf.json` names `preview-test` → once `git push` returns, `<preview>/shelves/preview-test` lists the shelf's items, with no wait; `CLOUDFLARE_ACCOUNT_ID=$ACCOUNT cf artifacts namespaces repos list --namespace shelfkit-preview` lists `preview-test`, and production's `shelfkit` namespace does not.
- [ ] **A Preview publishes into its own namespace.** `shelfkit publish --url <preview>` in that copy → `Published preview-test/default@...`; `skgit ls-remote <preview>/git/preview-test/default.git` lists `refs/tags/v<version>`, and the `shelfkit-preview` namespace now holds `preview-test.default`.

## Gotchas

- `--dry-run` reads the account through Wrangler (`whoami`, the secrets' names, the namespace) and changes nothing; without it, setup deploys production. Never run setup without `--dry-run` against production as a test.
- Setup makes no Cloudflare token of its own: it calls Artifacts' REST API with `wrangler auth token`, so a namespace it cannot create is a Wrangler login problem (`wrangler login`).
- A Preview runs no queue consumers and no crons, so imports and "Copy the shelf" never run there: test those on production. A push is the exception, because the Git route indexes it before answering.
- Every Preview shares the `shelfkit-preview` namespace, and deleting a Preview leaves its repositories there: name a shelf made on a Preview after its branch, and delete its repositories with `cf artifacts` when the branch is done.
- A Preview's secrets are the Preview base config's (`wrangler preview base-config secret put`), not production's: signing in to one needs that config's owner key.
