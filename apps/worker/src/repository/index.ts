/**
 * Where a shelf's source files live: a Git repository per shelf, in Cloudflare Artifacts (`docs/PRD.md` section
 * 10.1). The repository is the source of truth; the shelf's Durable Object is its index, built from the commit at the
 * head of its default branch, and R2 holds the file bytes the index serves by `sha256`.
 *
 * Every write the Worker makes (a push of files, an edit, an import, an index from a forge) becomes a commit on that
 * branch, made by the shelf's object before it records the snapshot. A push to the repository from a Git client
 * reaches it through the Worker's own Git route (`src/git.ts`), and the object indexes the new head afterwards.
 *
 * Local mode and the tests run the same code on Miniflare's local Artifacts simulator (`scripts/local-config.ts`).
 */
import { ArtifactsRepository } from "./artifacts.ts";
import type { ShelfRepository } from "./model.ts";

export type {
  GitExchange,
  Pushed,
  RepositoryEntry,
  RepositoryHead,
  ShelfRepository,
} from "./model.ts";
export { REPOSITORY_BRANCH, RepositoryPendingError } from "./model.ts";

/** The deployment's repositories, in its Artifacts namespace. */
export function shelfRepository(env: Env): ShelfRepository {
  return new ArtifactsRepository(
    env.ARTIFACTS,
    async (input, init) => await fetch(input, init)
  );
}
