/**
 * Discovery over a repository's files, by APM's package layouts (`docs/PRD.md` section 6). This module only reads
 * paths; the adapter reads the few files a layout needs opened (`plugin.json`, `marketplace.json`).
 *
 * | Layout                                     | Becomes                                   |
 * | ------------------------------------------ | ----------------------------------------- |
 * | `.apm/` typed primitives                   | one item per primitive, kind from its file |
 * | a root `SKILL.md`                          | one skill, the whole repository           |
 * | `skills/<name>/SKILL.md` (any `SKILL.md`)  | one skill per directory                   |
 * | `hooks/*.json`                             | one hook per file                         |
 * | `plugin.json` with an Agent Plugin schema  | one plugin                                |
 * | a marketplace with inline `mcpServers`     | one `mcp` item per server                 |
 * | one `*.prompt.md`, `*.instructions.md`, or `*.agent.md` | one item pinned to that file |
 *
 * A shelf never rewrites a package's layout: each artifact keeps the path it has upstream, and that path is what the
 * compiled `apm.yml` pins.
 */
import type { ItemKind } from "@shelfkit/schema";
import * as v from "valibot";

import type { TreeEntry } from "./github.ts";
import { byCodePoint } from "./http.ts";

/** One thing a repository offers, before its licence is known. */
export interface Artifact {
  /** Unique within the discovery: the file that defines the artifact. */
  readonly key: string;
  readonly kind: ItemKind;
  /** The path APM pins: a file, a directory, or `""` for the whole repository. */
  readonly path: string;
  /** The directory whose licence file applies first. */
  readonly directory: string;
  /** A name to derive the id and title from. */
  readonly name: string;
  /** For a skill: every file under its directory. */
  readonly files?: readonly TreeEntry[];
}

const FILE_KINDS: readonly [string, ItemKind][] = [
  [".prompt.md", "prompt"],
  [".instructions.md", "instructions"],
  [".agent.md", "agent"],
];

/** Directories never searched: dependencies and VCS metadata. */
function ignored(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment === "node_modules" || segment === ".git");
}

function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The artifacts under `base` in a listing. `entries` are relative to the repository root and include everything
 * under `base` (or the one file `base` names).
 */
export function findArtifacts(
  entries: readonly TreeEntry[],
  base: string
): Artifact[] {
  const blobs = entries.filter(
    (entry) => entry.type === "blob" && !ignored(entry.path)
  );
  const artifacts: Artifact[] = [];

  // Skills first: a file inside a skill's directory belongs to the skill, not to another layout. A skill nested in
  // another skill's directory is part of that skill. A root SKILL.md is the repository as one bundle, beside any
  // skills nested under it.
  const allSkills = blobs
    .filter((entry) => basename(entry.path) === "SKILL.md")
    .map((entry) => parent(entry.path));
  const skillDirectories = allSkills.filter(
    (directory) =>
      !allSkills.some(
        (outer) =>
          outer !== "" &&
          outer !== directory &&
          directory.startsWith(`${outer}/`)
      )
  );
  const insideSkill = (path: string): string | undefined =>
    skillDirectories
      .filter(
        (directory) => directory === "" || path.startsWith(`${directory}/`)
      )
      .toSorted((a, b) => b.length - a.length)[0];

  for (const directory of skillDirectories) {
    artifacts.push({
      directory,
      files: blobs.filter((entry) => insideSkill(entry.path) === directory),
      key: directory === "" ? "SKILL.md" : `${directory}/SKILL.md`,
      kind: "skill",
      name: directory === "" ? basename(base) || "skill" : basename(directory),
      path: directory,
    });
  }

  for (const entry of blobs) {
    if (insideSkill(entry.path) !== undefined) {
      continue;
    }
    const name = basename(entry.path);
    const typed = FILE_KINDS.find(([extension]) => name.endsWith(extension));
    if (typed !== undefined) {
      const [extension, kind] = typed;
      artifacts.push({
        directory: parent(entry.path),
        key: entry.path,
        kind,
        name: name.slice(0, -extension.length),
        path: entry.path,
      });
      continue;
    }
    if (name.endsWith(".json") && basename(parent(entry.path)) === "hooks") {
      artifacts.push({
        directory: parent(entry.path),
        key: entry.path,
        kind: "hook",
        name: name.slice(0, -".json".length),
        path: entry.path,
      });
    }
  }
  return artifacts.toSorted((a, b) => byCodePoint(a.key, b.key));
}

/** The manifests at `base` that a layout needs read to know what they hold. */
export interface Manifests {
  plugin?: string;
  marketplace?: string;
}

/** The files at `base` that a layout needs read to know what they hold. */
export function manifestsToRead(
  entries: readonly TreeEntry[],
  base: string
): Manifests {
  const at = (relative: string): string | undefined => {
    const path = base === "" ? relative : `${base}/${relative}`;
    return entries.some((entry) => entry.path === path) ? path : undefined;
  };
  const found: Manifests = {};
  const plugin = at("plugin.json") ?? at(".claude-plugin/plugin.json");
  if (plugin !== undefined) {
    found.plugin = plugin;
  }
  const marketplace =
    at("marketplace.json") ?? at(".claude-plugin/marketplace.json");
  if (marketplace !== undefined) {
    found.marketplace = marketplace;
  }
  return found;
}

/** A `plugin.json`, as far as telling its kind needs. */
export const PluginManifestSchema = v.looseObject({
  $schema: v.optional(v.string()),
});

/** Whether a `plugin.json` is an Agent Plugin (one item) rather than a Claude plugin collection (its primitives). */
export function isAgentPlugin(
  document: v.InferOutput<typeof PluginManifestSchema>
): boolean {
  return (
    document.$schema !== undefined && /agent-?plugin/iu.test(document.$schema)
  );
}

/** A server a marketplace declares inline, as far as ShelfKit reads it. */
export const ServerDefinitionSchema = v.looseObject({
  args: v.optional(v.array(v.string())),
  command: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  headers: v.optional(v.record(v.string(), v.string())),
  type: v.optional(v.string()),
  url: v.optional(v.string()),
});

export type ServerDefinition = v.InferOutput<typeof ServerDefinitionSchema>;

/** A marketplace document: plugins, some declaring MCP servers inline. */
export const MarketplaceSchema = v.looseObject({
  plugins: v.fallback(
    v.array(
      v.looseObject({
        mcpServers: v.fallback(
          v.record(v.string(), ServerDefinitionSchema),
          {}
        ),
      })
    ),
    []
  ),
});

/** A server a marketplace declares inline. */
export interface InlineServer {
  readonly name: string;
  readonly definition: ServerDefinition;
}

/** The inline `mcpServers` of every plugin in a marketplace document. */
export function inlineServers(
  document: v.InferOutput<typeof MarketplaceSchema>
): InlineServer[] {
  return document.plugins.flatMap((plugin) =>
    Object.entries(plugin.mcpServers).map(([name, definition]) => ({
      definition,
      name,
    }))
  );
}

/** The directories from `directory` up to the root, nearest first. */
export function ancestry(directory: string): string[] {
  const out = [directory];
  let here = directory;
  while (here !== "") {
    here = parent(here);
    out.push(here);
  }
  return out;
}

export { basename, parent };
