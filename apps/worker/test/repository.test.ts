/**
 * Each shelf's Git repository (`src/repository/`, `src/git.ts`): every write the Worker makes becomes a commit, a push
 * through `/git/{shelf}.git` is indexed afterwards, a head the engine refuses leaves the index where it was, and the
 * Git route decides access with the same keys as every other surface. Artifacts is the stand-in in
 * `fake-artifacts.ts`, behind the real adapter.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../src/auth/index.ts";
import { engine } from "../src/engine.ts";
import { ArtifactsForge } from "../src/forge/artifacts.ts";
import { indexFromForge } from "../src/forge/index.ts";
import { ArtifactsRepository } from "../src/repository/artifacts.ts";
import { fakeArtifacts, repositories } from "./fake-artifacts.ts";
import {
  createKey,
  data,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

const system: Session = { job: "test", kind: "system" };
const encoder = new TextEncoder();

const PROMPT = {
  "items/prompts/hello/item.json": `${JSON.stringify({ description: "Say hello", id: "hello", kind: "prompt", title: "Hello" })}\n`,
  "items/prompts/hello/prompt.md": "Say hello.\n",
};

function stub(shelf: string) {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}

async function sync(shelf: string) {
  return await stub(shelf).syncRepository(system, shelf);
}

/**
 * Index the repository's head. The Git route queues the same sync after a push, and the queue may get there first, so
 * either answer means the head is indexed.
 */
async function indexed(shelf: string): Promise<boolean> {
  const synced = await sync(shelf);
  return synced.status === "indexed" || synced.status === "current";
}

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
  repositories.enabled = true;
  fakeArtifacts.requests.length = 0;
  fakeArtifacts.upstreams.clear();
}

/** The commits of a repository's `main`, newest first. */
async function history(shelf: string): Promise<ArtifactsCommitMetadata[]> {
  const repo = await fakeArtifacts.get(shelf);
  return await repo.log({ ref: "main" });
}

async function headOf(shelf: string): Promise<ArtifactsCommitMetadata> {
  const [head] = await history(shelf);
  if (head === undefined) {
    throw new Error(`${shelf}'s repository has no commit`);
  }
  return head;
}

/** Every file under `tree`, by path, as text. */
async function filesUnder(
  repo: ArtifactsRepo,
  tree: string,
  prefix: string
): Promise<[string, string][]> {
  const entries = (await repo.readTree(tree)) ?? [];
  const files = await Promise.all(
    entries.map(async (entry): Promise<[string, string][]> => {
      const path = `${prefix}${entry.name}`;
      if (entry.type === "tree") {
        return await filesUnder(repo, entry.hash, `${path}/`);
      }
      const blob = await repo.readBlob(entry.hash);
      const text = blob === null ? "" : await blob.text();
      return [[path, text]];
    })
  );
  return files.flat();
}

/** The files of a repository's head, by path, as text. */
async function headFiles(shelf: string): Promise<Record<string, string>> {
  const head = await headOf(shelf);
  const repo = await fakeArtifacts.get(shelf);
  const files = await filesUnder(repo, head.treeHash, "");
  return Object.fromEntries(files.toSorted(([a], [b]) => a.localeCompare(b)));
}

function basic(key: string): string {
  return `Basic ${btoa(`git:${key}`)}`;
}

/** Push `files` to the shelf's repository through the Git route, as `git push` does, on top of `parent`. */
async function gitPush(
  shelf: string,
  files: Readonly<Record<string, string>>,
  parent: string | null,
  key: string = TEST_OWNER_KEY
): Promise<{ readonly status: number; readonly commit: string }> {
  const shelfEngine = await engine();
  const planned = shelfEngine.gitCommit({
    author: {
      email: "dev@example.com",
      name: "Dev",
      offset: 0,
      time: 1_700_000_000,
    },
    base: [],
    files: Object.entries(files).map(([path, contents]) => ({
      contents: encoder.encode(contents),
      path,
    })),
    message: "a push from a Git client",
    parent: parent ?? undefined,
    ref: "refs/heads/main",
  });
  if (!planned.ok || planned.value.request === null) {
    throw new Error("nothing to push");
  }
  const response = await exports.default.fetch(
    `${ORIGIN}/git/${shelf}.git/git-receive-pack`,
    {
      body: Uint8Array.from(planned.value.request),
      headers: {
        authorization: basic(key),
        "content-type": "application/x-git-receive-pack-request",
      },
      method: "POST",
    }
  );
  // The route indexes the push once its whole answer has been read.
  await response.arrayBuffer();
  return { commit: planned.value.commit, status: response.status };
}

