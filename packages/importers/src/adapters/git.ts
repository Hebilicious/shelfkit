/**
 * The `git` source: a GitHub repository, read through APM's package layouts (`../layouts.ts`), pinned to the commit
 * its ref resolves to.
 *
 * Licence is per artifact: the nearest licence file to it wins (a skill's own LICENSE.txt over the repository's),
 * then the licence GitHub detected for the repository, then a SKILL.md `license` naming an SPDX licence. Without one
 * that permits copying, the artifact is link-only: its item carries the repository, path, and commit, which is all
 * APM needs to install it, and none of its text. A copied artifact keeps its upstream reference too, so compiling it
 * pins the upstream file rather than vendoring the copy; the copy is what ShelfKit previews, searches, and scans.
 *
 * Drift compares Git object ids: the artifact's blob or tree at the pinned commit against the same path at the ref's
 * head. A commit that changed other files does not move the item.
 */
import type { ItemKind } from "@shelfkit/schema";

import { frontmatter, skillProblem, stringField } from "../frontmatter.ts";
import { GitHub, parseRepository, repositoryUrl } from "../github.ts";
import type { TreeEntry } from "../github.ts";
import { byCodePoint, fileContents } from "../http.ts";
import { uniqueIds } from "../ids.ts";
import {
  importedItem,
  linkOnlyWarning,
  provenance,
  sourceOf,
  sourceSecret,
} from "../imported.ts";
import type { Artifact, InlineServer } from "../layouts.ts";
import {
  ancestry,
  basename,
  findArtifacts,
  inlineServers,
  isAgentPlugin,
  manifestsToRead,
  parent,
} from "../layouts.ts";
import type { Licence } from "../licence.ts";
import {
  classifyText,
  fromSpdx,
  fromStatement,
  isLicenceFile,
  NO_LICENCE,
} from "../licence.ts";
import type {
  AdapterContext,
  Candidate,
  Discovery,
  ImportedFile,
  ImportedItem,
  ImportSource,
  Item,
  Pick,
  SourceAdapter,
  UpstreamState,
} from "../seam.ts";

/** A copied skill is at most this many files and bytes; a larger one imports as a link. */
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

/** The file a copied artifact's content goes to in its item directory. */
const CONTENT_FILE: Partial<Record<ItemKind, string>> = {
  agent: "agent.md",
  hook: "hook.json",
  instructions: "AGENTS.fragment.md",
  plugin: "plugin.json",
  prompt: "prompt.md",
};

const COMMIT = /^[0-9a-f]{40}$/u;

/** A path from an import's `path`: relative, `/`-separated, no empty, `.`, or `..` segment. */
export function cleanPath(path: string | undefined): string {
  const trimmed = (path ?? "").replaceAll(/^\/+|\/+$/gu, "");
  if (trimmed === "") {
    return "";
  }
  if (
    trimmed.includes("\\") ||
    trimmed.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`\`${path}\` is not a clean relative path`);
  }
  return trimmed;
}

/** What one discovery read from the repository. */
interface Snapshot {
  readonly github: GitHub;
  readonly commit: string;
  readonly ref: string;
  /** The licence GitHub detected for the whole repository. */
  readonly repositoryLicence: string | undefined;
  /** Every listed file, by its directory. */
  readonly filesByDirectory: Map<string, TreeEntry[]>;
  readonly entries: TreeEntry[];
  readonly base: string;
}

/** The repository, the ref to read, and the commit it resolves to (or the one given). */
async function resolve(
  source: ImportSource,
  context: AdapterContext,
  pinned?: string
): Promise<{
  github: GitHub;
  ref: string;
  commit: string;
  licence: string | undefined;
}> {
  if (source.repo === undefined) {
    throw new Error("a git source needs `repo`");
  }
  const repository = parseRepository(source.repo);
  const github = new GitHub(
    context.fetch,
    repository,
    sourceSecret(source, context)
  );
  const info = await github.info();
  if (info === null) {
    throw new Error(
      `${repositoryUrl(repository)} is not there, or is private and the source names no secret for it`
    );
  }
  const ref = source.ref ?? info.defaultBranch;
  const commit = pinned ?? (await github.commit(ref));
  if (commit === null) {
    throw new Error(`${repositoryUrl(repository)} has no ref \`${ref}\``);
  }
  return { commit, github, licence: info.licence, ref };
}

