import {
  shelfCompilePlan,
  shelfItemGet,
  shelfProfileGet,
  shelfRecommend,
  shelfReport,
  shelfSearch,
} from "@shelfkit/schema";
/**
 * The shelf's object: a pushed shelf indexed as metadata, the six MCP capabilities answering in their frozen shapes, and
 * the GraphQL surface the UI builds on.
 */
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, inject, it } from "vitest";

import type { Session } from "../src/auth/index.ts";
import { SCHEMA_VERSION } from "../src/db/migrate.ts";
import type { ShelfIndex } from "../src/shelf-index.ts";
import {
  createKey,
  data,
  fixtureShelf,
  graphql,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

const owner: Session = { keyId: "owner", kind: "owner" };
const anonymous: Session = { kind: "anonymous" };

function stub(shelf = "kit") {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}

/** Start every test from the all-kinds fixture, pushed as `kit`. */
async function pushFixture(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
  const pushed = await push(
    "kit",
    fixtureShelf(inject("allKindsShelf"), "kit")
  );
  expect(pushed.errors).toStrictEqual([]);
}

/** A scoped key of `kit`, as a session. */
function asKey(id: string, scopes: string[]): Session {
  return {
    keyId: id,
    kind: "key",
    name: "x",
    scopes,
    shelf: "kit",
  };
}

describe("a push", () => {
  beforeEach(pushFixture);

  it("indexes every item and profile, and records the schema version", async () => {
    const summary = await stub().summary(owner, "kit");
    if (!summary.ok) {
      throw new Error(summary.failure.message);
    }
    expect(summary.value.itemCount).toBe(13);
    expect(summary.value.profileCount).toBe(3);
    expect(summary.value.snapshot?.origin).toBe("push");
    const version = await runInDurableObject(
      stub(),
      (_instance: ShelfIndex, state) =>
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM meta WHERE key = 'schema_version'"
          )
          .one().value
    );
    expect(Number(version)).toBe(SCHEMA_VERSION);
  });

  it("of a shelf that does not load is refused with every error in its file", async () => {
    const pushed = await push(
      "kit",
      shelfOf("kit", false, { "profiles/broken.json": "{" })
    );
    expect(pushed.ok).toBeFalsy();
    expect(pushed.errors.map((error) => error.path)).toContain(
      "profiles/broken.json"
    );
    const summary = await stub().summary(owner, "kit");
    expect(summary.ok && summary.value.itemCount).toBe(13);
  });

  it("whose namespace is another shelf's is refused", async () => {
    const pushed = await push("kit", shelfOf("elsewhere", false));
    expect(pushed.errors[0]?.message).toContain("`elsewhere`");
  });

  it("that names an object never uploaded is refused, asking for it", async () => {
    const answer = await graphql(
      `mutation { commitSnapshot(shelf: "kit", files: [{ path: "shelf.json", sha256: "${"a".repeat(64)}", size: 1 }]) { ok reason missing } }`,
      {}
    );
    expect(answer.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    const missing = await stub().commitSnapshot(owner, {
      files: [{ path: "shelf.json", sha256: "a".repeat(64), size: 1 }],
      shelf: "kit",
    });
    expect(missing).toMatchObject({
      missing: ["a".repeat(64)],
      ok: false,
      reason: "missing",
    });
  });

  it("creates a shelf only with the owner key", async () => {
    const key = await createKey("kit", ["read", "publish:kit/*"]);
    const refused = await exports.default.fetch(
      `${ORIGIN}/raw/fresh/objects/${"0".repeat(64)}`,
      {
        body: "x",
        headers: { authorization: `Bearer ${key.secret}` },
        method: "PUT",
      }
    );
    expect(refused.status).toBe(403);
  });
});

describe("the MCP capabilities, as object methods", () => {
  beforeEach(pushFixture);

  it("search over bodies, in shelf.search's output shape", async () => {
    const found = await stub().search(anonymous, "kit", {
      query: "staged diff",
    });
    expect(found.ok).toBeFalsy();
    const searched = await stub().search(owner, "kit", { query: "Audience" });
    if (!searched.ok) {
      throw new Error(searched.failure.message);
    }
    const output = v.parse(shelfSearch.output, searched.value);
    expect(output.items.map((hit) => hit.item.id)).toStrictEqual([
      "pr-description",
    ]);
    expect(output.items[0]?.snippet).toContain("Audience");
    const byKind = await stub().search(owner, "kit", {
      kinds: ["mcp"],
      query: "linear",
    });
    expect(
      byKind.ok && byKind.value.items.map((hit) => hit.item.id)
    ).toStrictEqual(["linear"]);
  });

  it("recommend and profile answer in their frozen shapes", async () => {
    const recommended = await stub().recommend(owner, "kit", {
      dependencies: ["vue"],
      files: ["wrangler.jsonc"],
      packageManager: "pnpm@11.8.0",
    });
    if (!recommended.ok) {
      throw new Error(recommended.failure.message);
    }
    expect(
      v
        .parse(shelfRecommend.output, recommended.value)
        .items.map((entry) => entry.item.id)
    ).toContain("vue-cloudflare");

    const profile = await stub().getProfile(owner, "kit", "minimal");
    expect(
      profile.ok &&
        v.parse(shelfProfileGet.output, profile.value).resolution.items[0]?.id
    ).toBe("pr-description");
    const missing = await stub().getProfile(owner, "kit", "nope");
    expect(missing.ok ? null : missing.failure._tag).toBe("ProfileNotFound");
  });

  it("item and plan answer in their frozen shapes", async () => {
    const item = await stub().getItem(owner, "kit", "pr-description");
    if (!item.ok) {
      throw new Error(item.failure.message);
    }
    const parsed = v.parse(shelfItemGet.output, item.value);
    expect(parsed.files.map((file) => file.path)).toStrictEqual([
      "item.json",
      "prompt.md",
    ]);
    const pinned = await stub().getItem(
      owner,
      "kit",
      `pr-description@sha256-${"0".repeat(64)}`
    );
    expect(pinned.ok ? null : pinned.failure._tag).toBe("RevisionNotFound");

    const plan = await stub().planCompile(owner, "kit", "minimal");
    if (!plan.ok) {
      throw new Error(plan.failure.message);
    }
    expect(v.parse(shelfCompilePlan.output, plan.value).apmYml).toContain(
      "name: minimal"
    );
  });

  it("plan changes nothing and answers the same twice", async () => {
    const before = await stub().summary(owner, "kit");
    const first = await stub().planCompile(owner, "kit", "full");
    const second = await stub().planCompile(owner, "kit", "full");
    const after = await stub().summary(owner, "kit");
    expect(second).toStrictEqual(first);
    expect(after.ok && after.value.snapshot).toStrictEqual(
      before.ok && before.value.snapshot
    );
  });

  it("report writes an activity record, needs a key that can write the profile, and says when it is stale", async () => {
    const plan = await stub().planCompile(owner, "kit", "minimal");
    if (!plan.ok) {
      throw new Error(plan.failure.message);
    }
    const input = {
      apmYmlDigest: plan.value.apmYmlDigest,
      outcome: "installed" as const,
      profile: "minimal",
      profileRevision: plan.value.profileRevision,
      repository: "github.com/acme/web",
    };
    const reader = await createKey("kit", ["read"]);
    const refused = await stub().report(
      {
        keyId: reader.id,
        kind: "key",
        name: "reader",
        scopes: ["read"],
        shelf: "kit",
      },
      "kit",
      input
    );
    expect(refused.ok ? null : refused.failure._tag).toBe("Forbidden");
    const reported = await stub().report(owner, "kit", input);
    expect(
      reported.ok && v.parse(shelfReport.output, reported.value).stale
    ).toBeFalsy();
    const old = await stub().report(owner, "kit", {
      ...input,
      profileRevision: `sha256-${"1".repeat(64)}`,
    });
    expect(old.ok && old.value.stale).toBeTruthy();
    const activity = await stub().activity(owner, "kit", {});
    expect(activity?.map((entry) => entry.stale)).toStrictEqual([true, false]);
  });

  it("hide a private shelf from a key of another shelf", async () => {
    await push("other", shelfOf("other", false));
    const outsider = await createKey("other", ["read"]);
    const session: Session = {
      keyId: outsider.id,
      kind: "key",
      name: "x",
      scopes: ["read"],
      shelf: "other",
    };
    const found = await stub().search(session, "kit", { query: "Audience" });
    expect(found.ok ? null : found.failure._tag).toBe("ShelfNotFound");
  });

  it("list only the hosted MCP items a key was granted, and the secret names only to a reader", async () => {
    await stub().putSecretName(
      owner,
      "kit",
      "LINEAR_API_KEY",
      "https://mcp.linear.app"
    );
    const granted = await createKey("kit", ["mcp:kit/linear"]);
    const plain = await createKey("kit", ["read"]);
    const relay = await stub().relayable(
      asKey(granted.id, ["mcp:kit/linear"]),
      "kit"
    );
    expect(relay?.servers.map((server) => server.id)).toStrictEqual(["linear"]);
    expect(relay?.secretNames).toStrictEqual([]);
    const none = await stub().relayable(asKey(plain.id, ["read"]), "kit");
    expect(none?.servers).toStrictEqual([]);
    expect(none?.secretNames).toStrictEqual(["LINEAR_API_KEY"]);
  });
});

const PromptSchema = v.object({
  shelf: v.object({
    item: v.object({
      body: v.nullable(v.string()),
      revision: v.string(),
      revisions: v.array(v.object({ revision: v.string() })),
      variables: v.unknown(),
    }),
  }),
});

/** Replace `pr-description`'s body, as the prompt editor does. */
async function editPrompt() {
  return await data(
    v.object({
      updatePrompt: v.object({
        errors: v.array(v.unknown()),
        ok: v.boolean(),
      }),
    }),
    `mutation { updatePrompt(shelf: "kit", id: "pr-description", body: "Describe the change for {{audience}}.\\n") { ok errors { path message } } }`
  );
}

const PROMPT = `query Prompt($id: ID!) { shelf(id: "kit") { item(id: $id) { revision body variables revisions { revision } } } }`;

describe("the GraphQL API", () => {
  beforeEach(pushFixture);

  it("edits a prompt in place as a new revision", async () => {
    const before = await data(PromptSchema, PROMPT, { id: "pr-description" });
    const edited = await editPrompt();
    expect(edited.updatePrompt).toStrictEqual({ errors: [], ok: true });
    const after = await data(PromptSchema, PROMPT, { id: "pr-description" });
    expect(after.shelf.item.body).toBe(
      "Describe the change for {{audience}}.\n"
    );
    expect(after.shelf.item.revision).not.toBe(before.shelf.item.revision);
    expect(after.shelf.item.revisions.map((row) => row.revision)).toStrictEqual(
      [after.shelf.item.revision, before.shelf.item.revision]
    );
  });

  it("keeps a prompt's old revision readable, and searches only the new one", async () => {
    const before = await data(PromptSchema, PROMPT, { id: "pr-description" });
    await editPrompt();
    const old = await stub().getItem(
      owner,
      "kit",
      `pr-description@${before.shelf.item.revision}`
    );
    expect(
      old.ok &&
        old.value.files.find((file) => file.path === "prompt.md")?.contents
    ).toContain("staged diff");
    const searched = await stub().search(owner, "kit", { query: "Ticket" });
    expect(searched.ok && searched.value.items).toStrictEqual([]);
  });

  it("keeps favourites and recents per key", async () => {
    const one = await createKey("kit", ["read"], "one");
    const two = await createKey("kit", ["read"], "two");
    await data(
      v.unknown(),
      `mutation { setFavourite(shelf: "kit", item: "pr-description", favourite: true) }`,
      {},
      one.secret
    );
    await data(
      v.unknown(),
      `mutation { recordUse(shelf: "kit", item: "linear") }`,
      {},
      one.secret
    );
    const Personal = v.object({
      shelf: v.object({
        favourites: v.array(v.object({ id: v.string() })),
        recents: v.array(
          v.object({ item: v.object({ id: v.string() }), uses: v.number() })
        ),
      }),
    });
    const query = `{ shelf(id: "kit") { favourites { id } recents { uses item { id } } } }`;
    const mine = await data(Personal, query, {}, one.secret);
    expect(mine.shelf.favourites.map((item) => item.id)).toStrictEqual([
      "pr-description",
    ]);
    expect(mine.shelf.recents).toStrictEqual([
      { item: { id: "linear" }, uses: 1 },
    ]);
    const theirs = await data(Personal, query, {}, two.secret);
    expect(theirs.shelf).toStrictEqual({ favourites: [], recents: [] });
  });

  it("previews an unsaved profile, then saves it", async () => {
    const document = {
      bundles: [],
      compile: {},
      extends: [],
      id: "draft",
      items: ["pr-description", "drizzle"],
      title: "Draft",
    };
    const Preview = v.object({
      shelf: v.object({
        previewProfile: v.object({
          conflicts: v.array(v.object({ severity: v.string() })),
          plan: v.nullable(v.object({ apmYml: v.string() })),
          resolution: v.nullable(
            v.object({ unpinned: v.array(v.object({ id: v.string() })) })
          ),
        }),
      }),
    });
    const preview = await data(
      Preview,
      `query P($document: JSON!) { shelf(id: "kit") { previewProfile(document: $document) { conflicts { severity } plan { apmYml } resolution { unpinned { id } } } } }`,
      { document }
    );
    expect(preview.shelf.previewProfile.plan?.apmYml).toContain("name: draft");
    expect(
      preview.shelf.previewProfile.resolution?.unpinned.map((item) => item.id)
    ).toStrictEqual(["drizzle", "pr-description"]);
    const before = await stub().getProfile(owner, "kit", "draft");
    expect(before.ok).toBeFalsy();
    await data(
      v.unknown(),
      `mutation S($document: JSON!) { saveProfile(shelf: "kit", document: $document) { ok } }`,
      { document }
    );
    const saved = await stub().getProfile(owner, "kit", "draft");
    expect(saved.ok && saved.value.profile.items).toStrictEqual([
      "pr-description",
      "drizzle",
    ]);
  });

  it("reports conflicts by severity", async () => {
    const Full = v.object({
      shelf: v.object({
        profile: v.object({
          resolution: v.object({
            conflicts: v.array(
              v.object({ code: v.string(), severity: v.string() })
            ),
          }),
        }),
      }),
    });
    const full = await data(
      Full,
      `{ shelf(id: "kit") { profile(id: "full") { resolution { conflicts { code severity } } } } }`
    );
    const severities = full.shelf.profile.resolution.conflicts.map(
      (conflict) => conflict.severity
    );
    expect(severities).toStrictEqual(
      severities.toSorted(
        (a, b) =>
          ["error", "warning", "info"].indexOf(a) -
          ["error", "warning", "info"].indexOf(b)
      )
    );
    expect(
      full.shelf.profile.resolution.conflicts.map((conflict) => conflict.code)
    ).toContain("producer-nonconformant-target");
  });

  it("tests stack markers from a sample package.json", async () => {
    const Match = v.object({
      shelf: v.object({
        stackMatch: v.object({ stacks: v.array(v.string()) }),
      }),
    });
    const found = await data(
      Match,
      `query M($json: String!) { shelf(id: "kit") { stackMatch(packageJson: $json) { stacks } } }`,
      {
        json: JSON.stringify({
          dependencies: { vue: "3" },
          packageManager: "pnpm@11.8.0",
        }),
      }
    );
    expect(found.shelf.stackMatch.stacks).toStrictEqual(["vue-cloudflare"]);
  });

  it("serves a share link's profile with no key, until it is revoked", async () => {
    const Created = v.object({
      createShareLink: v.object({
        link: v.object({ id: v.string() }),
        token: v.string(),
      }),
    });
    const created = await data(
      Created,
      `mutation { createShareLink(shelf: "kit", profile: "minimal") { token link { id } } }`
    );
    const Shared = v.object({
      sharedProfile: v.nullable(
        v.object({
          plan: v.nullable(v.object({ apmYml: v.string() })),
          title: v.string(),
        })
      ),
    });
    const query = `query S($token: String!) { sharedProfile(token: $token) { title plan { apmYml } } }`;
    const before = await graphql(query, {
      token: created.createShareLink.token,
    });
    const shared = v.parse(Shared, before.data);
    expect(shared.sharedProfile?.title).toBe("Minimal");
    expect(shared.sharedProfile?.plan?.apmYml).toContain("name: minimal");
    await data(
      v.unknown(),
      `mutation R($id: ID!) { revokeShareLink(shelf: "kit", id: $id) }`,
      { id: created.createShareLink.link.id }
    );
    const after = await graphql(query, {
      token: created.createShareLink.token,
    });
    const gone = v.parse(Shared, after.data);
    expect(gone.sharedProfile).toBeNull();
  });

  it("serves a public shelf's inventory anonymously, and nothing private", async () => {
    await data(
      v.unknown(),
      `mutation { setVisibility(shelf: "kit", public: true) { ok } }`
    );
    const Inventory = v.object({
      shelf: v.object({
        activity: v.array(v.unknown()),
        items: v.object({ total: v.number() }),
      }),
    });
    const answer = await graphql(`
      {
        shelf(id: "kit") {
          items {
            total
          }
          activity {
            id
          }
        }
      }
    `);
    const found = v.parse(Inventory, answer.data);
    expect(found.shelf).toStrictEqual({ activity: [], items: { total: 13 } });
  });

  it("starts an import job, which fails plainly while there is no importer for the source", async () => {
    const Started = v.object({
      startImport: v.object({ id: v.string(), status: v.string() }),
    });
    const started = await data(
      Started,
      `mutation { startImport(shelf: "kit", source: { kind: "git", repo: "https://github.com/acme/skills" }) { id status } }`
    );
    expect(started.startImport.status).toBe("queued");
  });

  it("streams the shelf's changes to a subscriber", async () => {
    const stream = await stub().events(owner, "kit");
    if (stream === null) {
      throw new Error("no stream");
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    await stub().setFavourite(owner, "kit", "linear", true);
    await stub().putSecretName(owner, "kit", "TOKEN", "https://mcp.linear.app");
    const { value } = await reader.read();
    expect(decoder.decode(value)).toContain('"kind":"settings"');
    await reader.cancel();
  });
});

describe("GraphQL subscriptions", () => {
  beforeEach(pushFixture);

  it("deliver the shelf object's changes over server-sent events", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: JSON.stringify({
        query: `subscription { shelfChanged(shelf: "kit") { kind id } }`,
      }),
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${TEST_OWNER_KEY}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("no body");
    }
    const decoder = new TextDecoder();
    const received: string[] = [];
    // The subscription is open once the object has a subscriber; then a change arrives as an event.
    await stub().putSecretName(owner, "kit", "FIRST", "https://mcp.linear.app");
    for (
      let attempt = 0;
      attempt < 20 && !received.join("").includes("shelfChanged");
      attempt += 1
    ) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- events arrive one read at a time.
      const read: { readonly value?: unknown } = await reader.read();
      received.push(
        decoder.decode(v.parse(v.instance(Uint8Array), read.value))
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- each change is made after the stream is read.
      await stub().putSecretName(
        owner,
        "kit",
        `SECOND_${attempt}`,
        "https://mcp.linear.app"
      );
    }
    await reader.cancel();
    expect(received.join("")).toContain('"kind":"settings"');
  });

  it("list every bundle as its file holds it", async () => {
    const found = await data(
      v.object({
        shelf: v.object({ bundles: v.array(v.object({ id: v.string() })) }),
      }),
      `{ shelf(id: "kit") { bundles } }`
    );
    expect(found.shelf.bundles.map((bundle) => bundle.id)).toStrictEqual([
      "code-quality",
    ]);
  });
});
