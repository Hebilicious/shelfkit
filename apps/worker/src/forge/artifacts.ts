import { ArtifactsRepository } from "../repository/artifacts.ts";
import { RepositoryPendingError } from "../repository/index.ts";
/**
 * `Forge` for a public Git repository on any host, through Artifacts: import the branch, one commit deep, into a
 * repository of its own, read the shelf's files from it with the binding, and delete it. GitHub keeps `GitHubForge`,
 * which also reads private repositories with a token; Artifacts imports public HTTPS remotes only.
 *
 * The temporary repository is named `index.<uuid>`: a shelf's id has no `.`, so it can never be a shelf's, and a
 * published profile's (`<shelf>.<profile>`, `src/packages.ts`) would need a shelf named `index` with a profile named
 * by this random UUID.
 */
import { isShelfPath } from "../shelf/files.ts";
import type { Forge, ForgeSnapshot } from "./index.ts";

/** The most files a shelf may have, so a wrong `root` cannot read a monorepo. */
const MAX_FILES = 2000;

/** How long an import may take, in milliseconds. */
const IMPORT_WAIT_MS = 60_000;

export class ArtifactsForge implements Forge {
  readonly name = "git";
  readonly #binding: Artifacts;

  constructor(binding: Artifacts) {
    this.#binding = binding;
  }

  /** `ref` is a branch: Artifacts imports branches, not tags or commits. */
  readonly snapshot = async (
    repository: string,
    ref: string | undefined,
    root: string | undefined
  ): Promise<ForgeSnapshot> => {
    const name = `index.${crypto.randomUUID()}`;
    const imported = await this.#binding.import({
      source: { branch: ref, depth: 1, url: repository },
      target: {
        name,
        opts: {
          description: `ShelfKit index of ${repository}`,
          readOnly: true,
        },
      },
    });
    try {
      // Reading needs no Git remote: the binding reads trees and blobs.
      const reader = new ArtifactsRepository(this.#binding, fetch);
      const head = await importedHead(reader, name);
      const prefix =
        root === undefined || root === "" || root === "."
          ? ""
          : `${root.replace(/\/+$/u, "")}/`;
      const tree = await reader.entries(name, head.tree);
      const entries = tree
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
        .filter((entry) => isShelfPath(entry.path));
      const links = entries.filter(
        (entry) => entry.mode !== "100644" && entry.mode !== "100755"
      );
      if (links.length > 0) {
        throw new Error(
          `symbolic links and submodules are not allowed in a shelf: ${links.map((entry) => entry.path).join(", ")}`
        );
      }
      if (entries.length > MAX_FILES) {
        throw new Error(
          `the shelf has ${entries.length} files; the most an index reads is ${MAX_FILES}`
        );
      }
      const files = await Promise.all(
        entries.map(async (entry) => ({
          bytes: await reader.blob(name, entry.id),
          path: entry.path,
        }))
      );
      return {
        commit: head.commit,
        files,
        ref: ref ?? imported.defaultBranch,
        repository,
      };
    } finally {
      await this.#binding.delete(name);
    }
  };
}

/**
 * The imported commit, once Artifacts has finished importing it. An imported repository answers `log` only when it
 * names no ref: with `HEAD` or its branch's name, it lists nothing.
 */
async function importedHead(
  reader: ArtifactsRepository,
  name: string
): Promise<{ readonly commit: string; readonly tree: string }> {
  const deadline = Date.now() + IMPORT_WAIT_MS;
  for (;;) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- polling until the import is done.
      const head = await reader.head(name, null);
      if (head === null) {
        throw new Error("the import has no commit");
      }
      return head;
    } catch (error) {
      if (!(error instanceof RepositoryPendingError)) {
        throw error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error("the import did not finish in time; try again");
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    await scheduler.wait(1000);
  }
}