async function snapshot(
  source: ImportSource,
  context: AdapterContext
): Promise<Snapshot> {
  const { commit, github, licence, ref } = await resolve(source, context);
  const repository = github.repository;
  const base = cleanPath(source.path);
  const walked = await github.walk(commit, base);
  if (walked.entry === null) {
    throw new Error(
      `${repositoryUrl(repository)} has no \`${base}\` at ${commit}`
    );
  }
  const entries =
    walked.entry.type === "blob"
      ? [walked.entry]
      : await github.tree(walked.entry.sha, base, true);
  const filesByDirectory = new Map<string, TreeEntry[]>();
  for (const entry of [
    ...walked.ancestors.flatMap((listing) => listing.entries),
    ...entries,
  ]) {
    if (entry.type !== "blob") {
      continue;
    }
    const directory = parent(entry.path);
    const files = filesByDirectory.get(directory) ?? [];
    if (!files.some((file) => file.path === entry.path)) {
      files.push(entry);
    }
    filesByDirectory.set(directory, files);
  }
  return {
    base,
    commit,
    entries,
    filesByDirectory,
    github,
    ref,
    repositoryLicence: licence,
  };
}

/** The licence that applies to an artifact in `directory`: the nearest licence file, else the repository's. */
async function licenceAt(
  snap: Snapshot,
  directory: string,
  cache: Map<string, Promise<Licence>>
): Promise<Licence> {
  for (const here of ancestry(directory)) {
    const file = (snap.filesByDirectory.get(here) ?? []).find((entry) =>
      isLicenceFile(basename(entry.path))
    );
    if (file === undefined) {
      continue;
    }
    if (here === "" && snap.repositoryLicence !== undefined) {
      const detected = fromSpdx(snap.repositoryLicence);
      if (detected !== undefined) {
        return detected;
      }
    }
    let found = cache.get(file.path);
    if (found === undefined) {
      found = snap.github
        .raw(snap.commit, file.path)
        .then((bytes) =>
          bytes === null
            ? NO_LICENCE
            : classifyText(new TextDecoder().decode(bytes))
        );
      cache.set(file.path, found);
    }
    return await found;
  }
  const detected =
    snap.repositoryLicence === undefined
      ? undefined
      : fromSpdx(snap.repositoryLicence);
  return detected ?? NO_LICENCE;
}

/** A skill with no licence file may still name an SPDX licence in its SKILL.md. */
async function skillStatement(
  snap: Snapshot,
  artifact: Artifact
): Promise<Licence | undefined> {
  const path = artifact.path === "" ? "SKILL.md" : `${artifact.path}/SKILL.md`;
  const bytes = await snap.github.raw(snap.commit, path);
  if (bytes === null) {
    return undefined;
  }
  const statement = stringField(
    frontmatter(new TextDecoder().decode(bytes)),
    "license"
  );
  const read = statement === undefined ? undefined : fromStatement(statement);
  return typeof read === "object" ? read : undefined;
}

