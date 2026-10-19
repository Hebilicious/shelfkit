/**
 * The `shelfkit` adapter against recorded answers from the deployed instance, https://shelfkit.hebilicious.workers.dev
 * (fixtures/http/shelfkit-instance.json): read-only GraphQL queries and registry listings.
 */
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
    expect(imported.files).toStrictEqual([]);
    expect(imported.warnings).toStrictEqual([]);
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
        recordUrl: `${INSTANCE}/item?shelf=hebilicious&id=commit-style`,
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
