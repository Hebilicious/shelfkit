/**
 * Each published profile as a Git repository of its own, `/git/{shelf}/{profile}.git`, which nobody pushes to: every
 * version the registry published is a commit of its archive's files on `main`, tagged `v{version}` (`crates/registry`'s
 * `git` module). APM installs `{ git: <url>, ref: ^1.0.0 }` from it with no experimental flag, resolving the range
 * against the tags, and gets the files its registry client gets for that version.
 *
 * The registry is the source of truth, and a package's repository follows it. A publish commits its version before it
 * answers, and a clone or a fetch first commits every version the repository lacks, in the order they were published,
 * so a version whose commit failed is committed by the next read. The repositories are the Worker's own, as the
 * archives are, so they live in R2 under `packages/` and `LocalRepository` serves them, with or without Artifacts.
 */
import type { GitVersionRequest } from "@shelfkit/engine";

import { engine } from "./engine.ts";
import { LocalRepository } from "./repository/local.ts";
import { archiveKey } from "./storage/objects.ts";

/** Where the packages' repositories live in the bucket. */
export const PACKAGES_PREFIX = "packages/";

/** How many times committing starts over when another request committed a version first. */
const ATTEMPTS = 5;

/** A version as the registry recorded it. */
export interface PublishedVersion {
  readonly version: string;
  /** `sha256:<hex>`, of the archive. */
  readonly digest: string;
  /** RFC 3339, in UTC. */
  readonly publishedAt: string;
}

/** The packages' repositories, each named `{shelf}/{profile}`. */
export function packageRepository(env: Env): LocalRepository {
  return new LocalRepository(env.BLOBS, PACKAGES_PREFIX);
}

/** The bytes of a published archive. */
async function archiveOf(
  bucket: R2Bucket,
  digest: string
): Promise<Uint8Array> {
  const sha256 = digest.slice("sha256:".length);
  const found = await bucket.get(archiveKey(sha256));
  if (found === null) {
    throw new Error(`R2 has no archive ${archiveKey(sha256)}`);
  }
  return new Uint8Array(await found.arrayBuffer());
}

/**
 * Commit every version of the package `name` (`{shelf}/{profile}`) that its repository lacks, in the order of
 * `versions`, which is the order they were published. Two requests committing the same version make the same commit;
 * the one that loses starts over from the references the other wrote.
 */
export async function commitVersions(
  env: Env,
  name: string,
  versions: readonly PublishedVersion[]
): Promise<void> {
  const repository = packageRepository(env);
  const shelfEngine = await engine();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt reads the references the one before lost to.
    const refs = (await repository.references(name)) ?? {};
    const missing = versions.filter(
      (published) => refs[`refs/tags/v${published.version}`] === undefined
    );
    let raced = false;
    for (const published of missing) {
      // Each version's parent is the one committed before it.
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
      const head = await repository.head(name);
      const base =
        head === null
          ? []
          : // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
            await repository.entries(name, head.tree);
      const request: GitVersionRequest = {
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        archive: await archiveOf(env.BLOBS, published.digest),
        base: base.map(({ id, mode, path }) => ({ id, mode, path })),
        package: name,
        publishedAt: Math.floor(Date.parse(published.publishedAt) / 1000),
        version: published.version,
      };
      const planned = shelfEngine.gitVersion(
        head === null ? request : { ...request, parent: head.commit }
      );
      if (!planned.ok) {
        throw new Error(
          `committing ${name} ${published.version}: ${planned.errors.map((error) => error.message).join("; ")}`
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
      const pushed = await repository.push(
        name,
        planned.value.request,
        head?.commit ?? null
      );
      if (!pushed.ok) {
        if (pushed.reason !== "conflict") {
          throw new Error(
            `committing ${name} ${published.version}: ${pushed.message}`
          );
        }
        raced = true;
        break;
      }
    }
    if (!raced) {
      return;
    }
  }
  throw new Error(
    `${name}'s repository kept moving while its versions were committed`
  );
}
