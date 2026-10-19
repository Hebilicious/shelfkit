/**
 * `Forge` over GitHub's REST API: resolve the ref to a commit, list the commit's tree, and download each blob of the
 * shelf. A token (the Worker secret `GITHUB_TOKEN`) is needed only for a private repository; ShelfKit creates none.
 */
import * as v from "valibot";

import type { Forge, ForgeSnapshot } from "./index.ts";

const API = "https://api.github.com";

const RepositorySchema = v.object({ default_branch: v.string() });
const CommitSchema = v.object({
  commit: v.object({ tree: v.object({ sha: v.string() }) }),
  sha: v.string(),
});
const TreeSchema = v.object({
  tree: v.array(
    v.object({
      mode: v.string(),
      path: v.string(),
      sha: v.string(),
      type: v.string(),
    })
  ),
  truncated: v.boolean(),
});

/** The most blobs a shelf may have, so a wrong `root` cannot download a monorepo. */
const MAX_FILES = 2000;

/** A repository's default branch, read with the forge's JSON reader. */
async function defaultBranch(
  json: (
    path: string,
    schema: typeof RepositorySchema
  ) => Promise<v.InferOutput<typeof RepositorySchema>>,
  base: string
): Promise<string> {
  const repository = await json(base, RepositorySchema);
  return repository.default_branch;
}

export class GitHubForge implements Forge {
  readonly name = "github";
  readonly snapshot: Forge["snapshot"];

  constructor(fetcher: typeof fetch, token?: string) {
    const get = async (
      path: string,
      accept = "application/vnd.github+json"
    ): Promise<Response> => {
      const headers = new Headers({
        accept,
        "user-agent": "shelfkit",
        "x-github-api-version": "2022-11-28",
      });
      if (token !== undefined && token !== "") {
        headers.set("authorization", `Bearer ${token}`);
      }
      const response = await fetcher(`${API}${path}`, { headers });
      if (!response.ok) {
        throw new Error(`GitHub answered ${response.status} for ${path}`);
      }
      return response;
    };
    const json = async <const TSchema extends v.GenericSchema>(
      path: string,
      schema: TSchema
    ) => {
      const response = await get(path);
      return v.parse(schema, await response.json());
    };

    this.snapshot = async (repository, ref, root): Promise<ForgeSnapshot> => {
      const base = `/repos/${repository}`;
      const wanted = ref ?? (await defaultBranch(json, base));
      const commit = await json(
        `${base}/commits/${encodeURIComponent(wanted)}`,
        CommitSchema
      );
      const tree = await json(
        `${base}/git/trees/${commit.commit.tree.sha}?recursive=1`,
        TreeSchema
      );
      if (tree.truncated) {
        throw new Error(
          `${repository}'s tree is too large for GitHub to list in one response`
        );
      }
      const prefix =
        root === undefined || root === "" || root === "."
          ? ""
          : `${root.replace(/\/+$/u, "")}/`;
      const entries = tree.tree.filter(
        (entry) => entry.path.startsWith(prefix) && entry.type === "blob"
      );
      const links = entries.filter((entry) => entry.mode === "120000");
      if (links.length > 0) {
        throw new Error(
          `symbolic links are not allowed in a shelf: ${links.map((entry) => entry.path).join(", ")}`
        );
      }
      const shelf = entries
        .map((entry) => ({
          path: entry.path.slice(prefix.length),
          sha: entry.sha,
        }))
        .filter(
          (entry) =>
            entry.path === "shelf.json" ||
            /^(?:items|bundles|profiles)\//u.test(entry.path)
        );
      if (shelf.length > MAX_FILES) {
        throw new Error(
          `the shelf has ${shelf.length} files; the most an index reads is ${MAX_FILES}`
        );
      }
      const files = await Promise.all(
        shelf.map(async (entry) => {
          const blob = await get(
            `${base}/git/blobs/${entry.sha}`,
            "application/vnd.github.raw"
          );
          return {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            path: entry.path,
          };
        })
      );
      return { commit: commit.sha, files, ref: wanted, repository };
    };
  }
}
