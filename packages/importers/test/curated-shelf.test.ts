/**
 * M4's exit criterion (`docs/PRD.md` section 12): a shelf built mostly from curated, pinned imports from public
 * sources, one of them another ShelfKit instance, with provenance and licence recorded per item.
 *
 * The adapters import from five sources over the recorded responses and write the shelf the Worker's `applyImport`
 * would write: `items/<kind>/<id>/item.json` (two-space JSON and a final newline) beside the item's files. The result
 * is compared with the committed shelf in `fixtures/curated-shelf/`, which `crates/compiler/tests/curation.rs` loads
 * with `crates/core` and compiles with `shelfkit compile`. Run with `SHELFKIT_UPDATE_GOLDEN=1` to rewrite it.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { adapterFor } from "../src/index.ts";
import type { ImportedItem, ImportSource } from "../src/index.ts";
import { contextOf, recorded } from "./recording.ts";

const GOLDEN = join(import.meta.dirname, "fixtures", "curated-shelf");
const update = process.env.SHELFKIT_UPDATE_GOLDEN === "1";

const DIRECTORIES: Readonly<Record<string, string>> = {
  agent: "agents",
  hook: "hooks",
  instructions: "instructions",
  library: "libraries",
  lsp: "lsp",
  mcp: "mcp",
  plugin: "plugins",
  prompt: "prompts",
  skill: "skills",
  stack: "stacks",
};

const HEAD = "dbd4588f9e1033efb41dad4bef2f7947c8993d44";

/** Each import: the shelf.json source it reads, and which candidates to take. */
const IMPORTS: readonly {
  source: ImportSource;
  fixture: string;
  keys?: readonly string[];
}[] = [
  {
    fixture: "github",
    source: {
      kind: "git",
      path: "skills/brand-guidelines",
      ref: HEAD,
      repo: "https://github.com/anthropics/skills",
      sourceId: "anthropics",
    },
  },
  {
    fixture: "github",
    source: {
      kind: "git",
      path: "skills/doc-coauthoring",
      ref: HEAD,
      repo: "https://github.com/anthropics/skills",
      sourceId: "anthropics",
    },
  },
  {
    fixture: "github",
    source: {
      kind: "git",
      path: "instructions/rust.instructions.md",
      repo: "https://github.com/github/awesome-copilot",
      sourceId: "awesome-copilot",
    },
  },
  {
    fixture: "github",
    source: {
      kind: "git",
      path: "agents/CSharpExpert.agent.md",
      repo: "https://github.com/github/awesome-copilot",
      sourceId: "awesome-copilot",
    },
  },
  {
    fixture: "catalogs",
    keys: ["io.github.github/github-mcp-server"],
    source: {
      kind: "catalog",
      path: "io.github.github/github-mcp-server",
      sourceId: "mcp-registry",
      url: "https://registry.modelcontextprotocol.io",
    },
  },
  {
    fixture: "catalogs",
    source: {
      kind: "catalog",
      path: "steipete/github",
      sourceId: "clawhub",
      url: "https://clawhub.ai",
    },
  },
  {
    fixture: "shelfkit-instance",
    keys: ["profile:default"],
    source: {
      kind: "shelfkit",
      path: "hebilicious",
      sourceId: "hebilicious",
      url: "https://shelfkit.hebilicious.workers.dev",
    },
  },
];