/** The ref advertisement of a shelf's repository, as a Git client asks for it. */
async function advertise(
  shelf: string,
  service: string,
  key?: string
): Promise<Response> {
  return await exports.default.fetch(
    `${ORIGIN}/git/${shelf}.git/info/refs?service=${service}`,
    { headers: key === undefined ? {} : { authorization: basic(key) } }
  );
}

const RepositorySchema = v.object({
  shelf: v.object({
    repository: v.nullable(
      v.object({
        commit: v.nullable(v.string()),
        refused: v.nullable(
          v.object({
            commit: v.string(),
            errors: v.array(
              v.object({ message: v.string(), path: v.string() })
            ),
          })
        ),
        url: v.string(),
      })
    ),
    snapshot: v.nullable(
      v.object({ commit: v.nullable(v.string()), origin: v.string() })
    ),
  }),
});

async function repositoryOf(shelf: string) {
  const found = await data(
    RepositorySchema,
    `query Repo($shelf: ID!) {
      shelf(id: $shelf) {
        repository { url commit refused { commit errors { path message } } }
        snapshot { commit origin }
      }
    }`,
    { shelf }
  );
  return found.shelf;
}

function withPrompt(text: string) {
  return { ...PROMPT, "items/prompts/hello/prompt.md": text };
}

describe("writes become commits", () => {
  beforeEach(fresh);

  it("commits the first push as the repository's root commit", async () => {
    const pushed = await push("kit", shelfOf("kit", false, PROMPT));
    expect(pushed.errors).toStrictEqual([]);
    const head = await headOf("kit");
    expect(head.parents).toStrictEqual([]);
    await expect(headFiles("kit")).resolves.toStrictEqual(
      shelfOf("kit", false, PROMPT)
    );
  });

  it("commits the next push on top of it, and says where the shelf is", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const first = await headOf("kit");
    await push("kit", shelfOf("kit", false, withPrompt("Warmly.\n")));
    const second = await headOf("kit");
    expect(second.parents).toStrictEqual([first.hash]);
    await expect(repositoryOf("kit")).resolves.toStrictEqual({
      repository: {
        commit: second.hash,
        refused: null,
        url: `${ORIGIN}/git/kit.git`,
      },
      snapshot: { commit: second.hash, origin: "push" },
    });
  });

  it("commits an edit in the UI as that edit, leaving the rest of item.json as it was written", async () => {
    const written = `{
  "id": "hello",
  "kind": "prompt",
  "title": "Hello",
  "description": "Say hello",
  "variables": [{ "name": "who", "required": false }]
}
`;
    await push(
      "kit",
      shelfOf("kit", false, {
        ...PROMPT,
        "items/prompts/hello/item.json": written,
      })
    );
    await data(
      v.unknown(),
      `mutation { updatePrompt(shelf: "kit", id: "hello", body: "Hi.\\n") { ok } }`
    );
    const bodyOnly = await headFiles("kit");
    expect(bodyOnly["items/prompts/hello/item.json"]).toBe(written);
    await data(
      v.unknown(),
      `mutation { updatePrompt(shelf: "kit", id: "hello", title: "Greeting") { ok } }`
    );
    const titled = await headFiles("kit");
    expect(titled["items/prompts/hello/item.json"]).toBe(
      written.replace('"title": "Hello"', '"title": "Greeting"')
    );
  });

  it("pushes nothing when the files are the same", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const again = await push("kit", shelfOf("kit", false, PROMPT));
    expect(again.errors).toStrictEqual([]);
    await expect(history("kit")).resolves.toHaveLength(1);
  });

  it("keeps the files outside the shelf a Git client pushed", async () => {
    const pushed = await gitPush(
      "kit",
      { ...shelfOf("kit", false, PROMPT), "README.md": "# Kit\n" },
      null
    );
    await expect(indexed("kit")).resolves.toBeTruthy();
    await push("kit", shelfOf("kit", false, withPrompt("Edited.\n")));
    const files = await headFiles("kit");
    expect([
      files["README.md"],
      files["items/prompts/hello/prompt.md"],
    ]).toStrictEqual(["# Kit\n", "Edited.\n"]);
    const head = await headOf("kit");
    expect(head.parents).toStrictEqual([pushed.commit]);
  });

  it("makes concurrent writes one after another", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const results = await Promise.all(
      ["one\n", "two\n", "three\n"].map(
        async (text) =>
          await push("kit", shelfOf("kit", false, withPrompt(text)))
      )
    );
    expect(results.map((result) => result.errors)).toStrictEqual([[], [], []]);
    await expect(history("kit")).resolves.toHaveLength(4);
  });
});

