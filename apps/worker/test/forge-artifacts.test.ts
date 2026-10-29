/**
 * Indexing a shelf from a public Git repository on any host (`src/forge/artifacts.ts`): Artifacts imports it into a
 * temporary repository, the forge reads the shelf from there, and the import is deleted. Artifacts is the stand-in in
 * `fake-artifacts.ts`.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../src/auth/index.ts";
import { ArtifactsForge } from "../src/forge/artifacts.ts";
import { indexFromForge } from "../src/forge/index.ts";
import { fakeArtifacts, repositories } from "./fake-artifacts.ts";
import { push, shelfOf } from "./helpers.ts";

const system: Session = { job: "test", kind: "system" };

const PROMPT = {
  "items/prompts/hello/item.json": `${JSON.stringify({ description: "Say hello", id: "hello", kind: "prompt", title: "Hello" })}\n`,
  "items/prompts/hello/prompt.md": "Say hello.\n",
};

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
  repositories.artifacts = true;
  fakeArtifacts.requests.length = 0;
  fakeArtifacts.upstreams.clear();
}

describe("indexing from any public Git host", () => {
  beforeEach(fresh);

  it("reads a shelf through a temporary import, then deletes it", async () => {
    const url = "https://codeberg.org/someone/shelf.git";
    fakeArtifacts.upstreams.set(url, {
      ...shelfOf("kit", false, PROMPT),
      "README.md": "not a shelf file\n",
    });
    await push("kit", shelfOf("kit", false, {}));
    const committed = await indexFromForge(
      env,
      new ArtifactsForge(fakeArtifacts),
      system,
      { repository: url, shelf: "kit" }
    );
    expect(committed).toMatchObject({
      changed: { items: ["hello"] },
      ok: true,
      snapshot: { origin: "forge" },
    });
    const listed = await fakeArtifacts.list();
    expect(listed.repos.map((repo) => repo.name)).toStrictEqual(["kit"]);
  });
});