const MANIFEST = {
  $schema: "https://shelfkit.dev/schemas/shelf.json",
  defaultProfile: "default",
  description:
    "M4's exit criterion: a shelf of curated, pinned imports from five public sources, one of them another ShelfKit instance.",
  name: "curated",
  registry: { namespace: "curated", public: true },
  sources: [
    {
      id: "anthropics",
      kind: "git",
      repo: "https://github.com/anthropics/skills",
    },
    {
      id: "awesome-copilot",
      kind: "git",
      repo: "https://github.com/github/awesome-copilot",
    },
    {
      id: "mcp-registry",
      kind: "catalog",
      url: "https://registry.modelcontextprotocol.io",
    },
    { id: "clawhub", kind: "catalog", url: "https://clawhub.ai" },
    {
      id: "hebilicious",
      kind: "shelfkit",
      path: "hebilicious",
      url: "https://shelfkit.hebilicious.workers.dev",
    },
  ],
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function importEverything(): Promise<{
  items: ImportedItem[];
  warnings: string[];
}> {
  const items: ImportedItem[] = [];
  const warnings: string[] = [];
  for (const { fixture, keys, source } of IMPORTS) {
    const context = contextOf(recorded(fixture).fetch);
    const adapter = adapterFor(source.kind);
    if (adapter === undefined) {
      throw new Error(`no adapter for ${source.kind}`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- one source after another, as an owner would import them.
    const found = await adapter.discover(source, context);
    warnings.push(...found.warnings);
    for (const candidate of found.candidates.filter(
      (entry) => keys === undefined || keys.includes(entry.key)
    )) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
      const imported = await adapter.fetch(
        source,
        candidate,
        { candidate: candidate.key },
        context
      );
      items.push(imported);
      warnings.push(...imported.warnings);
    }
  }
  return { items, warnings };
}

/** The shelf's files, by path from its root: text, or base64 for a file that is not UTF-8 (none here yet). */
function shelfFiles(items: readonly ImportedItem[]): Map<string, string> {
  const files = new Map<string, string>([["shelf.json", json(MANIFEST)]]);
  for (const { item, files: content } of items) {
    const directory = `items/${DIRECTORIES[item.kind] ?? item.kind}/${item.id}`;
    files.set(`${directory}/item.json`, json(item));
    for (const file of content) {
      files.set(
        `${directory}/${file.path}`,
        file.encoding === "utf-8"
          ? file.contents
          : Buffer.from(file.contents, "base64").toString("base64")
      );
    }
  }
  // Everything the shelf can compile: all but the link-only skill, which has no content to vendor and no upstream
  // package APM could install by itself.
  const compiled = items
    .map(({ item }) => item.id)
    .filter((id) => id !== "doc-coauthoring")
    .toSorted();
  files.set(
    "profiles/default.json",
    json({
      $schema: "https://shelfkit.dev/schemas/profile.json",
      bundles: [],
      compile: { pin: "revision", targets: ["claude", "copilot"] },
      description: "Every compilable import, pinned.",
      extends: [],
      id: "default",
      items: compiled,
      title: "Curated imports",
    })
  );
  return files;
}

function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(root)) {
    return files;
  }
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(
        relative(root, path).split("\\").join("/"),
        readFileSync(path, "utf8")
      );
    }
  }
  return files;
}

describe("the curated shelf (M4's exit criterion)", () => {
  it("is built from pinned imports across five sources, with provenance and licence on every item", async () => {
    const { items, warnings } = await importEverything();
    const sources = new Set(items.map(({ item }) => item.source?.id));
    expect([...sources].toSorted()).toStrictEqual([
      "anthropics",
      "awesome-copilot",
      "clawhub",
      "hebilicious",
      "mcp-registry",
    ]);
    for (const { item } of items) {
      const source = item.source ?? {};
      expect(source.license, item.id).toBeDefined();
      expect(
        source.resolvedCommit ?? source.version ?? source.digest,
        item.id
      ).toBeDefined();
    }
    // The one source with no licence contributes a URL, and says so.
    expect(
      warnings.filter((warning) => warning.includes("imported as a link"))
    ).toHaveLength(1);

    const files = shelfFiles(items);
    if (update) {
      rmSync(GOLDEN, { force: true, recursive: true });
      for (const [path, contents] of files) {
        mkdirSync(dirname(join(GOLDEN, path)), { recursive: true });
        writeFileSync(join(GOLDEN, path), contents);
      }
    }
    expect(readTree(GOLDEN)).toStrictEqual(files);
  });
});
