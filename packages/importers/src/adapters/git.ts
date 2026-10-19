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
import * as v from "valibot";

import { frontmatter, skillProblem } from "../frontmatter.ts";
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
import type { Artifact, ServerDefinition } from "../layouts.ts";
import {
  ancestry,
  basename,
  findArtifacts,
  inlineServers,
  isAgentPlugin,
  manifestsToRead,
  MarketplaceSchema,
  parent,
  PluginManifestSchema,
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
const CONTENT_FILE = new Map<ItemKind, string>([
  ["agent", "agent.md"],
  ["hook", "hook.json"],
  ["instructions", "AGENTS.fragment.md"],
  ["plugin", "plugin.json"],
  ["prompt", "prompt.md"],
]);

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
    throw new Error(`\`${path ?? ""}\` is not a clean relative path`);
  }
  return trimmed;
}

/** A repository, the ref read, and the commit it resolved to. */
interface Resolved {
  readonly github: GitHub;
  readonly ref: string;
  readonly commit: string;
  /** The licence GitHub detected for the whole repository. */
  readonly licence: string | undefined;
}

/** What one discovery read from the repository. */
interface Snapshot extends Resolved {
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
): Promise<Resolved> {
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

/** Every file a discovery listed, by its directory. */
function byDirectory(entries: readonly TreeEntry[]): Map<string, TreeEntry[]> {
  const files = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    if (entry.type === "blob") {
      const directory = parent(entry.path);
      const listed = files.get(directory) ?? [];
      if (!listed.some((file) => file.path === entry.path)) {
        listed.push(entry);
      }
      files.set(directory, listed);
    }
  }
  return files;
}

async function snapshot(
  source: ImportSource,
  context: AdapterContext
): Promise<Snapshot> {
  const resolved = await resolve(source, context);
  const { commit, github } = resolved;
  const base = cleanPath(source.path);
  const walked = await github.walk(commit, base);
  const { entry } = walked;
  if (entry === null) {
    throw new Error(
      `${repositoryUrl(github.repository)} has no \`${base}\` at ${commit}`
    );
  }
  const entries =
    entry.type === "blob" ? [entry] : await github.tree(entry.sha, base, true);
  const filesByDirectory = byDirectory([
    ...walked.ancestors.flatMap((listing) => listing.entries),
    ...entries,
  ]);
  return { ...resolved, base, entries, filesByDirectory };
}

async function classifyFile(snap: Resolved, path: string): Promise<Licence> {
  const bytes = await snap.github.raw(snap.commit, path);
  return bytes === null
    ? NO_LICENCE
    : classifyText(new TextDecoder().decode(bytes));
}

/** The nearest licence file to `directory`, and the directory it is in. */
function nearestLicenceFile(
  snap: Snapshot,
  directory: string
): { file: TreeEntry; at: string } | undefined {
  for (const here of ancestry(directory)) {
    const file = (snap.filesByDirectory.get(here) ?? []).find((entry) =>
      isLicenceFile(basename(entry.path))
    );
    if (file !== undefined) {
      return { at: here, file };
    }
  }
  return undefined;
}

/** The licence that applies to an artifact in `directory`: the nearest licence file, else the repository's. */
async function licenceAt(
  snap: Snapshot,
  directory: string,
  cache: Map<string, Promise<Licence>>
): Promise<Licence> {
  const detected =
    snap.licence === undefined ? undefined : fromSpdx(snap.licence);
  const nearest = nearestLicenceFile(snap, directory);
  if (nearest === undefined) {
    return detected ?? NO_LICENCE;
  }
  if (nearest.at === "" && detected !== undefined) {
    return detected;
  }
  const cached =
    cache.get(nearest.file.path) ?? classifyFile(snap, nearest.file.path);
  cache.set(nearest.file.path, cached);
  return await cached;
}

