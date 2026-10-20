/**
 * M2's agent-side exit criterion (issue #6): an agent holding only a key and the `/mcp` URL discovers the shelf's MCP
 * servers and writes a working client configuration, with no CLI involved.
 *
 * The agent here is nothing but JSON-RPC over HTTP. It lists the servers with `shelf.search`, reads each definition with
 * `shelf.item.get`, and writes the `mcpServers` JSON that Claude Code, Cursor, and similar clients read. A `stdio`
 * server becomes a command the client runs itself, a `remote` one a URL the client calls directly, and a hosted one is
 * reached through ShelfKit's own `/mcp`, whose relayed tools the agent then calls. Secrets stay references by name,
 * `${NAME}`, which those clients expand from the environment.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import type { Session } from "../../src/auth/index.ts";
import { createKey, fixtureShelf, ORIGIN, push } from "../helpers.ts";
import { mcpHeaders, rpc, value } from "./client.ts";
import { Upstreams } from "./upstreams.ts";

const owner: Session = { keyId: "owner", kind: "owner" };

const SecretValueSchema = v.union([
  v.string(),
  v.object({ secret: v.string() }),
]);

const SecretsSchema = v.optional(v.record(v.string(), SecretValueSchema), {});

/** What the agent needs of an MCP item's definition, read from `shelf.item.get`. */
const McpItemSchema = v.variant("flavour", [
  v.object({
    args: v.optional(v.array(v.string()), []),
    command: v.string(),
    env: SecretsSchema,
    flavour: v.literal("stdio"),
    id: v.string(),
  }),
  v.object({
    flavour: v.literal("remote"),
    headers: SecretsSchema,
    id: v.string(),
    transport: v.optional(v.string()),
    url: v.string(),
  }),
  v.object({ flavour: v.literal("hosted"), id: v.string() }),
]);

type McpItem = v.InferOutput<typeof McpItemSchema>;
type Secrets = v.InferOutput<typeof SecretsSchema>;

/** A client config entry, as Claude Code's and Cursor's `mcpServers` hold one. */
type ClientServer =
  | {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

/** `${NAME}`: how those clients refer to an environment variable. */
function environmentReference(name: string): string {
  return `\${${name}}`;
}

/** Each value as the client writes it: a literal as is, a secret as a reference to the variable of its name. */
function references(values: Secrets): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, secretValue]) => [
      name,
      v.is(v.string(), secretValue)
        ? secretValue
        : environmentReference(secretValue.secret),
    ])
  );
}

/** The agent's whole job: an `mcpServers` entry per server, and ShelfKit's own endpoint for the hosted ones. */
function clientConfig(items: readonly McpItem[], endpoint: string) {
  const servers = new Map<string, ClientServer>();
  for (const item of items) {
    if (item.flavour === "stdio") {
      servers.set(item.id, {
        args: item.args,
        command: item.command,
        env: references(item.env),
      });
    } else if (item.flavour === "remote") {
      servers.set(item.id, {
        headers: references(item.headers),
        type: item.transport === "sse" ? "sse" : "http",
        url: item.url,
      });
    }
  }
  if (items.some((item) => item.flavour === "hosted")) {
    servers.set("shelfkit", {
      headers: {
        Authorization: `Bearer ${environmentReference("SHELFKIT_KEY")}`,
      },
      type: "http",
      url: endpoint,
    });
  }
  return { mcpServers: Object.fromEntries(servers) };
}

/** What the agent learns from `/mcp`, using only its key. */
async function discover(key: string) {
  const discovered = await rpc("server/discover", {}, key);
  const found = await value(
    v.object({
      items: v.array(v.object({ item: v.object({ id: v.string() }) })),
    }),
    "shelf.search",
    { kinds: ["mcp"], shelf: "kit" },
    key
  );
  const ids = found.items.map((entry) => entry.item.id);
  const items = await Promise.all(
    ids.map(async (id) => {
      const read = await value(
        v.object({ item: McpItemSchema }),
        "shelf.item.get",
        { item: id, shelf: "kit" },
        key
      );
      return read.item;
    })
  );
  return { ids, instructions: discovered.result?.instructions, items };
}

/** The tools a client lists through the `shelfkit` entry exactly as written, with `SHELFKIT_KEY` set to `key`. */
async function listThrough(entry: ClientServer | undefined, key: string) {
  const { headers, url } = v.parse(
    v.object({
      headers: v.object({ Authorization: v.string() }),
      url: v.string(),
    }),
    entry
  );
  const sent = mcpHeaders();
  sent.set(
    "authorization",
    headers.Authorization.replace(environmentReference("SHELFKIT_KEY"), key)
  );
  const response = await exports.default.fetch(url, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    }),
    headers: sent,
    method: "POST",
  });
  const listed = v.parse(
    v.object({
      result: v.object({ tools: v.array(v.object({ name: v.string() })) }),
    }),
    await response.json()
  );
  return listed.result.tools.map((tool) => tool.name);
}

describe("an agent with only a key", () => {
  beforeEach(async () => {
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
    await env.SHELF.get(env.SHELF.idFromName("kit")).putSecretName(
      owner,
      "kit",
      "LINEAR_API_KEY",
      "https://mcp.linear.app"
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(new Upstreams().fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("discovers the shelf's MCP servers and writes a working client configuration, with no CLI", async () => {
    const key = await createKey("kit", ["read", "mcp:kit/linear"]);
    const endpoint = `${ORIGIN}/mcp`;
    const learned = await discover(key.secret);
    const config = clientConfig(learned.items, endpoint);
    // It works: the client reaches the hosted server's tools, and ShelfKit's, through the entry as written.
    const reachable = await listThrough(config.mcpServers.shelfkit, key.secret);

    expect(learned.instructions).toStrictEqual(
      expect.stringContaining("shelf")
    );
    expect(learned.ids.toSorted()).toStrictEqual([
      "context7",
      "linear",
      "playwright",
    ]);
    // Every secret is a reference by name; no value is anywhere in it.
    expect(config).toStrictEqual({
      mcpServers: {
        context7: {
          headers: {
            CONTEXT7_API_KEY: environmentReference("CONTEXT7_API_KEY"),
          },
          type: "http",
          url: "https://mcp.context7.com/mcp",
        },
        playwright: {
          args: ["-y", "@playwright/mcp@latest"],
          command: "npx",
          env: {
            BROWSER_TOKEN: environmentReference("BROWSER_TOKEN"),
            LOG_LEVEL: "info",
          },
        },
        shelfkit: {
          headers: {
            Authorization: `Bearer ${environmentReference("SHELFKIT_KEY")}`,
          },
          type: "http",
          url: endpoint,
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("test-linear-token");
    expect(reachable).toStrictEqual(
      expect.arrayContaining(["shelf.search", "linear__list_issues"])
    );
  });
});
