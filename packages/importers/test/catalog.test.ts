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
const registrySource: ImportSource = {
  kind: "catalog",
  path: GITHUB_SERVER,
  url: REGISTRY,
};
const clawHubSource: ImportSource = {
  kind: "catalog",
  path: "steipete/github",
  url: "https://clawhub.ai",
};

/** The candidate a discovery offers for `key`. */
async function candidateOf(
  source: ImportSource,
  key: string
): Promise<Candidate> {
  const found = await catalogAdapter.discover(source, context);
  const candidate = found.candidates.find((entry) => entry.key === key);
  if (candidate === undefined) {
    throw new Error(`no candidate ${key}`);
  }
  return candidate;
}

/** The GitHub server, pinned to `version`, under `name`. */
function registryItem(version: string, name = GITHUB_SERVER): Item {
  return {
    flavour: "remote",
    id: "github-mcp-server",
    kind: "mcp",
    name,
    source: {
      url: `${REGISTRY}/v0.1/servers/${encodeURIComponent(name)}/versions/${version}`,
      version,
    },
    title: "GitHub",
  };
}

/** steipete's GitHub skill on ClawHub, pinned to `version`. */
function clawHubItem(version: string): Item {
  return {
    id: "github",
    kind: "skill",
    source: {
      path: "steipete/github",
      url: "https://clawhub.ai/steipete/skills/github",
      version,
    },
    title: "Github",
  };
}

/** The recording, with one more line appended to SKILL.md: bytes ClawHub never published. */
const tampered: typeof fetch = async (input, init) => {
  const response = await http.fetch(input, init);
  const url = input instanceof Request ? input.url : input.toString();
  if (!url.includes("/file?path=SKILL.md")) {
    return response;
  }
  const text = await response.text();
  return new Response(`${text}\nextra`);
};

describe("the catalog adapter", () => {
  afterAll(() => {
    http.save();
  });

  describe("the official MCP Registry", () => {
    it("offers a server pinned to its latest version, under the registry's CC0 terms", async () => {
      const found = await catalogAdapter.discover(registrySource, context);
      const candidate = await candidateOf(registrySource, GITHUB_SERVER);
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
      const candidate = await candidateOf(registrySource, GITHUB_SERVER);
      const imported = await catalogAdapter.fetch(
        registrySource,
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
      const candidate = await candidateOf(registrySource, GITHUB_SERVER);
      const latest = candidate.upstream.version ?? "";
      await expect(
        catalogAdapter.checkUpstream(registryItem(latest), context)
      ).resolves.toMatchObject({
        status: "current",
      });
      await expect(
        catalogAdapter.checkUpstream(registryItem("0.0.1"), context)
      ).resolves.toMatchObject({
        latest: { version: latest },
        status: "moved",
      });
      await expect(
        catalogAdapter.checkUpstream(
          registryItem("1.0.0", "io.github.shelfkit-test/no-such-server"),
          context
        )
      ).resolves.toStrictEqual({ status: "gone" });
    });
  });

  describe("ClawHub", () => {
    it("offers a skill under ClawHub's MIT-0 terms, pinned to its version", async () => {
      const found = await catalogAdapter.discover(clawHubSource, context);
      expect(found.candidates).toHaveLength(1);
      expect(found.candidates[0]).toMatchObject({
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
      const candidate = await candidateOf(clawHubSource, "steipete/github");
      const imported = await catalogAdapter.fetch(
        clawHubSource,
        candidate,
        { candidate: candidate.key },
        context
      );
      expect(imported.warnings).toStrictEqual([]);
      expect(imported.files.map((file) => file.path)).toStrictEqual([
        "SKILL.md",
        "skill-card.md",
      ]);
      expect(imported.item.source?.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect({
        ...imported.item.source,
        digest: "checked above",
      }).toStrictEqual({
        creditText: "Published on ClawHub by @steipete",
        digest: "checked above",
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
      const candidate = await candidateOf(clawHubSource, "steipete/github");
      await expect(
        catalogAdapter.fetch(
          clawHubSource,
          candidate,
          { candidate: candidate.key },
          contextOf(tampered)
        )
      ).rejects.toThrow("is not the");
    });

    it("reports drift by version", async () => {
      await expect(
        catalogAdapter.checkUpstream(clawHubItem("1.0.0"), context)
      ).resolves.toMatchObject({
        status: "current",
      });
      await expect(
        catalogAdapter.checkUpstream(clawHubItem("0.9.0"), context)
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
