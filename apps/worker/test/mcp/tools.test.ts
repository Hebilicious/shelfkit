/**
 * ShelfKit's own tools at `/mcp`: the AcidCat contract, the tool list computed from the key, the six capabilities
 * end to end, and the acceptance criteria of issue #6 that do not involve the relay.
 */
import { renderCatalog } from "@acid-cat/core-ts";
import { capabilities } from "@shelfkit/schema";
import { toCatalogJsonSchema } from "@shelfkit/schema/json-schema";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, inject, it } from "vitest";

import committedCatalog from "../../../../packages/schema/acidcat.catalog.json";
import type { Session } from "../../src/auth/index.ts";
import { shelfApp } from "../../src/mcp/app.ts";
import type { JsonObject } from "../../src/mcp/wire.ts";
import {
  createKey,
  data,
  fixtureShelf,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "../helpers.ts";
import {
  call,
  errorCode,
  failure,
  mcpHeaders,
  rpc,
  textOf,
  toolNames,
  tools,
  value,
} from "./client.ts";

const owner: Session = { keyId: "owner", kind: "owner" };
const SHELF_TOOLS = capabilities.map((capability) => capability.id);
const READING_TOOLS = SHELF_TOOLS.filter((id) => id !== "shelf.report");

function stub(shelf = "kit") {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}

/** Start from the all-kinds fixture, pushed as the private shelf `kit`. */
async function pushFixture(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
  const pushed = await push(
    "kit",
    fixtureShelf(inject("allKindsShelf"), "kit")
  );
  if (pushed.errors.length > 0) {
    throw new Error(
      `the fixture did not push: ${JSON.stringify(pushed.errors)}`
    );
  }
}

/** POST a `tools/list` to `/mcp` with these headers instead of a client's, or send a `GET`. */
async function statusOf(
  headers: Record<string, string>,
  method = "POST"
): Promise<number> {
  const response = await exports.default.fetch(`${ORIGIN}/mcp`, {
    body:
      method === "POST"
        ? JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/list",
            params: {},
          })
        : null,
    headers: { "content-type": "application/json", ...headers },
    method,
  });
  await response.arrayBuffer();
  return response.status;
}

/** What a read must not change: the snapshot, every profile's revision, and the activity. */
async function objectState() {
  const summary = await stub().summary(owner, "kit");
  const profiles = await stub().profiles(owner, "kit");
  const activity = await stub().activity(owner, "kit", {});
  return {
    activity,
    profiles,
    snapshot: summary.ok ? summary.value.snapshot : null,
  };
}

const PlanDigestsSchema = v.object({
  apmYmlDigest: v.string(),
  profileRevision: v.string(),
});

function reportInput(
  plan: v.InferOutput<typeof PlanDigestsSchema>,
  profile: string
): JsonObject {
  return {
    apmYmlDigest: plan.apmYmlDigest,
    outcome: "applied",
    profile,
    profileRevision: plan.profileRevision,
    repository: "github.com/acme/web",
    shelf: "kit",
  };
}

/** A valid input for each tool on `shelf`, reporting on the profile `minimal` with the plan's digests. */
function usableInput(
  name: string,
  shelf: string,
  plan: v.InferOutput<typeof PlanDigestsSchema>
): JsonObject {
  const inputs = new Map<string, JsonObject>([
    ["shelf.compile.plan", { profile: "minimal", shelf }],
    ["shelf.item.get", { item: "playwright", shelf }],
    ["shelf.profile.get", { profile: "minimal", shelf }],
    ["shelf.recommend", { markers: { files: ["package.json"] }, shelf }],
    ["shelf.report", { ...reportInput(plan, "minimal"), shelf }],
    ["shelf.search", { kinds: ["mcp"], shelf }],
  ]);
  return inputs.get(name) ?? { shelf };
}

describe("the AcidCat contract", () => {
  it("is the committed catalog: the served application renders packages/schema/acidcat.catalog.json", () => {
    const served: unknown = JSON.parse(
      renderCatalog(shelfApp, { toJsonSchema: toCatalogJsonSchema })
    );
    expect(served).toStrictEqual(committedCatalog);
  });

  it("names each tool by its capability id, none of which can take the relayed form", () => {
    expect(
      shelfApp.capabilities.map((capability) => capability.id)
    ).toStrictEqual(SHELF_TOOLS);
    expect(SHELF_TOOLS.filter((id) => id.includes("_"))).toStrictEqual([]);
  });
});

