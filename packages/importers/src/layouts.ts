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

/** The files at `base` that a layout needs read to know what they hold. */
export function manifestsToRead(
  entries: readonly TreeEntry[],
  base: string
): { plugin?: string; marketplace?: string } {
  const at = (relative: string): string | undefined => {
    const path = base === "" ? relative : `${base}/${relative}`;
    return entries.some((entry) => entry.path === path) ? path : undefined;
  };
  const plugin = at("plugin.json") ?? at(".claude-plugin/plugin.json");
  const marketplace =
    at("marketplace.json") ?? at(".claude-plugin/marketplace.json");
  return {
    ...(plugin === undefined ? {} : { plugin }),
    ...(marketplace === undefined ? {} : { marketplace }),
  };
}

/** Whether a `plugin.json` is an Agent Plugin (one item) rather than a Claude plugin collection (its primitives). */
export function isAgentPlugin(document: unknown): boolean {
  if (typeof document !== "object" || document === null) {
    return false;
  }
  const schema = (document as { $schema?: unknown }).$schema;
  return typeof schema === "string" && /agent-?plugin/iu.test(schema);
}

/** A server a marketplace declares inline. */
export interface InlineServer {
  readonly name: string;
  readonly definition: Record<string, unknown>;
}

/** The inline `mcpServers` of every plugin in a marketplace document. */
export function inlineServers(document: unknown): InlineServer[] {
  if (typeof document !== "object" || document === null) {
    return [];
  }
  const plugins = (document as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) {
    return [];
  }
  const servers: InlineServer[] = [];
  for (const plugin of plugins as unknown[]) {
    const declared =
      typeof plugin === "object" && plugin !== null
        ? (plugin as { mcpServers?: unknown }).mcpServers
        : undefined;
    if (typeof declared !== "object" || declared === null) {
      continue;
    }
    for (const [name, definition] of Object.entries(declared)) {
      if (typeof definition === "object" && definition !== null) {
        servers.push({
          definition: definition as Record<string, unknown>,
          name,
        });
      }
    }
  }
  return servers;
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
