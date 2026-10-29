/**
 * Indexing a shelf from a Git forge. The forge sits behind `Forge`, so a later implementation (Cloudflare Artifacts, or
 * a Durable Object that speaks Git, `docs/PRD.md` section 13 question 3) replaces `GitHubForge` without touching the
 * rest: `indexFromForge` stores each file in R2 under `objects/<sha256>` and commits the snapshot to the shelf's
 * object.
 */
import type { Session } from "../auth/index.ts";
import { shelfStub } from "../auth/index.ts";
import type { Committed } from "../shelf/api.ts";
import { isShelfPath } from "../shelf/files.ts";
import { putObject } from "../storage/objects.ts";

/** A shelf read from a forge at one commit. Paths are relative to the shelf root. */
export interface ForgeSnapshot {
  readonly repository: string;
  /** The ref asked for, or the default branch. */
  readonly ref: string;
  /** The commit it resolved to. */
  readonly commit: string;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
}

/** A forge that can read one directory of a repository at a ref. */
export interface Forge {
  readonly name: string;
  readonly snapshot: (
    repository: string,
    ref: string | undefined,
    root: string | undefined
  ) => Promise<ForgeSnapshot>;
}

/** Read a shelf from `forge`, store its files in R2, and commit them as the shelf's snapshot. */
export async function indexFromForge(
  env: Env,
  forge: Forge,
  session: Session,
  input: {
    readonly shelf: string;
    readonly repository: string;
    readonly ref?: string;
    readonly root?: string;
  }
): Promise<Committed> {
  const read = await forge.snapshot(input.repository, input.ref, input.root);
  const stub = shelfStub(env, input.shelf);
  if (!(await stub.mayCommit(session, input.shelf))) {
    return {
      errors: [
        { message: "this key cannot write to this shelf", path: "<shelf>" },
      ],
      ok: false,
      reason: "forbidden",
    };
  }
  const files = await Promise.all(
    read.files
      .filter((file) => isShelfPath(file.path))
      .map(async (file) => ({
        path: file.path,
        sha256: await putObject(env.BLOBS, file.bytes),
        size: file.bytes.length,
      }))
  );
  await stub.recordObjects(
    session,
    input.shelf,
    files.map((file) => ({ sha256: file.sha256, size: file.size }))
  );
  return await stub.commitSnapshot(session, {
    files,
    message: `${forge.name} ${read.repository}@${read.commit} (${read.ref})`,
    origin: "forge",
    shelf: input.shelf,
  });
}
