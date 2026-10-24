/** What the Worker knows of a shelf's repository: the types `ShelfRepository` speaks, and its branch. */
import type { GitMode } from "@shelfkit/engine";

/** A Git tree entry, flattened: a path from the repository's root. */
export interface RepositoryEntry {
  readonly path: string;
  /** `100644`, `100755`, `120000` (a symbolic link), or `160000` (a submodule). */
  readonly mode: GitMode;
  /** 40 lowercase hex digits. */
  readonly id: string;
}

/** The commit at the head of a repository's default branch. */
export interface RepositoryHead {
  readonly commit: string;
  readonly tree: string;
  readonly message: string;
}

/** What pushing a commit answered. `conflict`: the branch is no longer at the commit the push started from. */
export type Pushed =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "conflict" | "failed";
      readonly message: string;
    };

/** One request of a Git smart HTTP exchange, relayed to a shelf's repository. */
export interface GitExchange {
  /** `read` for clone and fetch, `write` for push. */
  readonly scope: "read" | "write";
  /** `info/refs?service=<service>`, `git-upload-pack`, or `git-receive-pack`. */
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly headers: Headers;
  readonly body: BodyInit | null;
}

export interface ShelfRepository {
  /**
   * The head of a branch, the shelf's by default, or with `null` of whatever the repository's `log` starts from:
   * an imported repository answers only that way. Null when the repository does not exist or has no commit yet.
   */
  readonly head: (
    shelf: string,
    branch?: string | null
  ) => Promise<RepositoryHead | null>;
  /** Every blob, symbolic link, and submodule under `tree`, recursively, by path. */
  readonly entries: (shelf: string, tree: string) => Promise<RepositoryEntry[]>;
  /** The bytes of a blob. */
  readonly blob: (shelf: string, id: string) => Promise<Uint8Array>;
  /**
   * Send a `git-receive-pack` request the engine prepared (`Engine.gitCommit`), creating the repository first when
   * it does not exist. `parent` is the commit the branch must still be at.
   */
  readonly push: (
    shelf: string,
    request: Uint8Array,
    parent: string | null
  ) => Promise<Pushed>;
  /**
   * Relay one request of a Git client's exchange to the shelf's repository, with a token minted for it alone, and
   * answer with the repository's response. A push (`write`) creates a repository that does not exist yet; a read of
   * one answers null.
   */
  readonly exchange: (
    shelf: string,
    request: GitExchange
  ) => Promise<Response | null>;
}

/** The repository exists, but Artifacts is still creating, importing, or forking it. */
export class RepositoryPendingError extends Error {
  override readonly name = "RepositoryPendingError";
}

/** The branch every shelf's repository indexes. */
export const REPOSITORY_BRANCH = "main";
