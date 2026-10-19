/**
 * The narrow relay at `/mcp` (`docs/PRD.md` section 8.1): names namespaced by item and never colliding with ShelfKit's
 * own tools, a tool list computed from the key, credentials injected upstream and never returned, and nothing held
 * between requests. The relayed servers are stand-ins answering the Worker's outbound `fetch` (`upstreams.ts`).
 */
import { capabilities } from "@shelfkit/schema";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../../src/auth/index.ts";
import { parseRelayedName, relayedName } from "../../src/mcp/names.ts";
import type { JsonObject } from "../../src/mcp/wire.ts";
import {
  createKey,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "../helpers.ts";
import { call, errorCode, mcpHeaders, textOf, toolNames } from "./client.ts";
import { LEGACY_TOOLS, UPSTREAM_ONLY_HEADER, Upstreams } from "./upstreams.ts";

const owner: Session = { keyId: "owner", kind: "owner" };
const SHELF_TOOLS: readonly string[] = capabilities.map(
  (capability) => capability.id
);
const READING_TOOLS = SHELF_TOOLS.filter((id) => id !== "shelf.report");
const UNKNOWN_TOOL = -32_602;

function hosted(id: string, url: string, extra: JsonObject = {}) {
  return [
    `items/mcp/${id}/item.json`,
    `${JSON.stringify({ flavour: "hosted", id, kind: "mcp", title: id, url, ...extra }, null, 2)}\n`,
  ] as const;
}

/** The shelf `relay`: four hosted servers, and a `stdio` one that is never relayed. */
const RELAY_SHELF = shelfOf(
  "relay",
  false,
  Object.fromEntries([
    hosted("linear", "https://mcp.linear.app/mcp", {
      headers: { Authorization: { secret: "LINEAR_API_KEY" } },
      transport: "streamable-http",
    }),
    hosted("legacy", "https://legacy.example/mcp", {
      headers: { "X-Client": "shelfkit" },
      tools: ["echo"],
    }),
    hosted("unbound", "https://mcp.unbound.example/mcp", {
      headers: { Authorization: { secret: "GITHUB_TOKEN" } },
    }),
    hosted("redirect", "https://redirect.example/mcp"),
    [
      "items/mcp/local/item.json",
      `${JSON.stringify({ args: ["server.js"], command: "node", flavour: "stdio", id: "local", kind: "mcp", title: "Local" })}\n`,
    ],
  ])
);

/** The relayed tools every server of the shelf offers, for a key granted all of them. */
const ALL_RELAYED = [
  "legacy__echo",
  "linear__list_issues",
  "linear__shelf.search",
  "linear__shelf_search",
];

function relayedOnly(names: readonly string[]): string[] {
  return names.filter((name) => name.includes("__")).toSorted();
}

describe("relayed names", () => {
  it("are <item>__<tool> and parse back unambiguously", () => {
    expect(relayedName("linear", "list_issues")).toBe("linear__list_issues");
    expect(parseRelayedName("linear__list_issues")).toStrictEqual({
      item: "linear",
      tool: "list_issues",
    });
    expect(parseRelayedName("linear__a__b")).toStrictEqual({
      item: "linear",
      tool: "a__b",
    });
  });

  it("are at most 128 characters and only MCP's tool name characters", () => {
    expect(relayedName("linear", "x".repeat(120))).toHaveLength(128);
    expect(relayedName("linear", "x".repeat(121))).toBeNull();
    expect(relayedName("linear", "bad name")).toBeNull();
  });

  it("never include a shelf.* tool, and a backend's shelf_search is not one", () => {
    expect(SHELF_TOOLS.map((id) => parseRelayedName(id))).toStrictEqual(
      SHELF_TOOLS.map(() => null)
    );
    expect(parseRelayedName("shelf_search")).toBeNull();
  });
});

describe("the relay", () => {
  let upstreams = new Upstreams();

  beforeEach(async () => {
    await reset();
    await abortAllDurableObjects();
    const pushed = await push("relay", RELAY_SHELF);
    if (pushed.errors.length > 0) {
      throw new Error(
        `the shelf did not push: ${JSON.stringify(pushed.errors)}`
      );
    }
    const object = env.SHELF.get(env.SHELF.idFromName("relay"));
    await object.putSecretName(
      owner,
      "relay",
      "LINEAR_API_KEY",
      "https://mcp.linear.app"
    );
    // Bound to another origin than the item's, so it is never released to it.
    await object.putSecretName(
      owner,
      "relay",
      "GITHUB_TOKEN",
      "https://api.github.com"
    );
    upstreams = new Upstreams();
    vi.spyOn(globalThis, "fetch").mockImplementation(upstreams.fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only the granted items' tools, namespaced, and nothing of ShelfKit's own for a relay-only key", async () => {
    const key = await createKey("relay", [
      "mcp:relay/linear",
      "mcp:relay/legacy",
    ]);
    const names = await toolNames(key.secret);
    // The backend's own `shelf.search` and `shelf_search` are namespaced, and its over-long and invalid names dropped.
    expect(names.toSorted()).toStrictEqual(ALL_RELAYED);
    expect(names.filter((name) => SHELF_TOOLS.includes(name))).toStrictEqual(
      []
    );
  });

  it("routes a backend's tool named shelf.search to the backend, never to ShelfKit's tool", async () => {
    const key = await createKey("relay", ["mcp:relay/linear"]);
    const shadow = await call(
      "linear__shelf.search",
      { text: "x" },
      key.secret
    );
    expect(shadow.result?.structuredContent).toMatchObject({
      tool: "shelf.search",
    });
    // And ShelfKit's `shelf.search` is not this key's to call at all.
    await expect(
      errorCode("shelf.search", { query: "x", shelf: "relay" }, key.secret)
    ).resolves.toBe(UNKNOWN_TOOL);
  });

  it("keeps ShelfKit's tools first and separate for a key that reads and relays", async () => {
    const key = await createKey("relay", ["read", "mcp:relay/linear"]);
    const names = await toolNames(key.secret);
    expect(names.slice(0, READING_TOOLS.length)).toStrictEqual(READING_TOOLS);
    expect(names.slice(READING_TOOLS.length).toSorted()).toStrictEqual([
      "linear__list_issues",
      "linear__shelf.search",
      "linear__shelf_search",
    ]);
  });

  it("injects the credential upstream and returns neither it nor the upstream's _meta", async () => {
    const key = await createKey("relay", ["mcp:relay/linear"]);
    const { reply, result } = await call(
      "linear__list_issues",
      { text: "open" },
      key.secret
    );
    const sent = upstreams.to("https://mcp.linear.app").at(-1);
    expect(result).toStrictEqual({
      content: [{ text: "called list_issues", type: "text" }],
      structuredContent: {
        arguments: { text: "open" },
        authorized: true,
        tool: "list_issues",
      },
    });
    expect(sent?.headers.authorization).toBe("test-linear-token");
    // The caller's own key never goes upstream, and nothing of the upstream's comes back but its result.
    expect(JSON.stringify(sent?.headers)).not.toContain(key.secret);
    expect(reply.text).not.toMatch(/test-linear-token|upstream metadata/u);
  });

  it("passes none of the upstream's headers back to the caller", async () => {
    const key = await createKey("relay", ["mcp:relay/linear"]);
    const { reply } = await call("linear__list_issues", {}, key.secret);
    expect({
      cookie: reply.headers.get("set-cookie"),
      session: reply.headers.get("mcp-session-id"),
      upstream: reply.headers.get(UPSTREAM_ONLY_HEADER),
    }).toStrictEqual({ cookie: null, session: null, upstream: null });
  });

  it("does the older revision's handshake inside one request and ends the session before answering", async () => {
    const key = await createKey("relay", ["mcp:relay/legacy"]);
    const { result } = await call("legacy__echo", { text: "hi" }, key.secret);
    const sequence = upstreams
      .to("https://legacy.example")
      .map((received) => received.rpc ?? received.method);
    expect(result?.structuredContent).toStrictEqual({ tool: "echo" });
    expect(sequence).toStrictEqual([
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ]);
    expect([...upstreams.sessions.values()]).toStrictEqual(["ended"]);
  });

  it("starts over on the next request, knowing nothing of the last", async () => {
    const key = await createKey("relay", ["mcp:relay/legacy"]);
    await call("legacy__echo", { text: "once" }, key.secret);
    await call("legacy__echo", { text: "again" }, key.secret);
    const handshakes = upstreams
      .to("https://legacy.example")
      .filter((received) => received.rpc === "initialize");
    expect(handshakes).toHaveLength(2);
    expect([...upstreams.sessions.values()]).toStrictEqual(["ended", "ended"]);
  });

  it("relays only the tools an item declares", async () => {
    const key = await createKey("relay", ["mcp:relay/legacy"]);
    const names = await toolNames(key.secret);
    const before = upstreams.received.length;
    const hidden = await errorCode("legacy__hidden", {}, key.secret);
    expect(LEGACY_TOOLS).toContain("hidden");
    expect(names).toStrictEqual(["legacy__echo"]);
    expect(hidden).toBe(UNKNOWN_TOOL);
    expect(upstreams.received).toHaveLength(before);
  });

  it("refuses rather than call a server without its credential, and never sends a secret to another origin", async () => {
    const key = await createKey("relay", ["mcp:relay/unbound"]);
    const names = await toolNames(key.secret);
    const { result } = await call("unbound__anything", {}, key.secret);
    const refused = result === undefined ? null : textOf(result);
    expect(names).toStrictEqual([]);
    expect(result?.isError).toBeTruthy();
    expect(refused).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(refused)).toMatch(/GITHUB_TOKEN/u);
    expect(upstreams.to("https://mcp.unbound.example")).toStrictEqual([]);
  });

  it("does not follow a redirect, which would carry the credential to another origin", async () => {
    const key = await createKey("relay", ["mcp:relay/redirect"]);
    const { result } = await call("redirect__anything", {}, key.secret);
    expect(result?.isError).toBeTruthy();
    expect(JSON.stringify(result)).toMatch(/redirect/u);
    expect(upstreams.to("https://evil.example")).toStrictEqual([]);
  });

  it("gives an ungranted item, a stdio item, and an anonymous caller nothing to see or call", async () => {
    const reader = await createKey("relay", ["read"]);
    const linearOnly = await createKey("relay", ["mcp:relay/linear"]);
    const answers = {
      anonymous: await errorCode("linear__list_issues", {}),
      readerCalls: await errorCode("linear__list_issues", {}, reader.secret),
      readerSees: relayedOnly(await toolNames(reader.secret)),
      stdio: await errorCode(
        "local__anything",
        {},
        TEST_OWNER_KEY,
        "?shelf=relay"
      ),
      ungranted: await errorCode("legacy__echo", {}, linearOnly.secret),
    };
    expect(answers).toStrictEqual({
      anonymous: UNKNOWN_TOOL,
      readerCalls: UNKNOWN_TOOL,
      readerSees: [],
      stdio: UNKNOWN_TOOL,
      ungranted: UNKNOWN_TOOL,
    });
    expect(upstreams.to("https://mcp.linear.app")).toStrictEqual([]);
  });

  it("relays for the owner only on the shelf it names", async () => {
    const unnamed = await toolNames(TEST_OWNER_KEY);
    const named = await toolNames(TEST_OWNER_KEY, "?shelf=relay");
    expect(relayedOnly(unnamed)).toStrictEqual([]);
    expect(relayedOnly(named)).toStrictEqual(ALL_RELAYED);
  });

  it("does not let a key of another shelf see or call this shelf's relayed tools", async () => {
    await push("other", shelfOf("other", false));
    const outsider = await createKey("other", ["read", "mcp:other/linear"]);
    const names = await toolNames(outsider.secret, "?shelf=relay");
    const called = await errorCode(
      "linear__list_issues",
      {},
      outsider.secret,
      "?shelf=relay"
    );
    expect(names).toStrictEqual(READING_TOOLS);
    expect(called).toBe(UNKNOWN_TOOL);
    expect(upstreams.to("https://mcp.linear.app")).toStrictEqual([]);
  });

  it("checks a relayed call's envelope as the binding checks ShelfKit's, before calling anything", async () => {
    const key = await createKey("relay", ["mcp:relay/linear"]);
    async function send(version: string | null, params: JsonObject) {
      const headers = mcpHeaders(key.secret);
      if (version === null) {
        headers.delete("mcp-protocol-version");
      } else {
        headers.set("mcp-protocol-version", version);
      }
      const response = await exports.default.fetch(`${ORIGIN}/mcp`, {
        body: JSON.stringify({
          id: 7,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "linear__list_issues", ...params },
        }),
        headers,
        method: "POST",
      });
      const body = v.parse(
        v.object({ error: v.object({ code: v.number() }) }),
        await response.json()
      );
      return [response.status, body.error.code];
    }
    const meta = {
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    };
    const answers = [
      await send(null, meta),
      await send("2025-06-18", meta),
      await send("2026-07-28", {}),
    ];
    expect(answers).toStrictEqual([
      [400, -32_020],
      [400, -32_022],
      [400, -32_602],
    ]);
    expect(upstreams.received).toStrictEqual([]);
  });
});
