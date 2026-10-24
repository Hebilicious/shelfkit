/**
 * `ShelfRepository` over Cloudflare Artifacts: one repository per shelf, named by the shelf's id, in the namespace the
 * `ARTIFACTS` binding names. The binding reads commits, trees, and blobs and mints repository tokens; it cannot write,
 * so a commit is pushed over Git's smart HTTP protocol with a write token that lives for a minute. Tokens never leave
 * the Worker: a Git client reaches a repository through the Worker's own Git route, which mints one per request.
 */
import type { GitMode } from "@shelfkit/engine";
import * as v from "valibot";

import { engine } from "../engine.ts";
import { REPOSITORY_BRANCH, RepositoryPendingError } from "./model.ts";
import type {
  GitExchange,
  Pushed,
  RepositoryEntry,
  RepositoryHead,
  ShelfRepository,
} from "./model.ts";

/** Where a repository answers Git, and the token for one exchange with it. */
interface Remote {
  readonly url: string;
  readonly token: string;
}

/** The shortest token Artifacts mints, in seconds: long enough for one Git exchange. */
const TOKEN_SECONDS = 60;

/** The most entries a shelf's repository may hold, so a wrong repository cannot make the index read a monorepo. */
const MAX_ENTRIES = 5000;

/** How long to wait for a repository Artifacts is still creating, in milliseconds. */
const CREATE_WAIT_MS = 10_000;

/** What the binding throws: an `ArtifactsError`, whose `code` says why. */
const ArtifactsErrorSchema = v.object({
  code: v.string(),
  name: v.literal("ArtifactsError"),
});

const PENDING = new Set([
  "CREATE_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
]);

/** Each kind of tree entry that is not a tree, by the mode the engine names it with. */
const MODES: Readonly<
  Record<Exclude<ArtifactsTreeEntryType, "tree">, GitMode>
> = {
  blob: "100644",
  exec: "100755",
  gitlink: "160000",
  symlink: "120000",
};

/** A tree entry's mode, as the engine names it. */
function modeOf(entry: ArtifactsTreeEntry, path: string): GitMode {
  if (entry.type === "tree") {
    throw new Error(`\`${path}\` is a tree, not a file`);
  }
  return MODES[entry.type];
}

export class ArtifactsRepository implements ShelfRepository {
  readonly #binding: Artifacts;
  /** How the Worker reaches a repository's Git remote: the platform's `fetch`, or a test's stand-in. */
  readonly #fetch: typeof fetch;

  constructor(binding: Artifacts, fetcher: typeof fetch) {
    this.#binding = binding;
    this.#fetch = fetcher;
  }