/** A human title from a file or directory name: `api-architect` is `Api architect`. */
function titleOf(name: string): string {
  const words = name.replaceAll(/[-_.]+/gu, " ").trim();
  return words === ""
    ? name
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Where a person reads an artifact on GitHub, at the pinned commit. */
function recordUrl(
  repo: string,
  commit: string,
  path: string,
  kind: "blob" | "tree"
): string {
  return path === ""
    ? `${repo}/tree/${commit}`
    : `${repo}/${kind}/${commit}/${path}`;
}

/** An MCP item from a server a marketplace declares inline; `${NAME}` placeholders become secret references. */
function serverFields(
  server: InlineServer
): Record<string, unknown> | undefined {
  const slot = (value: unknown): unknown => {
    if (typeof value !== "string") {
      return undefined;
    }
    const reference = /^\$\{([A-Z][A-Z0-9_]*)\}$/u.exec(value);
    return reference?.[1] === undefined ? value : { secret: reference[1] };
  };
  const slots = (record: unknown): Record<string, unknown> | undefined => {
    if (typeof record !== "object" || record === null) {
      return undefined;
    }
    const out = Object.fromEntries(
      Object.entries(record).flatMap(([key, value]) => {
        const converted = slot(value);
        return converted === undefined ? [] : [[key, converted]];
      })
    );
    return Object.keys(out).length === 0 ? undefined : out;
  };
  const { definition } = server;
  if (typeof definition.url === "string") {
    const type = definition.type;
    return {
      flavour: "remote",
      headers: slots(definition.headers),
      transport:
        type === "http" || type === "sse" || type === "streamable-http"
          ? type
          : undefined,
      url: definition.url,
    };
  }
  if (typeof definition.command === "string") {
    const args = Array.isArray(definition.args)
      ? definition.args.filter((arg): arg is string => typeof arg === "string")
      : undefined;
    return {
      args: args === undefined || args.length === 0 ? undefined : args,
      command: definition.command,
      env: slots(definition.env),
      flavour: "stdio",
    };
  }
  return undefined;
}

async function discover(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const snap = await snapshot(source, context);
  const artifacts = findArtifacts(snap.entries, snap.base);
  const manifests = manifestsToRead(snap.entries, snap.base);
  const warnings: string[] = [];

  const extra: { artifact: Artifact; server?: InlineServer }[] = [];
  if (manifests.plugin !== undefined) {
    const bytes = await snap.github.raw(snap.commit, manifests.plugin);
    const document = parseJson(bytes);
    if (isAgentPlugin(document)) {
      extra.push({
        artifact: {
          directory: snap.base,
          key: manifests.plugin,
          kind: "plugin",
          name: basename(snap.base) || snap.github.repository.name,
          path: snap.base,
        },
      });
    }
  }
  if (manifests.marketplace !== undefined) {
    const bytes = await snap.github.raw(snap.commit, manifests.marketplace);
    for (const server of inlineServers(parseJson(bytes))) {
      extra.push({
        artifact: {
          directory: parent(manifests.marketplace),
          key: `${manifests.marketplace}#${server.name}`,
          kind: "mcp",
          name: server.name,
          path: manifests.marketplace,
        },
        server,
      });
    }
  }

  const all = [...artifacts.map((artifact) => ({ artifact })), ...extra];
  const ids = uniqueIds(
    all.map(({ artifact }) => ({
      name: artifact.name,
      qualifier: artifact.kind,
    }))
  );
  const cache = new Map<string, Promise<Licence>>();
  const repo = repositoryUrl(snap.github.repository);
  const candidates: Candidate[] = [];
  let linkOnly = 0;
  for (const [index, { artifact }] of all.entries()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- licence files are cached; most artifacts share one.
    let licence = await licenceAt(snap, artifact.directory, cache);
    if (
      !licence.permitsCopy &&
      licence === NO_LICENCE &&
      artifact.kind === "skill"
    ) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- only skills without a licence file are read.
      licence = (await skillStatement(snap, artifact)) ?? licence;
    }
    if (!licence.permitsCopy) {
      linkOnly += 1;
    }
    candidates.push({
      id: ids[index] ?? "item",
      key: artifact.key,
      kind: artifact.kind,
      license: licence.statement,
      ...(licence.id === undefined ? {} : { licenseId: licence.id }),
      linkOnly: !licence.permitsCopy,
      path: artifact.path,
      title: titleOf(artifact.name),
      upstream: { ref: snap.ref, resolvedCommit: snap.commit, url: repo },
    });
  }
  if (candidates.length === 0) {
    warnings.push(
      `${repo}${snap.base === "" ? "" : `/${snap.base}`} at ${snap.commit} has none of APM's package layouts`
    );
  }
  if (linkOnly > 0) {
    warnings.push(
      `${linkOnly} of ${candidates.length} candidates have no licence ShelfKit can identify as permitting copies; they import as links, without content`
    );
  }
  return { candidates, warnings };
}