describe("/mcp", () => {
  beforeEach(pushFixture);

  it("discovers the server statelessly, with the catalog's description as instructions", async () => {
    const reply = await rpc("server/discover");
    expect(reply.status).toBe(200);
    expect(reply.result).toMatchObject({
      capabilities: { tools: { listChanged: false } },
      instructions: committedCatalog.description,
      supportedVersions: ["2026-07-28"],
    });
    expect(reply.headers.get("mcp-session-id")).toBeNull();
  });

  it("rejects what the binding rejects: no protocol header, another revision, GET, another origin", async () => {
    const statuses = {
      anotherOrigin: await statusOf({
        "mcp-protocol-version": "2026-07-28",
        origin: "https://evil.example",
      }),
      anotherRevision: await statusOf({ "mcp-protocol-version": "2025-06-18" }),
      get: await statusOf({}, "GET"),
      noRevision: await statusOf({}),
    };
    expect(statuses).toStrictEqual({
      anotherOrigin: 403,
      anotherRevision: 400,
      get: 405,
      noRevision: 400,
    });
  });

  it("lists each key exactly the tools it can use: every listed tool answers, none with ShelfNotFound or Forbidden", async () => {
    await push("open", fixtureShelf(inject("allKindsShelf"), "open", true));
    const plan = await value(
      PlanDigestsSchema,
      "shelf.compile.plan",
      { profile: "minimal", shelf: "kit" },
      TEST_OWNER_KEY
    );
    const keys = {
      publisher: await createKey("kit", ["publish:kit/minimal"]),
      reader: await createKey("kit", ["read"]),
      registryOnly: await createKey("kit", ["read:kit/minimal"]),
      relayOnly: await createKey("kit", ["mcp:kit/linear"]),
      writer: await createKey("kit", ["publish:kit/*"]),
    };
    const callers = [
      ["anonymous", undefined, "open"],
      ["owner", TEST_OWNER_KEY, "kit"],
      ...Object.entries(keys).map(
        ([name, key]) => [name, key.secret, "kit"] as const
      ),
    ] as const;
    const answers = await Promise.all(
      callers.map(async ([caller, key, shelf]) => {
        const listed = await toolNames(key);
        const outcomes = await Promise.all(
          listed.map(async (name) => {
            const { result } = await call(
              name,
              usableInput(name, shelf, plan),
              key
            );
            return result?.isError === true && result !== undefined
              ? `${name}: ${JSON.stringify(textOf(result))}`
              : null;
          })
        );
        return [
          caller,
          { failed: outcomes.filter((found) => found !== null), listed },
        ] as const;
      })
    );
    expect(Object.fromEntries(answers)).toStrictEqual({
      anonymous: { failed: [], listed: READING_TOOLS },
      owner: { failed: [], listed: SHELF_TOOLS },
      publisher: { failed: [], listed: ["shelf.report"] },
      reader: { failed: [], listed: READING_TOOLS },
      registryOnly: { failed: [], listed: [] },
      relayOnly: { failed: [], listed: [] },
      writer: { failed: [], listed: SHELF_TOOLS },
    });
  });

  it("answers a tool the key does not list as an unknown tool, not as a refusal that confirms it", async () => {
    const relayOnly = await createKey("kit", ["mcp:kit/linear"]);
    const reader = await createKey("kit", ["read"]);
    await expect(
      errorCode("shelf.search", { query: "x", shelf: "kit" }, relayOnly.secret)
    ).resolves.toBe(-32_602);
    await expect(errorCode("shelf.report", {}, reader.secret)).resolves.toBe(
      -32_602
    );
  });

  it("gives each tool its schema and read-only hint from the catalog", async () => {
    const listed = await tools(TEST_OWNER_KEY);
    const search = listed.find((tool) => tool.name === "shelf.search");
    const report = listed.find((tool) => tool.name === "shelf.report");
    expect(search?.annotations).toStrictEqual({ readOnlyHint: true });
    expect(search?.inputSchema).toMatchObject({
      required: ["shelf"],
      type: "object",
    });
    expect(report?.annotations).toStrictEqual({ readOnlyHint: false });
  });

  it("serves the reading capabilities from the shelf's object", async () => {
    const found = await value(
      v.object({
        items: v.array(v.object({ item: v.object({ id: v.string() }) })),
      }),
      "shelf.search",
      { query: "Playwright", shelf: "kit" },
      TEST_OWNER_KEY
    );
    const recommended = await value(
      v.object({ items: v.array(v.unknown()), profiles: v.array(v.unknown()) }),
      "shelf.recommend",
      { markers: { files: ["package.json"] }, shelf: "kit" },
      TEST_OWNER_KEY
    );
    const profile = await value(
      v.object({ profile: v.object({ id: v.string() }) }),
      "shelf.profile.get",
      { profile: "full", shelf: "kit" },
      TEST_OWNER_KEY
    );
    const item = await value(
      v.object({ item: v.object({ id: v.string() }), revision: v.string() }),
      "shelf.item.get",
      { item: "playwright", shelf: "kit" },
      TEST_OWNER_KEY
    );
    expect(found.items.map((entry) => entry.item.id)).toContain("playwright");
    expect(recommended.items).toBeInstanceOf(Array);
    expect(profile.profile.id).toBe("full");
    expect(item.item.id).toBe("playwright");
  });

  it("plans a compile and records a report of it, which writes the activity record", async () => {
    const plan = await value(
      v.object({ ...PlanDigestsSchema.entries, profile: v.string() }),
      "shelf.compile.plan",
      { profile: "minimal", shelf: "kit" },
      TEST_OWNER_KEY
    );
    const reported = await value(
      v.object({ currentRevision: v.string(), stale: v.boolean() }),
      "shelf.report",
      reportInput(plan, "minimal"),
      TEST_OWNER_KEY
    );
    const activity = await stub().activity(owner, "kit", {});
    expect(plan.profile).toBe("minimal");
    expect(reported).toStrictEqual({
      currentRevision: plan.profileRevision,
      stale: false,
    });
    expect(activity).toHaveLength(1);
  });

  it("answers the frozen failures: ShelfNotFound, ItemNotFound, ProfileNotFound, Forbidden", async () => {
    const publisher = await createKey("kit", ["read", "publish:kit/full"]);
    const failures = [
      await failure(
        "shelf.search",
        { query: "x", shelf: "nowhere" },
        TEST_OWNER_KEY
      ),
      await failure(
        "shelf.item.get",
        { item: "missing", shelf: "kit" },
        TEST_OWNER_KEY
      ),
      await failure(
        "shelf.profile.get",
        { profile: "missing", shelf: "kit" },
        TEST_OWNER_KEY
      ),
      await failure(
        "shelf.report",
        reportInput(
          {
            apmYmlDigest: `sha256:${"0".repeat(64)}`,
            profileRevision: `sha256-${"0".repeat(64)}`,
          },
          "minimal"
        ),
        publisher.secret
      ),
    ];
    expect(failures.map((found) => found._tag)).toStrictEqual([
      "ShelfNotFound",
      "ItemNotFound",
      "ProfileNotFound",
      "Forbidden",
    ]);
  });

  it("refuses an input outside the schema as a call failure the agent can read", async () => {
    const { result } = await call(
      "shelf.search",
      { query: "", shelf: "kit" },
      TEST_OWNER_KEY
    );
    expect(result?.isError).toBeTruthy();
    expect(result === undefined ? null : textOf(result)).toMatchObject({
      kind: "invalid-input",
    });
  });

  it("plans a compile idempotently and leaves the object unchanged", async () => {
    const before = await objectState();
    const input = { profile: "full", shelf: "kit" };
    const first = await call("shelf.compile.plan", input, TEST_OWNER_KEY);
    const second = await call("shelf.compile.plan", input, TEST_OWNER_KEY);
    // A cold object plans the same: the plan comes from the snapshot, not from anything the first call left.
    await abortAllDurableObjects();
    const cold = await call("shelf.compile.plan", input, TEST_OWNER_KEY);
    const after = await objectState();
    expect(first.result?.isError).toBeUndefined();
    expect(second.result).toStrictEqual(first.result);
    expect(cold.result).toStrictEqual(first.result);
    expect(after).toStrictEqual(before);
  });

  it("lists every MCP server of a shelf with kinds [mcp] and no query", async () => {
    const found = await value(
      v.object({
        items: v.array(
          v.object({ item: v.object({ id: v.string(), kind: v.string() }) })
        ),
        truncated: v.boolean(),
      }),
      "shelf.search",
      { kinds: ["mcp"], shelf: "kit" },
      TEST_OWNER_KEY
    );
    expect(found.items.map((entry) => entry.item.id).toSorted()).toStrictEqual([
      "context7",
      "linear",
      "playwright",
    ]);
    expect(
      found.items.filter((entry) => entry.item.kind !== "mcp")
    ).toStrictEqual([]);
    expect(found.truncated).toBeFalsy();
  });

  it("does not let a key of one shelf enumerate or read another", async () => {
    await push("other", shelfOf("other", false));
    const outsider = await createKey("other", ["read", "publish:other/*"]);
    const calls = [
      ["shelf.search", { kinds: ["mcp"], shelf: "kit" }],
      ["shelf.item.get", { item: "playwright", shelf: "kit" }],
      ["shelf.profile.get", { profile: "full", shelf: "kit" }],
      ["shelf.compile.plan", { profile: "full", shelf: "kit" }],
      ["shelf.recommend", { markers: {}, shelf: "kit" }],
    ] as const;
    const answers = await Promise.all(
      calls.map(
        async ([name, input]) => await failure(name, input, outsider.secret)
      )
    );
    // A shelf that exists answers exactly as one that does not.
    const missing = await failure(
      "shelf.search",
      { query: "x", shelf: "nowhere" },
      outsider.secret
    );
    const hidden = await failure(
      "shelf.search",
      { query: "x", shelf: "kit" },
      outsider.secret
    );
    expect(answers.map((found) => [found._tag, found.shelf])).toStrictEqual(
      calls.map(() => ["ShelfNotFound", "kit"])
    );
    expect(Object.keys(hidden).toSorted()).toStrictEqual(
      Object.keys(missing).toSorted()
    );
  });

  it("answers 401 to a revoked key", async () => {
    const key = await createKey("kit", ["read"]);
    const listed = await toolNames(key.secret);
    await data(
      v.object({ revokeKey: v.boolean() }),
      "mutation Revoke($shelf: ID!, $id: ID!) { revokeKey(shelf: $shelf, id: $id) }",
      { id: key.id, shelf: "kit" }
    );
    const response = await exports.default.fetch(`${ORIGIN}/mcp`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
      headers: mcpHeaders(key.secret),
      method: "POST",
    });
    expect(listed).toStrictEqual(READING_TOOLS);
    expect(response.status).toBe(401);
  });
});