describe("pushes through the Git route", () => {
  beforeEach(fresh);

  it("indexes a push from a Git client", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const before = await headOf("kit");
    const pushed = await gitPush(
      "kit",
      shelfOf("kit", false, withPrompt("From git.\n")),
      before.hash
    );
    expect(pushed.status).toBe(200);
    await expect(indexed("kit")).resolves.toBeTruthy();
    const shelf = await repositoryOf("kit");
    expect(shelf.snapshot).toStrictEqual({
      commit: pushed.commit,
      origin: "git",
    });
  });

  it("refuses a head the engine cannot load, and keeps the shelf where it was", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const good = await headOf("kit");
    const bad = await gitPush(
      "kit",
      { ...shelfOf("kit", false, PROMPT), "shelf.json": "{ not json" },
      good.hash
    );
    const synced = await sync("kit");
    expect(synced.status).toBe("refused");
    const shelf = await repositoryOf("kit");
    expect({
      commit: shelf.repository?.commit,
      refused: shelf.repository?.refused?.commit,
      refusedPath: shelf.repository?.refused?.errors[0]?.path,
      snapshot: shelf.snapshot?.commit,
    }).toStrictEqual({
      commit: good.hash,
      refused: bad.commit,
      refusedPath: "shelf.json",
      snapshot: good.hash,
    });
    // A write on top of the index, behind the refused head, is a conflict: the repository is the source of truth.
    const blocked = await push(
      "kit",
      shelfOf("kit", false, withPrompt("Behind the head.\n"))
    );
    expect(blocked.ok).toBeFalsy();
  });

  it("indexes a push made around the Worker the moment the next edit meets it, and makes the edit on top of it", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const before = await headOf("kit");
    // A push with an Artifacts token of the operator's own, straight to the repository: no sync is queued for it.
    const repo = await fakeArtifacts.get("kit");
    const token = await repo.createToken("write", 60);
    const shelfEngine = await engine();
    const planned = shelfEngine.gitCommit({
      author: {
        email: "ops@example.com",
        name: "Ops",
        offset: 0,
        time: 1_700_000_000,
      },
      base: [],
      files: Object.entries({
        ...shelfOf("kit", false, PROMPT),
        "README.md": "# Pushed around the Worker\n",
      }).map(([path, contents]) => ({
        contents: encoder.encode(contents),
        path,
      })),
      message: "around the Worker",
      parent: before.hash,
      ref: "refs/heads/main",
    });
    if (!planned.ok || planned.value.request === null) {
      throw new Error("nothing to push");
    }
    const { remote } = await repo.info();
    await fakeArtifacts.fetch(`${remote}/git-receive-pack`, {
      body: Uint8Array.from(planned.value.request),
      headers: { authorization: `Bearer ${token.plaintext}` },
      method: "POST",
    });

    const edited = await data(
      v.object({ updatePrompt: v.object({ ok: v.boolean() }) }),
      `mutation { updatePrompt(shelf: "kit", id: "hello", body: "After.\\n") { ok } }`
    );
    expect(edited.updatePrompt.ok).toBeTruthy();
    const head = await headOf("kit");
    expect(head.parents).toStrictEqual([planned.value.commit]);
    const files = await headFiles("kit");
    expect([
      files["README.md"],
      files["items/prompts/hello/prompt.md"],
    ]).toStrictEqual(["# Pushed around the Worker\n", "After.\n"]);
  });

  it("lets the owner create a shelf by pushing it", async () => {
    const pushed = await gitPush(
      "fresh",
      shelfOf("fresh", false, PROMPT),
      null
    );
    expect(pushed.status).toBe(200);
    await expect(indexed("fresh")).resolves.toBeTruthy();
    const shelf = await repositoryOf("fresh");
    expect(shelf.repository?.commit).toBe(pushed.commit);
  });
});