function parseJson(bytes: Uint8Array | null): unknown {
  if (bytes === null) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** The text of a copied file, when it is text. */
function textOf(file: ImportedFile | undefined): string | undefined {
  return file?.encoding === "utf-8" ? file.contents : undefined;
}

async function fetchItem(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  const pinned =
    pick.pin?.resolvedCommit ??
    (pick.pin?.ref === undefined
      ? candidate.upstream.resolvedCommit
      : undefined);
  const snap = await resolve(
    {
      ...source,
      ...(pick.pin?.ref === undefined ? {} : { ref: pick.pin.ref }),
    },
    context,
    pinned
  );
  const repo = repositoryUrl(snap.github.repository);
  const id = pick.id ?? candidate.id;
  const path = candidate.path ?? "";
  const warnings: string[] = [];
  let linkOnly = candidate.linkOnly;
  let reason = `its licence (${candidate.license ?? "none stated"}) does not permit keeping a copy`;
  const files: ImportedFile[] = [];
  const fields: Record<string, unknown> = {};

  if (candidate.kind === "mcp") {
    const [manifest, name] = candidate.key.split("#");
    const document = parseJson(
      manifest === undefined
        ? null
        : await snap.github.raw(snap.commit, manifest)
    );
    const server = inlineServers(document).find((found) => found.name === name);
    const definition = server === undefined ? undefined : serverFields(server);
    if (definition === undefined) {
      throw new Error(
        `${repo}/${candidate.key} at ${snap.commit} declares no server \`${name ?? ""}\` ShelfKit reads`
      );
    }
    Object.assign(fields, definition, { name });
  } else if (!linkOnly) {
    const copied = await copy(snap, candidate.kind, path);
    if ("problem" in copied) {
      linkOnly = true;
      reason = copied.problem;
    } else {
      files.push(...copied.files);
    }
  }

  const main = files.find(
    (file) =>
      file.path ===
      (candidate.kind === "skill" ? "SKILL.md" : CONTENT_FILE[candidate.kind])
  );
  const meta = frontmatter(textOf(main) ?? "");
  if (candidate.kind === "skill" && main !== undefined) {
    const declared = stringField(meta, "license");
    const read = declared === undefined ? undefined : fromStatement(declared);
    const problem =
      typeof read === "object" && !read.permitsCopy
        ? `its SKILL.md declares the licence \`${declared ?? ""}\``
        : skillProblem(main.contents, id);
    if (problem !== undefined) {
      linkOnly = true;
      reason = problem;
    }
  }
  if (linkOnly && candidate.kind !== "mcp") {
    warnings.push(
      linkOnlyWarning(
        id,
        reason,
        recordUrl(
          repo,
          snap.commit,
          path,
          candidate.kind === "skill" ? "tree" : "blob"
        )
      )
    );
  }

  const licence = {
    license: candidate.license ?? NO_LICENCE.statement,
    licenseId: candidate.licenseId,
    shareAlike:
      candidate.licenseId === undefined
        ? undefined
        : (fromSpdx(candidate.licenseId)?.shareAlike ?? false),
  };
  const item = {
    ...fields,
    description: stringField(meta, "description"),
    id,
    kind: candidate.kind,
    source: provenance({
      ...licence,
      creditText: `${snap.github.repository.owner}/${snap.github.repository.name}${path === "" ? "" : `: ${path}`}${
        candidate.licenseId === undefined ? "" : ` (${candidate.licenseId})`
      }`,
      id: source.sourceId,
      linkTarget: repo,
      path: path === "" ? undefined : path,
      recordUrl: recordUrl(
        repo,
        snap.commit,
        path,
        candidate.kind === "skill" || path === "" ? "tree" : "blob"
      ),
      ref: snap.ref,
      repo,
      resolvedCommit: snap.commit,
    }),
    title:
      stringField(meta, "title") ??
      (candidate.kind === "skill" ? undefined : stringField(meta, "name")) ??
      candidate.title,
  };
  return importedItem({ files, item, linkOnly, warnings });
}

/** Copy an artifact's files into its item directory, or say why it cannot be copied. */
async function copy(
  snap: { github: GitHub; commit: string },
  kind: ItemKind,
  path: string
): Promise<{ files: ImportedFile[] } | { problem: string }> {
  if (kind === "skill") {
    const walked = await snap.github.walk(snap.commit, path);
    if (walked.entry === null) {
      throw new Error(`no \`${path}\` at ${snap.commit}`);
    }
    const entries = (
      await snap.github.tree(walked.entry.sha, path, true)
    ).filter(
      (entry) => entry.type === "blob" && basename(entry.path) !== ".DS_Store"
    );
    const size = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (entries.length > MAX_FILES || size > MAX_BYTES) {
      return {
        problem: `it is ${entries.length} files and ${size} bytes, more than ShelfKit copies`,
      };
    }
    const files = await Promise.all(
      entries.map(async (entry) => {
        const bytes = await snap.github.raw(snap.commit, entry.path);
        if (bytes === null) {
          throw new Error(`no \`${entry.path}\` at ${snap.commit}`);
        }
        return {
          ...fileContents(bytes),
          path: path === "" ? entry.path : entry.path.slice(path.length + 1),
        };
      })
    );
    if (files.some((file) => file.path === "item.json")) {
      return {
        problem:
          "it has its own item.json, which the shelf's item.json would replace",
      };
    }
    return { files: files.toSorted((a, b) => byCodePoint(a.path, b.path)) };
  }
  const target = CONTENT_FILE[kind];
  if (target === undefined) {
    return { problem: `a ${kind} item has no content file to copy` };
  }
  const contentPath =
    kind === "plugin"
      ? path === ""
        ? "plugin.json"
        : `${path}/plugin.json`
      : path;
  const bytes = await snap.github.raw(snap.commit, contentPath);
  if (bytes === null) {
    throw new Error(`no \`${contentPath}\` at ${snap.commit}`);
  }
  return { files: [{ ...fileContents(bytes), path: target }] };
}

async function checkUpstream(
  item: Item,
  context: AdapterContext
): Promise<UpstreamState> {
  const source = sourceOf(item);
  if (source.repo === undefined) {
    return { error: "the item names no repository", status: "error" };
  }
  if (source.resolvedCommit === undefined) {
    return {
      error: "the item has no resolved commit to compare with",
      status: "error",
    };
  }
  const github = new GitHub(context.fetch, parseRepository(source.repo));
  const info = await github.info();
  if (info === null) {
    return { status: "gone" };
  }
  // A ref that is itself a commit never moves; drift is then measured against the default branch.
  const ref =
    source.ref === undefined || COMMIT.test(source.ref)
      ? info.defaultBranch
      : source.ref;
  const head = await github.commit(ref);
  if (head === null) {
    return { error: `the ref \`${ref}\` is gone`, status: "gone" };
  }
  const latest = { ref, resolvedCommit: head };
  if (head === source.resolvedCommit) {
    return { latest, status: "current" };
  }
  const path = cleanPath(source.path);
  if (path === "") {
    return { latest, status: "moved" };
  }
  const now = (await github.walk(head, path)).entry;
  if (now === null) {
    return { latest, status: "gone" };
  }
  const then = (await github.walk(source.resolvedCommit, path)).entry;
  return { latest, status: then?.sha === now.sha ? "current" : "moved" };
}

export const gitAdapter: SourceAdapter = {
  checkUpstream,
  discover,
  fetch: fetchItem,
  kind: "git",
};
