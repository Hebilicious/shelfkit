/**
 * Indexing a shelf from a public Git repository on any host (`src/forge/artifacts.ts`): Artifacts imports it into a
 * temporary repository, the forge reads the shelf from there, and the import is deleted. Artifacts is Miniflare's
 * local simulator, but for `import`: the simulator's would clone the URL over the network, so a stand-in local to
 * this file creates the repository on the simulator and pushes the upstream's files to it instead.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../src/auth/index.ts";
import { ArtifactsForge } from "../src/forge/artifacts.ts";
import { indexFromForge } from "../src/forge/index.ts";
import { push, pushToRemote, shelfOf } from "./helpers.ts";

const system: Session = { job: "test", kind: "system" };

const PROMPT = {
  "items/prompts/hello/item.json": `${JSON.stringify({ description: "Say hello", id: "hello", kind: "prompt", title: "Hello" })}\n`,
  "items/prompts/hello/prompt.md": "Say hello.\n",
};

/** The simulator's binding, whose `import` reads `upstreams` (each URL's files, by path) instead of the network. */
function importingFrom(
  upstreams: ReadonlyMap<string, Readonly<Record<string, string>>>
): Artifacts {
  return {
    create: async (name, opts) => await env.ARTIFACTS.create(name, opts),
    delete: async (name) => await env.ARTIFACTS.delete(name),
    get: async (name) => await env.ARTIFACTS.get(name),
    import: async ({ source, target }) => {
      const files = upstreams.get(source.url);
      if (files === undefined) {
        throw new Error(`no upstream at ${source.url}`);
      }
      const created = await env.ARTIFACTS.create(target.name, {
        setDefaultBranch: source.branch ?? "main",
      });
      await pushToRemote(created.remote, created.token, files, null);
      return created;
    },
    list: async (opts) => await env.ARTIFACTS.list(opts),
  };
}

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

describe("indexing from any public Git host", () => {
  beforeEach(fresh);

  it("reads a shelf through a temporary import, then deletes it", async () => {
    const url = "https://codeberg.org/someone/shelf.git";
    const upstreams = new Map([
      [
        url,
        { ...shelfOf("kit", false, PROMPT), "README.md": "not a shelf file\n" },
      ],
    ]);
    await push("kit", shelfOf("kit", false, {}));
    const committed = await indexFromForge(
      env,
      new ArtifactsForge(importingFrom(upstreams)),
      system,
      { repository: url, shelf: "kit" }
    );
    expect(committed).toMatchObject({
      changed: { items: ["hello"] },
      ok: true,
      snapshot: { origin: "forge" },
    });
    const listed = await env.ARTIFACTS.list();
    expect(listed.repos.map((repo) => repo.name)).toStrictEqual(["kit"]);
  });
});
