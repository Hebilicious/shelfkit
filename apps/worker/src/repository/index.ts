/**
 * Where a shelf's source files live: a Git repository per shelf, in Cloudflare Artifacts (`docs/PRD.md` section
 * 10.1). The repository is the source of truth; the shelf's Durable Object is its index, built from the commit at the
 * head of its default branch, and R2 holds the file bytes the index serves by `sha256`.
 *
 * Every write the Worker makes (a push of files, an edit, an import, an index from a forge) becomes a commit on that
 * branch, made by the shelf's object before it records the snapshot. A push to the repository from a Git client
 * reaches it through the Worker's own Git route (`src/git.ts`), and the object indexes the new head afterwards.
 *
 * Artifacts has no local simulator, and never will, so a deployment without the `ARTIFACTS` binding (local mode on
 * Miniflare, with no Cloudflare account) keeps each repository in its R2 bucket and serves Git itself
 * (`LocalRepository`): the same route, the same pushes, and the same index, with no Artifacts.
 */
import { ArtifactsRepository } from "./artifacts.ts";
import { LocalRepository } from "./local.ts";
import type { ShelfRepository } from "./model.ts";

export type {
  GitExchange,
  Pushed,
  RepositoryEntry,
  RepositoryHead,
  ShelfRepository,
} from "./model.ts";
export { REPOSITORY_BRANCH, RepositoryPendingError } from "./model.ts";

/** Where the deployment keeps shelves' repositories: Artifacts, or R2 in local mode, with no `ARTIFACTS` binding. */
export function shelfRepository(env: Env): ShelfRepository {
  // SAFETY: the binding is declared, but a local configuration (`scripts/local-config.ts`) leaves it out, so it may
  // be undefined at run time whatever the generated type says.
  const binding = env.ARTIFACTS as Artifacts | undefined;
  return binding === undefined
    ? new LocalRepository(env.BLOBS)
    : new ArtifactsRepository(
        binding,
        async (input, init) => await fetch(input, init)
      );
}