describe("access to the Git route", () => {
  beforeEach(async () => {
    await fresh();
    await push("open", shelfOf("open", true, PROMPT));
    await push("kit", shelfOf("kit", false, PROMPT));
  });

  it("lets anyone clone a public shelf, with a token that never leaves the Worker", async () => {
    const response = await advertise("open", "git-upload-pack");
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
    const relayed = fakeArtifacts.requests.at(-1);
    expect(relayed?.headers.get("authorization")).toMatch(/^Bearer art_fake_/u);
  });

  it("asks a client without a key for one", async () => {
    const privateRead = await advertise("kit", "git-upload-pack");
    expect(privateRead.status).toBe(401);
    expect(privateRead.headers.get("www-authenticate")).toContain("Basic");
    const publicPush = await advertise("open", "git-receive-pack");
    expect(publicPush.status).toBe(401);
  });

  it("decides with the shelf's keys", async () => {
    const reader = await createKey("kit", ["read"], "reader");
    const other = await createKey("open", ["read"], "other");
    const statuses = await Promise.all([
      advertise("kit", "git-upload-pack", reader.secret),
      advertise("kit", "git-receive-pack", reader.secret),
      advertise("kit", "git-upload-pack", other.secret),
      advertise("missing", "git-upload-pack", TEST_OWNER_KEY),
      advertise("kit", "git-upload-pack", "sk_not_a_key"),
    ]);
    expect(statuses.map((response) => response.status)).toStrictEqual([
      200, 403, 404, 404, 401,
    ]);
  });

  it("refuses a push from a key that may only read", async () => {
    const reader = await createKey("kit", ["read"], "reader");
    const denied = await gitPush(
      "kit",
      shelfOf("kit", false, PROMPT),
      null,
      reader.secret
    );
    expect(denied.status).toBe(403);
  });

  it("relays upload-pack with the request's Git headers and nothing else", async () => {
    const response = await exports.default.fetch(
      `${ORIGIN}/git/open.git/git-upload-pack`,
      {
        body: "0000",
        headers: {
          "content-type": "application/x-git-upload-pack-request",
          cookie: "shelfkit_session=x",
          "git-protocol": "version=2",
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const relayed = fakeArtifacts.requests.at(-1);
    expect({
      cookie: relayed?.headers.get("cookie"),
      path: relayed?.path,
      protocol: relayed?.headers.get("git-protocol"),
    }).toStrictEqual({
      cookie: null,
      path: "/git/open.git/git-upload-pack",
      protocol: "version=2",
    });
  });
});

describe("a deployment without repositories", () => {
  beforeEach(fresh);
  afterEach(() => {
    repositories.enabled = true;
  });

  it("keeps snapshots only, and has no Git route", async () => {
    repositories.enabled = false;
    await push("kit", shelfOf("kit", false, PROMPT));
    const shelf = await repositoryOf("kit");
    expect(shelf.repository).toBeNull();
    const route = await advertise("kit", "git-upload-pack", TEST_OWNER_KEY);
    expect(route.status).toBe(404);
  });

  it("commits a shelf's files once it has repositories", async () => {
    repositories.enabled = false;
    await push("kit", shelfOf("kit", false, PROMPT));
    repositories.enabled = true;
    // A sync queued by an earlier test may get there first; either way, one commit holds the shelf's files.
    const synced = await sync("kit");
    expect(["backfilled", "current"]).toContain(synced.status);
    await expect(history("kit")).resolves.toHaveLength(1);
    await expect(headFiles("kit")).resolves.toStrictEqual(
      shelfOf("kit", false, PROMPT)
    );
    const head = await headOf("kit");
    await expect(repositoryOf("kit")).resolves.toMatchObject({
      repository: { commit: head.hash },
      snapshot: { commit: head.hash },
    });
  });
});

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

describe("errors from the Artifacts binding", () => {
  it("are read through `wrangler dev`'s remote proxy too, which drops their code", async () => {
    const proxied: Artifacts = {
      ...fakeArtifacts,
      get: async (name) => {
        await Promise.resolve();
        throw new Error(`ArtifactsError: Repository not found: ${name}.`);
      },
    };
    const repository = new ArtifactsRepository(proxied, fakeArtifacts.fetch);
    await expect(repository.head("nowhere")).resolves.toBeNull();
  });
});