  /** Run `use` with the repository's capability, released afterwards; null when the repository does not exist. */
  async #withRepo<T>(
    shelf: string,
    use: (repo: ArtifactsRepo) => Promise<T>
  ): Promise<T | null> {
    const found = await this.#tryRepo(shelf, use);
    if (found.kind === "pending") {
      throw new RepositoryPendingError(
        `the repository ${shelf} is not ready yet; try again`
      );
    }
    return found.kind === "used" ? found.value : null;
  }

  /** The repository's capability, creating the repository when it does not exist. */
  async #ensureRepo<T>(
    shelf: string,
    use: (repo: ArtifactsRepo) => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + CREATE_WAIT_MS;
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt waits on the one before: create, then get.
      const found = await this.#tryRepo(shelf, use);
      if (found.kind === "used") {
        return found.value;
      }
      if (found.kind === "missing") {
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
          await this.#binding.create(shelf, {
            description: `ShelfKit shelf ${shelf}`,
            setDefaultBranch: REPOSITORY_BRANCH,
          });
        } catch (error) {
          if (
            !v.is(ArtifactsErrorSchema, error) ||
            error.code !== "ALREADY_EXISTS"
          ) {
            throw error;
          }
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `the repository for ${shelf} is still being created; try again`
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- waiting for Artifacts to finish creating the repository.
      await scheduler.wait(500);
    }
  }

  async #tryRepo<T>(
    shelf: string,
    use: (repo: ArtifactsRepo) => Promise<T>
  ): Promise<
    | { readonly kind: "used"; readonly value: T }
    | { readonly kind: "missing" }
    | { readonly kind: "pending" }
  > {
    let repo: ArtifactsRepo;
    try {
      repo = await this.#binding.get(shelf);
    } catch (error) {
      if (v.is(ArtifactsErrorSchema, error) && error.code === "NOT_FOUND") {
        return { kind: "missing" };
      }
      if (v.is(ArtifactsErrorSchema, error) && PENDING.has(error.code)) {
        return { kind: "pending" };
      }
      throw error;
    }
    try {
      return { kind: "used", value: await use(repo) };
    } finally {
      repo[Symbol.dispose]();
    }
  }

  readonly head = async (
    shelf: string,
    branch: string | null = REPOSITORY_BRANCH
  ): Promise<RepositoryHead | null> =>
    await this.#withRepo(shelf, async (repo) => {
      const [commit] = await repo.log(
        branch === null ? { limit: 1 } : { limit: 1, ref: branch }
      );
      return commit === undefined
        ? null
        : {
            commit: commit.hash,
            message: commit.message,
            tree: commit.treeHash,
          };
    });

  readonly entries = async (
    shelf: string,
    tree: string
  ): Promise<RepositoryEntry[]> => {
    const listed = await this.#withRepo(shelf, async (repo) => {
      const entries: RepositoryEntry[] = [];
      const walk = async (id: string, prefix: string): Promise<void> => {
        const children = await repo.readTree(id);
        if (children === null) {
          throw new Error(`the tree ${id} at \`${prefix}\` is missing`);
        }
        const subtrees: Promise<void>[] = [];
        for (const child of children) {
          const path = `${prefix}${child.name}`;
          if (child.type === "tree") {
            subtrees.push(walk(child.hash, `${path}/`));
          } else {
            entries.push({ id: child.hash, mode: modeOf(child, path), path });
          }
        }
        if (entries.length > MAX_ENTRIES) {
          throw new Error(
            `the repository has more than ${MAX_ENTRIES} files; a shelf's repository holds its shelf`
          );
        }
        await Promise.all(subtrees);
      };
      await walk(tree, "");
      return entries;
    });
    if (listed === null) {
      throw new Error(`there is no repository for ${shelf}`);
    }
    return listed;
  };

  readonly blob = async (shelf: string, id: string): Promise<Uint8Array> => {
    const bytes = await this.#withRepo(shelf, async (repo) => {
      const found = await repo.readBlob(id);
      return found === null ? null : new Uint8Array(await found.arrayBuffer());
    });
    if (bytes === null) {
      throw new Error(`the blob ${id} is missing from ${shelf}'s repository`);
    }
    return bytes;
  };

  readonly push = async (
    shelf: string,
    request: Uint8Array,
    parent: string | null
  ): Promise<Pushed> => {
    const response = await this.exchange(shelf, {
      body: Uint8Array.from(request),
      headers: new Headers({
        accept: "application/x-git-receive-pack-result",
        "content-type": "application/x-git-receive-pack-request",
      }),
      method: "POST",
      path: "git-receive-pack",
      scope: "write",
    });
    if (response === null) {
      return {
        message: `there is no repository for ${shelf}`,
        ok: false,
        reason: "failed",
      };
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      return {
        message: `the repository answered ${response.status}: ${new TextDecoder().decode(body).slice(0, 200)}`,
        ok: false,
        reason: "failed",
      };
    }
    const shelfEngine = await engine();
    const report = shelfEngine.gitReport(body);
    if (!report.ok) {
      return {
        message: report.errors.map((error) => error.message).join("; "),
        ok: false,
        reason: "failed",
      };
    }
    const { unpack, refs } = report.value;
    const refused = refs.find((ref) => !ref.ok);
    if (unpack.ok && refused === undefined && refs.length > 0) {
      return { ok: true };
    }
    const message = unpack.ok
      ? `the repository refused ${refused?.name ?? "the update"}: ${refused?.reason ?? "no reason given"}`
      : `the repository could not unpack the push: ${unpack.message}`;
    // A refused update is a conflict when the branch has moved on from `parent`: someone else pushed first.
    const head = await this.head(shelf);
    return {
      message,
      ok: false,
      reason: (head?.commit ?? null) === parent ? "failed" : "conflict",
    };
  };

  readonly exchange = async (
    shelf: string,
    request: GitExchange
  ): Promise<Response | null> => {
    const mint = async (repo: ArtifactsRepo): Promise<Remote> => {
      const [info, token] = await Promise.all([
        repo.info(),
        repo.createToken(request.scope, TOKEN_SECONDS),
      ]);
      return { token: token.plaintext, url: info.remote };
    };
    const remote =
      request.scope === "write"
        ? await this.#ensureRepo(shelf, mint)
        : await this.#withRepo(shelf, mint);
    if (remote === null) {
      return null;
    }
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${remote.token}`);
    return await this.#fetch(`${remote.url}/${request.path}`, {
      body: request.body,
      headers,
      method: request.method,
    });
  };
}
