/**
 * The `catalog` adapter against recorded answers from the official MCP Registry and ClawHub
 * (fixtures/http/catalogs.json).
 */
import { afterAll, describe, expect, it } from "vitest";

import { catalogAdapter } from "../src/adapters/catalog.ts";
import type { Candidate, ImportSource, Item } from "../src/index.ts";
import { contextOf, recorded } from "./recording.ts";

const http = recorded("catalogs");
const context = contextOf(http.fetch);

const REGISTRY = "https://registry.modelcontextprotocol.io";
const GITHUB_SERVER = "io.github.github/github-mcp-server";

function first(candidates: readonly Candidate[]): Candidate {
  const [candidate] = candidates;
  if (candidate === undefined) {
    throw new Error("no candidate");
  }
  return candidate;
}

describe("the catalog adapter", () => {
  afterAll(() => {
    http.save();
  });

  describe("the official MCP Registry", () => {
    const source: ImportSource = {
      kind: "catalog",
      path: GITHUB_SERVER,
      url: REGISTRY,
    };

    it("offers a server pinned to its latest version, under the registry's CC0 terms", async () => {
      const found = await catalogAdapter.discover(source, context);
      const candidate = first(
        found.candidates.filter((entry) => entry.key === GITHUB_SERVER)
      );
      expect(candidate).toMatchObject({
        id: "github-mcp-server",
        kind: "mcp",
        licenseId: "CC0-1.0",
        linkOnly: false,
      });
      expect(candidate.upstream.version).toMatch(/^\d+\.\d+\.\d+/u);
      expect(found.warnings).toStrictEqual([]);
    });

    it("imports the definition with its pin, digest, and the registry's credit, and a secret header by reference", async () => {
      const candidate = first(
        (await catalogAdapter.discover(source, context)).candidates.filter(
          (entry) => entry.key === GITHUB_SERVER
        )
      );
      const imported = await catalogAdapter.fetch(
        source,
        candidate,
        { candidate: candidate.key },
        context
      );
      expect(imported.files).toStrictEqual([]);
      expect(imported.item).toMatchObject({
        flavour: "remote",
        headers: {
          Authorization: { secret: "GITHUB_MCP_SERVER_AUTHORIZATION" },
        },
        kind: "mcp",
        name: GITHUB_SERVER,
        transport: "streamable-http",
        url: "https://api.githubcopilot.com/mcp/",
      });
      expect(imported.item.source).toMatchObject({
        creditText: "This data comes from the Official MCP Registry",
        licenseId: "CC0-1.0",
        linkTarget: REGISTRY,
        shareAlike: false,
        version: candidate.upstream.version,
      });
      expect(imported.item.source?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    });

    it("reports drift by version, and a server that is not there as gone", async () => {
      const pinned = (version: string, name = GITHUB_SERVER): Item => ({
        flavour: "remote",
        id: "github-mcp-server",
        kind: "mcp",
        name,
        source: {
          url: `${REGISTRY}/v0.1/servers/${encodeURIComponent(name)}/versions/${version}`,
          version,
        },
        title: "GitHub",
      });
      const latest =
        first((await catalogAdapter.discover(source, context)).candidates)
          .upstream.version ?? "";
      await expect(
        catalogAdapter.checkUpstream(pinned(latest), context)
      ).resolves.toMatchObject({ status: "current" });
      await expect(
        catalogAdapter.checkUpstream(pinned("0.0.1"), context)
      ).resolves.toMatchObject({
        latest: { version: latest },
        status: "moved",
      });
      await expect(
        catalogAdapter.checkUpstream(
          pinned("1.0.0", "io.github.shelfkit-test/no-such-server"),
          context
        )
      ).resolves.toStrictEqual({ status: "gone" });
    });
  });

  describe("ClawHub", () => {
    const source: ImportSource = {
      kind: "catalog",
      path: "steipete/github",
      url: "https://clawhub.ai",
    };

    it("offers a skill under ClawHub's MIT-0 terms, pinned to its version", async () => {
      const found = await catalogAdapter.discover(source, context);
      expect(found.candidates).toHaveLength(1);
      expect(first(found.candidates)).toMatchObject({
        id: "github",
        key: "steipete/github",
        kind: "skill",
        licenseId: "MIT-0",
        linkOnly: false,
        upstream: {
          url: "https://clawhub.ai/steipete/skills/github",
          version: "1.0.0",
        },
      });
    });

    it("copies the files after checking each against the sha256 ClawHub lists, and links back to the listing", async () => {
      const candidate = first(
        (await catalogAdapter.discover(source, context)).candidates
      );
      const imported = await catalogAdapter.fetch(
        source,
        candidate,
        { candidate: candidate.key },
        context
      );
      expect(imported.warnings).toStrictEqual([]);
      expect(imported.files.map((file) => file.path)).toStrictEqual([
        "SKILL.md",
        "skill-card.md",
      ]);
      expect(imported.item.source).toStrictEqual({
        creditText: "Published on ClawHub by @steipete",
        digest: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u
        ) as unknown as string,
        license:
          "MIT-0: every skill published on ClawHub (ClawHub skill format, License)",
        licenseId: "MIT-0",
        linkTarget: "https://clawhub.ai/steipete/skills/github",
        path: "steipete/github",
        recordUrl: "https://clawhub.ai/steipete/skills/github",
        shareAlike: false,
        url: "https://clawhub.ai/steipete/skills/github",
        version: "1.0.0",
      });
    });

    it("refuses bytes that are not the ones ClawHub lists", async () => {
      const tampered: typeof fetch = async (input, init) => {
        const response = await http.fetch(input, init);
        return String(input).includes("/file?path=SKILL.md")
          ? new Response(`${await response.text()}\nextra`)
          : response;
      };
      const candidate = first(
        (await catalogAdapter.discover(source, context)).candidates
      );
      await expect(
        catalogAdapter.fetch(
          source,
          candidate,
          { candidate: candidate.key },
          contextOf(tampered)
        )
      ).rejects.toThrow("is not the");
    });

    it("reports drift by version", async () => {
      const pinned = (version: string): Item => ({
        id: "github",
        kind: "skill",
        source: {
          path: "steipete/github",
          url: "https://clawhub.ai/steipete/skills/github",
          version,
        },
        title: "Github",
      });
      await expect(
        catalogAdapter.checkUpstream(pinned("1.0.0"), context)
      ).resolves.toMatchObject({ status: "current" });
      await expect(
        catalogAdapter.checkUpstream(pinned("0.9.0"), context)
      ).resolves.toMatchObject({
        latest: { version: "1.0.0" },
        status: "moved",
      });
    });

    it("refuses a catalog it does not read, by name", async () => {
      await expect(
        catalogAdapter.discover(
          { kind: "catalog", path: "x", url: "https://example.com/catalog" },
          context
        )
      ).rejects.toThrow("is not a catalog ShelfKit reads");
    });
  });
});
