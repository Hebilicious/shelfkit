/**
 * Reading a GitHub repository over GitHub's REST API and raw file host: the Worker has no `git`, and a sync clone
 * would be the wrong cost for listing a few directories. Only github.com is read; another host is refused with a
 * message, because a quiet partial answer would look like an empty repository.
 */
import * as v from "valibot";

import { getBytes, getJson, HttpError } from "./http.ts";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_RAW = "https://raw.githubusercontent.com";

/** `owner/repo` on github.com. */
export interface Repository {
  readonly owner: string;
  readonly name: string;
}

/** `https://github.com/o/r(.git)`, `github.com/o/r`, or `o/r`. */
export function parseRepository(repo: string): Repository {
  const trimmed = repo
    .trim()
    .replace(/^https:\/\//u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  const segments = trimmed.split("/");
  const [host, owner, name] =
    segments.length === 2 ? ["github.com", ...segments] : segments;
  if (
    host?.toLowerCase() !== "github.com" ||
    owner === undefined ||
    name === undefined ||
    owner === "" ||
    name === "" ||
    segments.length > 3
  ) {
    throw new Error(
      `\`${repo}\` is not a github.com repository; the hosted importer reads GitHub only`
    );
  }
  return { name, owner };
}

/** The canonical `https://github.com/o/r` URL, which is what an item's `source.repo` records. */
export function repositoryUrl(repository: Repository): string {
  return `https://github.com/${repository.owner}/${repository.name}`;
}

const RepoSchema = v.object({ default_branch: v.string() });

const CommitSchema = v.object({ sha: v.string() });

const TreeSchema = v.object({
  sha: v.string(),
  tree: v.array(
    v.object({
      mode: v.optional(v.string()),
      path: v.string(),
      sha: v.string(),
      size: v.optional(v.number()),
      type: v.string(),
    })
  ),
  truncated: v.optional(v.boolean()),
});

/** The Git file mode of a symbolic link. */
const SYMLINK_MODE = "120000";

export interface TreeEntry {
  /** Relative to the repository root. */
  readonly path: string;
  /** A blob that is a symbolic link: its content is the path it points to, not a file. */
  readonly symlink?: boolean;
  readonly sha: string;
  readonly type: "blob" | "tree";
  readonly size: number;
}

/** A GitHub client bound to one repository and one optional token. */
export class GitHub {
  readonly repository: Repository;
  private readonly fetcher: typeof fetch;
  private readonly token: string | undefined;

  constructor(fetcher: typeof fetch, repository: Repository, token?: string) {
    this.fetcher = fetcher;
    this.repository = repository;
    this.token = token;
  }

  private api(path: string): string {
    return `${GITHUB_API}/repos/${this.repository.owner}/${this.repository.name}${path}`;
  }

  /** The default branch, or `null` when the repository is not there (or is private and no token was given). */
  async info(): Promise<{ defaultBranch: string } | null> {
    const repo = await getJson(
      this.fetcher,
      this.api(""),
      RepoSchema,
      this.token
    );
    if (repo === null) {
      return null;
    }
    return { defaultBranch: repo.default_branch };
  }

  /** The commit a ref resolves to now, or `null` when the ref is not there. */
  async commit(ref: string): Promise<string | null> {
    const found = await getJson(
      this.fetcher,
      this.api(`/commits/${encodeURIComponent(ref)}`),
      CommitSchema,
      this.token
    );
    return found === null ? null : found.sha;
  }

  /** One tree, by its SHA (or a commit's). `prefix` is the tree's path, prepended to every entry. */
  async tree(
    sha: string,
    prefix: string,
    recursive: boolean
  ): Promise<TreeEntry[]> {
    const url = this.api(`/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
    const tree = await getJson(this.fetcher, url, TreeSchema, this.token);
    if (tree === null) {
      throw new HttpError(url, 404, "no such tree");
    }
    if (tree.truncated === true) {
      throw new Error(
        `${url}: GitHub truncated the listing; import a narrower \`path\``
      );
    }
    return tree.tree.flatMap((entry): TreeEntry[] => {
      if (entry.type !== "blob" && entry.type !== "tree") {
        return [];
      }
      const listed: TreeEntry = {
        path: prefix === "" ? entry.path : `${prefix}/${entry.path}`,
        sha: entry.sha,
        size: entry.size ?? 0,
        type: entry.type,
      };
      return [
        entry.mode === SYMLINK_MODE ? { ...listed, symlink: true } : listed,
      ];
    });
  }

  /**
   * Walk from a commit's root to `path`, one directory at a time, and answer the entry at `path` (`null` when it is
   * not there) and the listing of every directory on the way, root first. Each step is one small request, so reading
   * one directory of a large repository never lists the whole of it.
   */
  async walk(
    commit: string,
    path: string
  ): Promise<{
    entry: TreeEntry | null;
    ancestors: { path: string; entries: TreeEntry[] }[];
  }> {
    const segments = path === "" ? [] : path.split("/");
    const ancestors: { path: string; entries: TreeEntry[] }[] = [];
    let sha = commit;
    let here = "";
    let entry: TreeEntry | null = {
      path: "",
      sha: commit,
      size: 0,
      type: "tree",
    };
    for (const segment of segments) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each directory is found in its parent's listing.
      const entries = await this.tree(sha, here, false);
      ancestors.push({ entries, path: here });
      const next = here === "" ? segment : `${here}/${segment}`;
      entry = entries.find((candidate) => candidate.path === next) ?? null;
      if (entry === null) {
        return { ancestors, entry: null };
      }
      if (entry.type === "blob") {
        return { ancestors, entry };
      }
      ({ sha } = entry);
      here = next;
    }
    return { ancestors, entry };
  }

  /**
   * A file's bytes at a commit, or `null` when it is not there. With a token, through the API (the only origin a
   * token is sent to); without one, from GitHub's raw file host, which has no rate limit to spend.
   */
  async raw(commit: string, path: string): Promise<Uint8Array | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    if (this.token !== undefined) {
      return await getBytes(
        this.fetcher,
        this.api(`/contents/${encoded}?ref=${commit}`),
        {
          accept: "application/vnd.github.raw",
          token: this.token,
        }
      );
    }
    return await getBytes(
      this.fetcher,
      `${GITHUB_RAW}/${this.repository.owner}/${this.repository.name}/${commit}/${encoded}`
    );
  }
}
