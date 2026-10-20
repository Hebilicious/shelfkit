/**
 * The `shelfkit` adapter against recorded answers from the deployed instance, https://shelfkit.hebilicious.workers.dev
 * (fixtures/http/shelfkit-instance.json): read-only GraphQL queries and registry listings.
 */
import * as v from "valibot";
import { afterAll, describe, expect, it } from "vitest";

import { shelfkitAdapter } from "../src/adapters/shelfkit.ts";
import type { Candidate, ImportSource, Item } from "../src/index.ts";
import { contextOf, recorded } from "./recording.ts";

const http = recorded("shelfkit-instance");
const context = contextOf(http.fetch);

const INSTANCE = "https://shelfkit.hebilicious.workers.dev";
const source: ImportSource = {
  kind: "shelfkit",
  path: "hebilicious",
  sourceId: "hebilicious",
  url: INSTANCE,
};

/** The instance's default profile, imported as a reference pinned to `version`. */
function reference(version: string): Item {
  return {
    id: "hebilicious-default",
    kind: "instructions",
    source: { path: "hebilicious/default", url: INSTANCE, version },
    title: "ShelfKit development",
  };
}

/** An item of the instance, imported as a link pinned to `digest`. */
function link(digest: string, name = "commit-style"): Item {
  return {
    id: "commit-style",
    kind: "prompt",
    source: { digest, path: `hebilicious/${name}`, url: INSTANCE },
    title: "Commit message",
  };
}

function byKey(candidates: readonly Candidate[], key: string): Candidate {
  const found = candidates.find((candidate) => candidate.key === key);
  if (found === undefined) {
    throw new Error(`no candidate ${key}`);
  }
  return found;
}