/** A skill with no licence file may still name an SPDX licence in its SKILL.md. */
async function skillStatement(
  snap: Resolved,
  artifact: Artifact
): Promise<Licence | undefined> {
  const path = artifact.path === "" ? "SKILL.md" : `${artifact.path}/SKILL.md`;
  const bytes = await snap.github.raw(snap.commit, path);
  const statement =
    bytes === null
      ? undefined
      : frontmatter(new TextDecoder().decode(bytes)).license;
  const read = statement === undefined ? undefined : fromStatement(statement);
  return read === "see-file" ? undefined : read;
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

/** A literal value, or a `${NAME}` placeholder as a secret reference. */
function slot(value: string): string | { secret: string } {
  const name = /^\$\{(?<name>[A-Z][A-Z0-9_]*)\}$/u.exec(value)?.groups?.name;
  return name === undefined ? value : { secret: name };
}

/** A map of literals and `${NAME}` placeholders as item slots; `undefined` when empty. */
function slots(
  record: Readonly<Record<string, string>> | undefined
): Map<string, string | { secret: string }> | undefined {
  if (record === undefined || Object.keys(record).length === 0) {
    return undefined;
  }
  return new Map(
    Object.entries(record).map(([key, value]) => [key, slot(value)])
  );
}

/** An MCP item's fields from a server a marketplace declares inline. */
function serverFields(definition: ServerDefinition): object | undefined {
  if (definition.url !== undefined) {
    const { type } = definition;
    const headers = slots(definition.headers);
    return {
      flavour: "remote",
      headers: headers === undefined ? undefined : Object.fromEntries(headers),
      transport:
        type === "http" || type === "sse" || type === "streamable-http"
          ? type
          : undefined,
      url: definition.url,
    };
  }
  if (definition.command !== undefined) {
    const env = slots(definition.env);
    return {
      args:
        definition.args === undefined || definition.args.length === 0
          ? undefined
          : definition.args,
      command: definition.command,
      env: env === undefined ? undefined : Object.fromEntries(env),
      flavour: "stdio",
    };
  }
  return undefined;
}

/** A JSON file of the repository, parsed with `schema`, or `undefined` when it is missing or not that shape. */
async function readJson<const TSchema extends v.GenericSchema>(
  snap: Resolved,
  path: string,
  schema: TSchema
): Promise<v.InferOutput<TSchema> | undefined> {
  const bytes = await snap.github.raw(snap.commit, path);
  if (bytes === null) {
    return undefined;
  }
  try {
    // BOUNDARY: an upstream JSON file is untyped until `schema` reads it.
    const parsed = v.safeParse(
      schema,
      JSON.parse(new TextDecoder().decode(bytes))
    );
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** The artifacts a plugin manifest or a marketplace adds to the layouts' own. */
async function manifestArtifacts(snap: Snapshot): Promise<Artifact[]> {
  const manifests = manifestsToRead(snap.entries, snap.base);
  const found: Artifact[] = [];
  if (manifests.plugin !== undefined) {
    const plugin = await readJson(snap, manifests.plugin, PluginManifestSchema);
    if (plugin !== undefined && isAgentPlugin(plugin)) {
      found.push({
        directory: snap.base,
        key: manifests.plugin,
        kind: "plugin",
        name: basename(snap.base) || snap.github.repository.name,
        path: snap.base,
      });
    }
  }
  if (manifests.marketplace !== undefined) {
    const { marketplace } = manifests;
    const document = await readJson(snap, marketplace, MarketplaceSchema);
    for (const server of document === undefined
      ? []
      : inlineServers(document)) {
      found.push({
        directory: parent(marketplace),
        key: `${marketplace}#${server.name}`,
        kind: "mcp",
        name: server.name,
        path: marketplace,
      });
    }
  }
  return found;
}

/** The licence of each artifact, in order. */
async function licences(
  snap: Snapshot,
  artifacts: readonly Artifact[]
): Promise<Licence[]> {
  const cache = new Map<string, Promise<Licence>>();
  return await Promise.all(
    artifacts.map(async (artifact) => {
      const licence = await licenceAt(snap, artifact.directory, cache);
      if (licence === NO_LICENCE && artifact.kind === "skill") {
        return (await skillStatement(snap, artifact)) ?? licence;
      }
      return licence;
    })
  );
}

async function discover(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const snap = await snapshot(source, context);
  const artifacts = [
    ...findArtifacts(snap.entries, snap.base),
    ...(await manifestArtifacts(snap)),
  ];
  const ids = uniqueIds(
    artifacts.map((artifact) => ({
      name: artifact.name,
      qualifier: artifact.kind,
    }))
  );
  const found = await licences(snap, artifacts);
  const repo = repositoryUrl(snap.github.repository);
  const candidates = artifacts.map((artifact, index) => {
    const licence = found[index] ?? NO_LICENCE;
    const candidate: Candidate = {
      id: ids[index] ?? "item",
      key: artifact.key,
      kind: artifact.kind,
      license: licence.statement,
      linkOnly: !licence.permitsCopy,
      path: artifact.path,
      title: titleOf(artifact.name),
      upstream: { ref: snap.ref, resolvedCommit: snap.commit, url: repo },
    };
    if (licence.id !== undefined) {
      candidate.licenseId = licence.id;
    }
    return candidate;
  });
  const warnings: string[] = [];
  if (candidates.length === 0) {
    const where = snap.base === "" ? repo : `${repo}/${snap.base}`;
    warnings.push(
      `${where} at ${snap.commit} has none of APM's package layouts`
    );
  }
  const linkOnly = candidates.filter((candidate) => candidate.linkOnly).length;
  if (linkOnly > 0) {
    warnings.push(
      `${linkOnly} of ${candidates.length} candidates have no licence ShelfKit can identify as permitting copies; they import as links, without content`
    );
  }
  return { candidates, warnings };
}

/** The text of a copied file, when it is text. */
function textOf(file: ImportedFile | undefined): string {
  return file?.encoding === "utf-8" ? file.contents : "";
}

/** A skill's whole directory, or why it cannot be copied. */
async function copySkill(
  snap: Resolved,
  path: string
): Promise<{ files: ImportedFile[] } | { problem: string }> {
  const { entry } = await snap.github.walk(snap.commit, path);
  if (entry === null) {
    throw new Error(`no \`${path}\` at ${snap.commit}`);
  }
  const listed = await snap.github.tree(entry.sha, path, true);
  const entries = listed.filter(
    (file) => file.type === "blob" && basename(file.path) !== ".DS_Store"
  );
  const size = entries.reduce((sum, file) => sum + file.size, 0);
  if (entries.length > MAX_FILES || size > MAX_BYTES) {
    return {
      problem: `it is ${entries.length} files and ${size} bytes, more than ShelfKit copies`,
    };
  }
  const files = await Promise.all(
    entries.map(async (file) => {
      const bytes = await snap.github.raw(snap.commit, file.path);
      if (bytes === null) {
        throw new Error(`no \`${file.path}\` at ${snap.commit}`);
      }
      return {
        ...fileContents(bytes),
        path: path === "" ? file.path : file.path.slice(path.length + 1),
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

/** Copy an artifact's content into its item directory, or say why it cannot be copied. */
async function copy(
  snap: Resolved,
  kind: ItemKind,
  path: string
): Promise<{ files: ImportedFile[] } | { problem: string }> {
  if (kind === "skill") {
    return await copySkill(snap, path);
  }
  const target = CONTENT_FILE.get(kind);
  if (target === undefined) {
    return { problem: `a ${kind} item has no content file to copy` };
  }
  let contentPath = path;
  if (kind === "plugin") {
    contentPath = path === "" ? "plugin.json" : `${path}/plugin.json`;
  }
  const bytes = await snap.github.raw(snap.commit, contentPath);
  if (bytes === null) {
    throw new Error(`no \`${contentPath}\` at ${snap.commit}`);
  }
  return { files: [{ ...fileContents(bytes), path: target }] };
}

/** The fields of an MCP item a marketplace declares. */
async function mcpFields(
  snap: Resolved,
  candidate: Candidate
): Promise<object> {
  const [manifest = "", name = ""] = candidate.key.split("#");
  const document = await readJson(snap, manifest, MarketplaceSchema);
  const server =
    document === undefined
      ? undefined
      : inlineServers(document).find((found) => found.name === name);
  const fields =
    server === undefined ? undefined : serverFields(server.definition);
  if (fields === undefined) {
    throw new Error(
      `${repositoryUrl(snap.github.repository)}/${candidate.key} at ${snap.commit} declares no server \`${name}\` ShelfKit reads`
    );
  }
  return { ...fields, name };
}

/** What a copy holds, or why the item is a link instead. */
interface Content {
  readonly files: ImportedFile[];
  readonly linkOnly: boolean;
  readonly reason: string;
}

/** Copy a licensed artifact; a SKILL.md that declares a restriction, or that the loader would refuse, makes a link. */
async function content(
  snap: Resolved,
  candidate: Candidate,
  id: string
): Promise<Content> {
  const notPermitted = `its licence (${candidate.license ?? "none stated"}) does not permit keeping a copy`;
  if (candidate.linkOnly || candidate.kind === "mcp") {
    return { files: [], linkOnly: candidate.linkOnly, reason: notPermitted };
  }
  const copied = await copy(snap, candidate.kind, candidate.path ?? "");
  if ("problem" in copied) {
    return { files: [], linkOnly: true, reason: copied.problem };
  }
  const skill = copied.files.find((file) => file.path === "SKILL.md");
  if (candidate.kind !== "skill" || skill === undefined) {
    return { files: copied.files, linkOnly: false, reason: "" };
  }
  const declared = frontmatter(textOf(skill)).license;
  const read = declared === undefined ? undefined : fromStatement(declared);
  if (read !== undefined && read !== "see-file" && !read.permitsCopy) {
    return {
      files: [],
      linkOnly: true,
      reason: `its SKILL.md declares the licence \`${declared ?? ""}\``,
    };
  }
  const problem = skillProblem(textOf(skill), id);
  return problem === undefined
    ? { files: copied.files, linkOnly: false, reason: "" }
    : { files: [], linkOnly: true, reason: problem };
}

/** The commit to fetch at: the pick's, or the candidate's when the pick asks for no other ref. */
function pinnedCommit(candidate: Candidate, pick: Pick): string | undefined {
  if (pick.pin?.resolvedCommit !== undefined) {
    return pick.pin.resolvedCommit;
  }
  return pick.pin?.ref === undefined
    ? candidate.upstream.resolvedCommit
    : undefined;
}

async function fetchItem(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  const ref = pick.pin?.ref ?? source.ref;
  const snap = await resolve(
    { ...source, ref },
    context,
    pinnedCommit(candidate, pick)
  );
  const repo = repositoryUrl(snap.github.repository);
  const id = pick.id ?? candidate.id;
  const path = candidate.path ?? "";
  const record = recordUrl(
    repo,
    snap.commit,
    path,
    candidate.kind === "skill" || path === "" ? "tree" : "blob"
  );
  const copied = await content(snap, candidate, id);
  const fields =
    candidate.kind === "mcp" ? await mcpFields(snap, candidate) : {};
  const main = copied.files.find(
    (file) =>
      file.path ===
      (candidate.kind === "skill"
        ? "SKILL.md"
        : CONTENT_FILE.get(candidate.kind))
  );
  const meta = frontmatter(textOf(main));
  const { licenseId } = candidate;
  const creditPath = path === "" ? "" : `: ${path}`;
  const creditLicence = licenseId === undefined ? "" : ` (${licenseId})`;
  const item = {
    ...fields,
    description: meta.description,
    id,
    kind: candidate.kind,
    source: provenance({
      creditText: `${snap.github.repository.owner}/${snap.github.repository.name}${creditPath}${creditLicence}`,
      id: source.sourceId,
      license: candidate.license ?? NO_LICENCE.statement,
      licenseId,
      linkTarget: repo,
      path: path === "" ? undefined : path,
      recordUrl: record,
      ref: snap.ref,
      repo,
      resolvedCommit: snap.commit,
      shareAlike:
        licenseId === undefined
          ? undefined
          : (fromSpdx(licenseId)?.shareAlike ?? false),
    }),
    title:
      meta.title ??
      (candidate.kind === "skill" ? undefined : meta.name) ??
      candidate.title,
  };
  const warnings =
    copied.linkOnly && candidate.kind !== "mcp"
      ? [linkOnlyWarning(id, copied.reason, record)]
      : [];
  return importedItem({
    files: copied.files,
    item,
    linkOnly: copied.linkOnly,
    warnings,
  });
}

/** The object id at a path in a commit, or `null` when it is not there. */
async function objectAt(
  github: GitHub,
  commit: string,
  path: string
): Promise<string | null> {
  const { entry } = await github.walk(commit, path);
  return entry === null ? null : entry.sha;
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
  const now = await objectAt(github, head, path);
  if (now === null) {
    return { latest, status: "gone" };
  }
  const then = await objectAt(github, source.resolvedCommit, path);
  return { latest, status: then === now ? "current" : "moved" };
}

export const gitAdapter: SourceAdapter = {
  checkUpstream,
  discover,
  fetch: fetchItem,
  kind: "git",
};
