/**
 * Each shelf's Git repository (`src/repository/`, `src/git.ts`): every write the Worker makes becomes a commit, a push
 * through `/git/{shelf}.git` is indexed afterwards, a head the engine refuses leaves the index where it was, and the
 * Git route decides access with the same keys as every other surface. Artifacts is Miniflare's local simulator, behind
 * the real adapter.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../src/auth/index.ts";
import { engine } from "../src/engine.ts";
import { ArtifactsRepository } from "../src/repository/artifacts.ts";
import {
  basic,
  createKey,
  data,
  ORIGIN,
  push,
  pushToRemote,
  shelfOf,
  TEST_OWNER_KEY,
  withArtifactsRepo,
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
 * Index the repository's head. The Git route has already indexed a push through it, and an edit may have too, so
 * either answer means the head is indexed.
 */
async function indexed(shelf: string): Promise<boolean> {
  const synced = await sync(shelf);
  return synced.status === "indexed" || synced.status === "current";
}

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

/** The commits of a repository's `main`, newest first. */
async function history(shelf: string): Promise<ArtifactsCommitMetadata[]> {
  return await withArtifactsRepo(
    shelf,
    async (repo) => await repo.log({ ref: "main" })
  );
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
  const files = await withArtifactsRepo(
    shelf,
    async (repo) => await filesUnder(repo, head.treeHash, "")
  );
  return Object.fromEntries(files.toSorted(([a], [b]) => a.localeCompare(b)));
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

const UpdatedSchema = v.object({ updatePrompt: v.object({ ok: v.boolean() }) });

/** Edit the prompt's body in the UI, as the owner. */
async function editPrompt(shelf: string, body: string): Promise<boolean> {
  const updated = await data(
    UpdatedSchema,
    'mutation Edit($shelf: ID!, $body: String!) { updatePrompt(shelf: $shelf, id: "hello", body: $body) { ok } }',
    { body, shelf }
  );
  return updated.updatePrompt.ok;
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
      snapshot: { commit: second.hash, origin: "git" },
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

  it("restores a version byte for byte, title and all, as that revision again", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    await data(
      v.unknown(),
      `mutation { updatePrompt(shelf: "kit", id: "hello", title: "Greeting") { ok } }`
    );
    const Revisions = v.object({
      shelf: v.object({
        item: v.object({
          revision: v.string(),
          revisions: v.array(v.object({ revision: v.string() })),
        }),
      }),
    });
    const query =
      '{ shelf(id: "kit") { item(id: "hello") { revision revisions { revision } } } }';
    const before = await data(Revisions, query);
    const first = before.shelf.item.revisions.at(-1)?.revision ?? "";
    const restored = await data(
      v.object({ restoreItem: v.object({ ok: v.boolean() }) }),
      `mutation R($revision: String!) { restoreItem(shelf: "kit", id: "hello", revision: $revision) { ok } }`,
      { revision: first }
    );
    expect(restored.restoreItem.ok).toBeTruthy();
    const files = await headFiles("kit");
    expect(files["items/prompts/hello/item.json"]).toBe(
      PROMPT["items/prompts/hello/item.json"]
    );
    const after = await data(Revisions, query);
    expect({
      count: after.shelf.item.revisions.length,
      current: after.shelf.item.revision,
    }).toStrictEqual({ count: 2, current: first });
  });

  it("changes only the member of shelf.json that changed when the shelf turns public", async () => {
    const written = `{
  "registry": { "namespace": "kit", "public": false },
  "name": "kit"
}
`;
    await push("kit", { ...PROMPT, "shelf.json": written });
    await data(
      v.unknown(),
      'mutation { setVisibility(shelf: "kit", public: true) { ok } }'
    );
    const files = await headFiles("kit");
    expect(files["shelf.json"]).toBe(
      written.replace('"public": false', '"public": true')
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
    await expect(editPrompt("kit", "Edited.\n")).resolves.toBeTruthy();
    const files = await headFiles("kit");
    expect([
      files["README.md"],
      files["items/prompts/hello/prompt.md"],
    ]).toStrictEqual(["# Kit\n", "Edited.\n"]);
    const head = await headOf("kit");
    expect(head.parents).toStrictEqual([pushed.commit]);
  });

  it("makes concurrent writes one after another: each a commit, or a conflict, and none lost", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const results = await Promise.all(
      ["one\n", "two\n", "three\n"].map(
        async (text) => await editPrompt("kit", text)
      )
    );
    const committed = results.filter(Boolean).length;
    expect(committed).toBeGreaterThan(0);
    await expect(history("kit")).resolves.toHaveLength(1 + committed);
    const head = await headOf("kit");
    await expect(repositoryOf("kit")).resolves.toMatchObject({
      repository: { commit: head.hash },
      snapshot: { commit: head.hash },
    });
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

  it("indexes a push before answering it, with no queue consumer, as in a Worker Preview", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const before = await headOf("kit");
    const pushed = await gitPush(
      "kit",
      shelfOf("kit", false, withPrompt("From git, unqueued.\n")),
      before.hash
    );
    expect(pushed.status).toBe(200);
    // Nothing here syncs and the tests run no queue consumer: only the route can have indexed the push.
    const shelf = await repositoryOf("kit");
    expect(shelf?.snapshot).toStrictEqual({
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
    await expect(editPrompt("kit", "Behind the head.\n")).resolves.toBeFalsy();
  });

  it("indexes a push made around the Worker the moment the next edit meets it, and makes the edit on top of it", async () => {
    await push("kit", shelfOf("kit", false, PROMPT));
    const before = await headOf("kit");
    // A push with an Artifacts token of the operator's own, straight to the repository: no sync is queued for it.
    const { remote, token } = await withArtifactsRepo("kit", async (repo) => {
      const [info, minted] = await Promise.all([
        repo.info(),
        repo.createToken("write", 60),
      ]);
      return { remote: info.remote, token: minted.plaintext };
    });
    const around = await pushToRemote(
      remote,
      token,
      {
        ...shelfOf("kit", false, PROMPT),
        "README.md": "# Pushed around the Worker\n",
      },
      before.hash
    );

    const edited = await data(
      v.object({ updatePrompt: v.object({ ok: v.boolean() }) }),
      `mutation { updatePrompt(shelf: "kit", id: "hello", body: "After.\\n") { ok } }`
    );
    expect(edited.updatePrompt.ok).toBeTruthy();
    const head = await headOf("kit");
    expect(head.parents).toStrictEqual([around]);
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

  it("lets anyone clone a public shelf, with a token the Worker mints and keeps", async () => {
    const response = await advertise("open", "git-upload-pack");
    expect(response.status).toBe(200);
    const head = await headOf("open");
    const advertised = new TextDecoder().decode(await response.arrayBuffer());
    expect(advertised).toContain(`${head.hash} refs/heads/main`);
    // The repository itself refuses the same request without the Worker's token.
    const { remote } = await withArtifactsRepo(
      "open",
      async (repo) => await repo.info()
    );
    const direct = await fetch(`${remote}/info/refs?service=git-upload-pack`);
    await direct.arrayBuffer();
    expect(direct.status).toBe(401);
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

  it("relays the protocol version a Git client asks for", async () => {
    const response = await exports.default.fetch(
      `${ORIGIN}/git/open.git/info/refs?service=git-upload-pack`,
      {
        headers: {
          cookie: "shelfkit_session=x",
          "git-protocol": "version=2",
        },
      }
    );
    expect(response.status).toBe(200);
    // Protocol v2 answers with its capabilities, and lists no reference until a client asks.
    const answer = new TextDecoder().decode(await response.arrayBuffer());
    expect(answer).toContain("version 2");
    expect(answer).not.toContain("refs/heads/main");
  });
});

/** A binding method the test's stand-in does not answer, since `head` never calls it. */
async function unused(): Promise<never> {
  await Promise.resolve();
  throw new Error("not called by `head`");
}

describe("errors from the Artifacts binding", () => {
  it("are read through `wrangler dev`'s remote proxy too, which drops their code", async () => {
    // The binding as `wrangler dev` relays a deployed namespace: an `ArtifactsError` arrives as a plain `Error` whose
    // message names it. The simulator throws the real error, so this stand-in answers `get` the proxy's way.
    const proxied: Artifacts = {
      create: unused,
      delete: unused,
      get: async (name) => {
        await Promise.resolve();
        throw new Error(`ArtifactsError: Repository not found: ${name}.`);
      },
      import: unused,
      list: unused,
    };
    const repository = new ArtifactsRepository(proxied, fetch);
    await expect(repository.head("nowhere")).resolves.toBeNull();
  });

  it("are read from the simulator as they are deployed", async () => {
    const repository = new ArtifactsRepository(env.ARTIFACTS, fetch);
    await expect(repository.head("nowhere")).resolves.toBeNull();
    await expect(repository.references("nowhere")).resolves.toBeNull();
  });
});