describe("the shelfkit adapter", () => {
  afterAll(() => {
    http.save();
  });

  it("offers the instance's published profile as a registry reference, and its authored items as links", async () => {
    const found = await shelfkitAdapter.discover(source, context);
    const profile = byKey(found.candidates, "profile:default");
    expect(profile).toMatchObject({
      id: "hebilicious-default",
      kind: "instructions",
      linkOnly: true,
      path: "hebilicious/default",
      upstream: { url: INSTANCE },
    });
    expect(profile.upstream.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(byKey(found.candidates, "item:commit-style")).toMatchObject({
      kind: "prompt",
      linkOnly: true,
    });
    expect(
      found.warnings.some((warning) => warning.includes("state no licence"))
    ).toBeTruthy();
  });

  it("imports the profile as a pinned reference to the instance's registry package, copying nothing", async () => {
    const found = await shelfkitAdapter.discover(source, context);
    const profile = byKey(found.candidates, "profile:default");
    const imported = await shelfkitAdapter.fetch(
      source,
      profile,
      { candidate: profile.key },
      context
    );
    // The instance states no licence for the profile, so not even its description is copied.
    expect([
      imported.files,
      imported.warnings,
      imported.item.description,
    ]).toStrictEqual([[], [], undefined]);
    expect(imported.item.source).toStrictEqual({
      digest: profile.upstream.digest,
      id: "hebilicious",
      license:
        "none stated; a reference to the instance's registry package, nothing is copied",
      linkTarget: INSTANCE,
      path: "hebilicious/default",
      recordUrl: `${INSTANCE}/apm/v1/packages/hebilicious/default/versions`,
      url: INSTANCE,
      version: profile.upstream.version,
    });
  });

  it("imports an authored item with no licence as a link to its record, with a warning", async () => {
    const found = await shelfkitAdapter.discover(source, context);
    const prompt = byKey(found.candidates, "item:commit-style");
    const imported = await shelfkitAdapter.fetch(
      source,
      prompt,
      { candidate: prompt.key },
      context
    );
    expect(imported.files).toStrictEqual([]);
    expect(imported.item).toStrictEqual({
      id: "commit-style",
      kind: "prompt",
      source: {
        digest: prompt.upstream.digest,
        id: "hebilicious",
        license: "none stated",
        linkTarget: INSTANCE,
        path: "hebilicious/commit-style",
        recordUrl: `${INSTANCE}/shelves/hebilicious/items/commit-style`,
        url: INSTANCE,
      },
      title: "Commit message",
    });
    expect(imported.warnings).toHaveLength(1);
  });

  it("reports drift for a profile by its published version, and for an item by its revision", async () => {
    const found = await shelfkitAdapter.discover(source, context);
    const profile = byKey(found.candidates, "profile:default");
    const prompt = byKey(found.candidates, "item:commit-style");
    const zeros = `sha256:${"0".repeat(64)}`;
    await expect(
      shelfkitAdapter.checkUpstream(
        reference(profile.upstream.version ?? ""),
        context
      )
    ).resolves.toMatchObject({ status: "current" });
    await expect(
      shelfkitAdapter.checkUpstream(reference("0.0.0-old"), context)
    ).resolves.toMatchObject({
      status: "moved",
    });
    await expect(
      shelfkitAdapter.checkUpstream(link(prompt.upstream.digest ?? ""), context)
    ).resolves.toMatchObject({ status: "current" });
    await expect(
      shelfkitAdapter.checkUpstream(link(zeros), context)
    ).resolves.toMatchObject({ status: "moved" });
    await expect(
      shelfkitAdapter.checkUpstream(link(zeros, "no-such-item"), context)
    ).resolves.toStrictEqual({
      status: "gone",
    });
  });
});

/** A hand-written instance (not a recording) holding an unlicensed MCP server and an MIT skill imported from Git. */
const REVISION = `sha256-${"1".repeat(64)}`;
const SKILL_SOURCE = {
  license: "MIT",
  licenseId: "MIT",
  path: "skills/pdf",
  repo: "https://github.com/acme/kit",
  resolvedCommit: "a".repeat(40),
};
const DOCUMENTS = new Map<
  string,
  { summary: object; document: object; files: object[] }
>([
  [
    "linear",
    {
      document: {
        description: "Linear's issues, as tools.",
        flavour: "remote",
        headers: { Authorization: { secret: "LINEAR_API_KEY" } },
        id: "linear",
        kind: "mcp",
        title: "Linear",
        tools: ["create_issue"],
        transport: "streamable-http",
        url: "https://mcp.linear.app/mcp",
      },
      files: [{ contents: "notes", encoding: "utf-8", path: "README.md" }],
      summary: {
        id: "linear",
        kind: "mcp",
        revision: REVISION,
        source: null,
        title: "Linear",
      },
    },
  ],
  [
    "pdf",
    {
      document: {
        description: "Read PDFs.",
        id: "pdf",
        kind: "skill",
        source: SKILL_SOURCE,
        title: "PDF",
      },
      files: [
        {
          contents: "---\nname: pdf\ndescription: Read PDFs.\n---\n",
          encoding: "utf-8",
          path: "SKILL.md",
        },
      ],
      summary: {
        id: "pdf",
        kind: "skill",
        revision: REVISION,
        source: SKILL_SOURCE,
        title: "PDF",
      },
    },
  ],
]);

const fakeInstance: typeof fetch = async (_input, init) => {
  const body = v.parse(
    v.object({ query: v.string(), variables: v.object({ item: v.string() }) }),
    JSON.parse(v.parse(v.string(), init?.body))
  );
  const found = DOCUMENTS.get(body.variables.item);
  const item = body.query.includes("ItemContent")
    ? { document: found?.document, files: found?.files, revision: REVISION }
    : found?.summary;
  return await Promise.resolve(
    Response.json({ data: { shelf: { item: item ?? null } } })
  );
};

/** A candidate for an item of the hand-written instance. */
function pick(key: string): Candidate {
  return {
    id: key.slice(5),
    key,
    kind: "skill",
    linkOnly: true,
    title: key,
    upstream: {},
  };
}

describe("re-exporting from an instance", () => {
  const fake: ImportSource = {
    kind: "shelfkit",
    path: "team",
    url: "https://shelf.example",
  };

  it("keeps only an unlicensed MCP server's endpoint: no description, credentials, tools, or files", async () => {
    const imported = await shelfkitAdapter.fetch(
      fake,
      pick("item:linear"),
      { candidate: "item:linear" },
      contextOf(fakeInstance)
    );
    expect(imported.files).toStrictEqual([]);
    expect(imported.item).toStrictEqual({
      flavour: "remote",
      id: "linear",
      kind: "mcp",
      source: {
        digest: `sha256:${"1".repeat(64)}`,
        license: "none stated",
        linkTarget: "https://shelf.example",
        path: "team/linear",
        recordUrl: "https://shelf.example/shelves/team/items/linear",
        url: "https://shelf.example",
      },
      title: "Linear",
      transport: "streamable-http",
      url: "https://mcp.linear.app/mcp",
    });
  });

  it("keeps a licensed item's upstream commit and pins the copy to the instance's revision", async () => {
    const imported = await shelfkitAdapter.fetch(
      fake,
      pick("item:pdf"),
      { candidate: "item:pdf" },
      contextOf(fakeInstance)
    );
    expect(imported.files.map((file) => file.path)).toStrictEqual(["SKILL.md"]);
    expect(imported.item.source).toStrictEqual({
      ...SKILL_SOURCE,
      digest: `sha256:${"1".repeat(64)}`,
      linkTarget: "https://shelf.example",
      recordUrl: "https://shelf.example/shelves/team/items/pdf",
    });
  });

  it("refuses an instance that is not https", async () => {
    await expect(
      shelfkitAdapter.discover(
        { kind: "shelfkit", path: "team", url: "http://shelf.example" },
        contextOf(fakeInstance)
      )
    ).rejects.toThrow("https");
  });
});
