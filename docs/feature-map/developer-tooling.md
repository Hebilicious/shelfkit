# Developer tooling

A contributor running the repository's tests can run two end-to-end runs at once, in two worktrees or in one, and a cached build of the CLI puts back the binary that build made. Nothing here is visible to a ShelfKit user.

## Sub-features

- `e2e-ports` gives each Playwright run Workers on ports the system reports free.
- `cli-build-cache` restores `target/debug/shelfkit` from moon's cache along with the build.

## How to get to it (user POV)

- Terminal: `moon run web:e2e`, in any worktree.
- Terminal: `moon run compiler:build`.

## Driving it with a browser and a terminal

Preconditions:

- Two worktrees of the repository, each with `pnpm install` run.

- [ ] **Two e2e runs at once.** In two worktrees, start `moon run web:e2e` in both at the same time → both pass; each run's Workers listen on ports the system reported free (`apps/web/test/e2e/ports.ts`), not on 8792 to 8794.
- [ ] **A cached build restores its CLI.** Run `moon run compiler:build` on one branch, switch to another and build, then switch back and build again → the third build is a cache hit, and `target/debug/shelfkit` is the first branch's binary again (`shelfkit --help` lists that branch's commands).

## Gotchas

- `SHELFKIT_E2E_PORT`, `SHELFKIT_E2E_GITHUB_PORT`, and `SHELFKIT_E2E_GITHUB_WORKER_PORT` fix the ports instead; a run with them set collides with another that sets the same.
- `moon run --force` skips the cache, so it cannot show the restore.
