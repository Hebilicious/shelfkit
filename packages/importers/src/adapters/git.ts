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

import {
  docPathIn,
  firstHeading,
  followDocs,
  isDocFile,
  isDocPath,
} from "../docs.ts";
import { frontmatter, skillProblem } from "../frontmatter.ts";
import {
  GITHUB_API,
  GitHub,
  parseRepository,
  repositoryUrl,
} from "../github.ts";
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
  fromStatement,
  isLicenceFile,
  NO_LICENCE,
  restrictive,
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
  ["doc", "doc.md"],
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
}

/** What one discovery read from the repository. */
interface Snapshot extends Resolved {
  /** Every listed file, by its directory. */
  readonly filesByDirectory: Map<string, TreeEntry[]>;
  readonly entries: TreeEntry[];
  readonly base: string;
}

/**
 * The token a source's secret releases for GitHub's API, or why it cannot be used. A secret is sent only to the
 * origin it is bound to, and the importer reads GitHub only through `https://api.github.com`, so a source that names
 * a secret must bind it to that origin and set its `url` to it (the secret rule releases for the source's `url`).
 */
export function githubToken(
  source: ImportSource | undefined,
  context: AdapterContext
): { token?: string } | { problem: string } {
  if (source?.secret === undefined) {
    return {};
  }
  const name = source.secret;
  if (source.url !== GITHUB_API) {
    return {
      problem: `the source names the secret ${name}, which is sent only to ${GITHUB_API}: bind ${name} to ${GITHUB_API} and set the source's url to ${GITHUB_API}`,
    };
  }
  const token = sourceSecret(source, context);
  if (token === undefined) {
    return {
      problem: `the secret ${name} is not released for ${GITHUB_API}: the shelf must bind it to that origin, and its value must be set`,
    };
  }
  return { token };
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
  const access = githubToken(source, context);
  if ("problem" in access) {
    throw new Error(access.problem);
  }
  const github = new GitHub(context.fetch, repository, access.token);
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
  return { commit, github, ref };
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

/** The licence file nearest to `directory`, from listings of it and every directory above it. */
function nearestLicenceFile(
  files: ReadonlyMap<string, TreeEntry[]>,
  directory: string
): TreeEntry | undefined {
  for (const here of ancestry(directory)) {
    const file = (files.get(here) ?? []).find((entry) =>
      isLicenceFile(basename(entry.path))
    );
    if (file !== undefined) {
      return file;
    }
  }
  return undefined;
}

/** The licence governing an artifact, and the file that states it. */
interface Governing {
  readonly licence: Licence;
  readonly file: TreeEntry | undefined;
}

/**
 * The licence of the nearest licence file to `directory`, read from the file at this commit. GitHub's detected
 * licence is not used: it describes the default branch's head, not the commit being read.
 */
async function governing(
  snap: Resolved,
  files: ReadonlyMap<string, TreeEntry[]>,
  directory: string,
  cache: Map<string, Promise<Licence>>
): Promise<Governing> {
  const file = nearestLicenceFile(files, directory);
  if (file === undefined) {
    return { file, licence: NO_LICENCE };
  }
  const cached = cache.get(file.path) ?? classifyFile(snap, file.path);
  cache.set(file.path, cached);
  return { file, licence: await cached };
}

/**
 * Combine a licence file with what SKILL.md states. A pointer to the file defers to it; an SPDX id on the allowlist
 * stands when there is no file and must agree with a file that is there; anything else restricts.
 */
export function effectiveLicence(
  found: Governing,
  statement: string | undefined
): Licence {
  if (statement === undefined) {
    return found.licence;
  }
  const read = fromStatement(statement);
  if (read === "see-file") {
    return found.file === undefined
      ? restrictive(
          `SKILL.md defers to a licence file ("${statement}"), and there is none`
        )
      : found.licence;
  }
  if (!read.permitsCopy || found.file === undefined) {
    return read;
  }
  if (!found.licence.permitsCopy || found.licence.id === read.id) {
    return found.licence;
  }
  return restrictive(
    `SKILL.md says ${read.id ?? statement}, but ${found.file.path} is ${found.licence.id ?? found.licence.statement}`
  );
}

/** What a SKILL.md's frontmatter states as its licence, if it states one. */
async function skillStatement(
  snap: Resolved,
  directory: string
): Promise<string | undefined> {
  const bytes = await snap.github.raw(
    snap.commit,
    directory === "" ? "SKILL.md" : `${directory}/SKILL.md`
  );
  return bytes === null
    ? undefined
    : frontmatter(new TextDecoder().decode(bytes)).license;
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

/** A file's text at the snapshot's commit, or `undefined` when it is not there. */
async function readText(
  snap: Resolved,
  path: string
): Promise<string | undefined> {
  const bytes = await snap.github.raw(snap.commit, path);
  return bytes === null ? undefined : new TextDecoder().decode(bytes);
}

/** A file name without its `.md`. */
function stem(path: string): string {
  return basename(path).replace(/\.md$/u, "");
}

/** What the docs of a tree add to its layouts' artifacts, and what discovery says about them. */
interface DocArtifacts {
  readonly artifacts: Artifact[];
  readonly warnings: string[];
}

/**
 * The tree's AGENTS.md as instructions and the docs it links to, or, when the import names one markdown file that is
 * no primitive of its own, that file as a doc. Only regular files count: a symbolic link (a CLAUDE.md pointing at
 * AGENTS.md, say) is no document of its own. A doc's `path` is relative to the imported tree, since that is how the
 * tree's AGENTS.md links to it, and the compiler points those links at the doc's installed copy (`kindFields`).
 */
async function docArtifacts(
  snap: Snapshot,
  layouts: readonly Artifact[]
): Promise<DocArtifacts> {
  const [only] = snap.entries;
  if (
    snap.entries.length === 1 &&
    only?.path === snap.base &&
    only.type === "blob"
  ) {
    if (layouts.length > 0 || only.symlink === true || !isDocFile(only.path)) {
      return { artifacts: [], warnings: [] };
    }
    if (!isDocPath(only.path)) {
      return {
        artifacts: [],
        warnings: [
          `\`${only.path}\` cannot be a doc's path: a link could not name it plainly`,
        ],
      };
    }
    const text = await readText(snap, only.path);
    return {
      artifacts: [
        {
          directory: parent(only.path),
          key: only.path,
          kind: "doc",
          name: stem(only.path),
          path: only.path,
          title: text === undefined ? undefined : firstHeading(text),
        },
      ],
      warnings: [],
    };
  }

  const prefix = snap.base === "" ? "" : `${snap.base}/`;
  const agents = `${prefix}AGENTS.md`;
  const regular = new Set(
    snap.entries
      .filter((entry) => entry.type === "blob" && entry.symlink !== true)
      .map((entry) => entry.path)
  );
  if (!regular.has(agents)) {
    return { artifacts: [], warnings: [] };
  }
  const followed = await followDocs(
    agents,
    (path) => regular.has(path) && path.startsWith(prefix),
    async (path) => await readText(snap, path)
  );
  const name = basename(snap.base) || snap.github.repository.name;
  const artifacts: Artifact[] = [
    {
      directory: snap.base,
      key: agents,
      kind: "instructions",
      links: followed.links,
      name,
      path: agents,
      title: followed.heading,
    },
    ...followed.docs.map((doc): Artifact => ({
      directory: parent(doc.path),
      key: doc.path,
      kind: "doc",
      links: doc.links,
      name: stem(doc.path),
      path: doc.path,
      title: doc.heading,
    })),
  ];
  const warnings = followed.truncated
    ? [
        `${agents} links to more than ${followed.docs.length} docs; only the first ${followed.docs.length} are offered, in the order its links reach them`,
      ]
    : [];
  return { artifacts, warnings };
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

/** The licence of each artifact, in order, as discovery reports it: a skill without a licence file is read for one. */
async function licences(
  snap: Snapshot,
  artifacts: readonly Artifact[]
): Promise<Licence[]> {
  const cache = new Map<string, Promise<Licence>>();
  return await Promise.all(
    artifacts.map(async (artifact) => {
      const found = await governing(
        snap,
        snap.filesByDirectory,
        artifact.directory,
        cache
      );
      if (found.file !== undefined || artifact.kind !== "skill") {
        return found.licence;
      }
      return effectiveLicence(found, await skillStatement(snap, artifact.path));
    })
  );
}

async function discover(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const snap = await snapshot(source, context);
  const layouts = [
    ...findArtifacts(snap.entries, snap.base),
    ...(await manifestArtifacts(snap)),
  ];
  const docs = await docArtifacts(snap, layouts);
  const artifacts = [...layouts, ...docs.artifacts];
  const offered = new Set(artifacts.map((artifact) => artifact.key));
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
      title: artifact.title ?? titleOf(artifact.name),
      upstream: { ref: snap.ref, resolvedCommit: snap.commit, url: repo },
    };
    if (licence.id !== undefined) {
      candidate.licenseId = licence.id;
    }
    const requires = (artifact.links ?? []).filter((key) => offered.has(key));
    if (requires.length > 0) {
      candidate.requires = requires;
    }
    return candidate;
  });
  const warnings = [...docs.warnings];
  if (candidates.length === 0) {
    const where = snap.base === "" ? repo : `${repo}/${snap.base}`;
    warnings.push(
      `${where} at ${snap.commit} has none of APM's package layouts, no AGENTS.md, and is no markdown file to import as a doc`
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

/**
 * What an item's kind adds to its common fields: a marketplace server's definition, or a doc's `path`, relative to the
 * imported tree (the import's `path`, unless that names the doc itself), which is how the tree's AGENTS.md links to it.
 */
async function kindFields(
  snap: Resolved,
  source: ImportSource,
  candidate: Candidate
): Promise<object> {
  if (candidate.kind === "mcp") {
    return await mcpFields(snap, candidate);
  }
  if (candidate.kind !== "doc") {
    return {};
  }
  const path = candidate.path ?? "";
  const relative = docPathIn(cleanPath(source.path), path);
  if (!isDocPath(relative)) {
    throw new Error(
      `${repositoryUrl(snap.github.repository)}/${path}: \`${relative}\` cannot be a doc's path`
    );
  }
  return { path: relative };
}

/** Blob listings of `directory` and every directory above it, at the snapshot's commit. */
async function listingsAt(
  snap: Resolved,
  directory: string
): Promise<Map<string, TreeEntry[]>> {
  const walked = await snap.github.walk(snap.commit, directory);
  const entries = walked.ancestors.flatMap((listing) => listing.entries);
  if (walked.entry?.type === "tree") {
    entries.push(
      ...(await snap.github.tree(walked.entry.sha, directory, false))
    );
  }
  return byDirectory(entries);
}

/** The directory whose licence governs an artifact at `path`. */
function artifactDirectory(kind: ItemKind, path: string): string {
  return kind === "skill" || kind === "plugin" ? path : parent(path);
}

/** Why a licence makes an import a link. */
function notPermitted(licence: Licence): string {
  return `its licence (${licence.statement}) does not permit keeping a copy`;
}

/** What a copy holds, under which licence, or why the item is a link instead. */
interface Content {
  readonly files: ImportedFile[];
  readonly licence: Licence;
  readonly linkOnly: boolean;
  readonly reason: string;
}

/** The licence file itself, added to a copy whose licence requires its notice when the copy does not include it. */
async function notice(
  snap: Resolved,
  found: Governing,
  files: readonly ImportedFile[],
  path: string,
  kind: ItemKind
) {
  const { file } = found;
  const inside =
    kind === "skill" &&
    file !== undefined &&
    (path === "" || file.path.startsWith(`${path}/`));
  if (!found.licence.attribution || file === undefined || inside) {
    return [];
  }
  const name = basename(file.path);
  if (files.some((copied) => copied.path === name)) {
    return [];
  }
  const bytes = await snap.github.raw(snap.commit, file.path);
  return bytes === null ? [] : [{ ...fileContents(bytes), path: name }];
}

/**
 * Copy an artifact when its licence, read from the files at the commit being copied, permits it. Discovery's
 * judgement is never reused: a pick may name another commit, and SKILL.md is only read here.
 */
async function content(
  snap: Resolved,
  candidate: Candidate,
  id: string
): Promise<Content> {
  const path = candidate.path ?? "";
  const listings = await listingsAt(
    snap,
    artifactDirectory(candidate.kind, path)
  );
  const found = await governing(
    snap,
    listings,
    artifactDirectory(candidate.kind, path),
    new Map()
  );
  if (candidate.kind === "mcp") {
    return {
      files: [],
      licence: found.licence,
      linkOnly: !found.licence.permitsCopy,
      reason: "",
    };
  }
  // A skill's own SKILL.md may restrict what its licence file allows: read its frontmatter before copying anything.
  const licence =
    candidate.kind === "skill"
      ? effectiveLicence(found, await skillStatement(snap, path))
      : found.licence;
  if (!licence.permitsCopy) {
    return {
      files: [],
      licence,
      linkOnly: true,
      reason: notPermitted(licence),
    };
  }
  const copied = await copy(snap, candidate.kind, path);
  if ("problem" in copied) {
    return { files: [], licence, linkOnly: true, reason: copied.problem };
  }
  const skill = copied.files.find((file) => file.path === "SKILL.md");
  const problem =
    candidate.kind === "skill" ? skillProblem(textOf(skill), id) : undefined;
  if (problem !== undefined) {
    return { files: [], licence, linkOnly: true, reason: problem };
  }
  const added = await notice(
    snap,
    { file: found.file, licence },
    copied.files,
    path,
    candidate.kind
  );
  const files = [...copied.files, ...added].toSorted((a, b) =>
    byCodePoint(a.path, b.path)
  );
  return { files, licence, linkOnly: false, reason: "" };
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

/** The credit a licence that requires attribution asks for: the work, where it is, and its licence. */
function credit(
  snap: Resolved,
  path: string,
  licence: Licence
): string | undefined {
  if (!licence.attribution) {
    return undefined;
  }
  const where = path === "" ? "" : `: ${path}`;
  const which = licence.id === undefined ? "" : ` (${licence.id})`;
  return `${snap.github.repository.owner}/${snap.github.repository.name}${where}${which}`;
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
  const fields = await kindFields(snap, source, candidate);
  const main = copied.files.find(
    (file) =>
      file.path ===
      (candidate.kind === "skill"
        ? "SKILL.md"
        : CONTENT_FILE.get(candidate.kind))
  );
  const meta = frontmatter(textOf(main));
  // A doc is titled by its first heading; an AGENTS.md's heading is already its candidate's title.
  const heading =
    candidate.kind === "doc" ? firstHeading(textOf(main)) : undefined;
  const { licence } = copied;
  const item = {
    ...fields,
    description: meta.description,
    id,
    kind: candidate.kind,
    source: provenance({
      creditText: credit(snap, path, licence),
      id: source.sourceId,
      license: licence.statement,
      licenseId: licence.id,
      linkTarget: repo,
      path: path === "" ? undefined : path,
      recordUrl: record,
      ref: snap.ref,
      repo,
      resolvedCommit: snap.commit,
      shareAlike: licence.permitsCopy ? licence.shareAlike : undefined,
    }),
    title:
      meta.title ??
      (candidate.kind === "skill" ? undefined : meta.name) ??
      heading ??
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
  context: AdapterContext,
  declared?: ImportSource
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
  const access = githubToken(declared, context);
  if ("problem" in access) {
    return { error: access.problem, status: "error" };
  }
  const github = new GitHub(
    context.fetch,
    parseRepository(source.repo),
    access.token
  );
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
