/**
 * Stand-in MCP servers for the relay, answering the Worker's outbound `fetch` by origin:
 *
 * - `https://mcp.linear.app`: revision 2026-07-28, stateless, with tools that try to collide with ShelfKit's own;
 * - `https://legacy.example`: an older streamable HTTP server that needs `initialize`, hands out a session, answers
 *   over an event stream, and records whether the session was ended;
 * - `https://edge.example`: the relay's hard cases (`edges.ts`);
 * - `https://redirect.example`: answers every request with a redirect to `https://evil.example`;
 * - a loopback address: passed to the platform's `fetch`, unrecorded, since it is the Git remote of a repository on
 *   the local Artifacts simulator, which a test's shelf pushes to;
 * - anything else: recorded, and answered `502`, so a test can assert it was never called.
 */
import * as v from "valibot";

import { IdSchema } from "../../src/mcp/wire.ts";
import type { Id, JsonObject } from "../../src/mcp/wire.ts";
import { edge } from "./edges.ts";

/** The platform's `fetch`, kept before a test replaces it with `Upstreams.fetch`. */
const platformFetch = globalThis.fetch;

/** One request a stand-in received. */
export interface Received {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON-RPC method, for a POST. */
  readonly rpc: string | null;
  readonly params: JsonObject | null;
}

/** What each stand-in offers in `tools/list`. */
export const LINEAR_TOOLS = [
  "list_issues",
  "shelf.search",
  "shelf_search",
  `long_${"x".repeat(130)}`,
  "bad name!",
] as const;

export const LEGACY_TOOLS = ["echo", "hidden"] as const;

/** An upstream header the relay must never pass on to its caller. */
export const UPSTREAM_ONLY_HEADER = "x-upstream-only";

const MessageSchema = v.object({
  id: v.optional(IdSchema),
  method: v.string(),
  params: v.optional(v.looseObject({})),
});

/** What a stand-in reads of a request. */
interface Message {
  readonly id: Id;
  readonly rpc: string | null;
  readonly params: JsonObject;
}

const ToolCallSchema = v.object({ arguments: v.unknown(), name: v.string() });

const MetaSchema = v.object({
  _meta: v.object({ "io.modelcontextprotocol/protocolVersion": v.string() }),
});

function tool(name: string) {
  return {
    description: `The upstream tool ${name}.`,
    inputSchema: { properties: { text: { type: "string" } }, type: "object" },
    name,
  };
}

function rpcError(id: Id, code: number, message: string, status: number) {
  return Response.json(
    { error: { code, message }, id, jsonrpc: "2.0" },
    { status }
  );
}

/** The 2026-07-28 server: every request names its revision, and nothing is kept. */
function modern(request: Request, message: Message): Response {
  const meta = v.safeParse(MetaSchema, message.params);
  if (
    request.headers.get("mcp-protocol-version") !== "2026-07-28" ||
    !meta.success ||
    meta.output._meta["io.modelcontextprotocol/protocolVersion"] !==
      "2026-07-28"
  ) {
    return rpcError(message.id, -32_022, "Unsupported protocol version", 400);
  }
  const headers = {
    "set-cookie": "upstream=1",
    [UPSTREAM_ONLY_HEADER]: "upstream",
  };
  if (message.rpc === "tools/list") {
    return Response.json(
      {
        id: message.id,
        jsonrpc: "2.0",
        result: { tools: LINEAR_TOOLS.map(tool) },
      },
      { headers }
    );
  }
  const called = v.safeParse(ToolCallSchema, message.params);
  if (message.rpc !== "tools/call" || !called.success) {
    return rpcError(message.id, -32_601, "Method not found", 404);
  }
  return Response.json(
    {
      id: message.id,
      jsonrpc: "2.0",
      result: {
        _meta: { "upstream.example/secret": "upstream metadata" },
        content: [{ text: `called ${called.output.name}`, type: "text" }],
        structuredContent: {
          arguments: called.output.arguments,
          authorized:
            request.headers.get("authorization") === "test-linear-token",
          tool: called.output.name,
        },
      },
    },
    { headers }
  );
}

export class Upstreams {
  readonly received: Received[] = [];
  /** Sessions the legacy server handed out, and whether each was ended. */
  readonly sessions = new Map<string, "open" | "ended">();

  /** The stand-in for the platform's `fetch`. */
  readonly fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    const { hostname, origin, pathname } = new URL(request.url);
    if (hostname === "127.0.0.1") {
      return await platformFetch(request);
    }
    const text = request.method === "POST" ? await request.text() : "";
    const parsed = v.safeParse(
      MessageSchema,
      text === "" ? null : JSON.parse(text)
    );
    const message: Message = parsed.success
      ? {
          id: parsed.output.id ?? null,
          params: parsed.output.params ?? {},
          rpc: parsed.output.method,
        }
      : { id: null, params: {}, rpc: null };
    this.received.push({
      headers: Object.fromEntries(request.headers),
      method: request.method,
      origin,
      params: parsed.success ? message.params : null,
      path: pathname,
      rpc: message.rpc,
    });
    if (origin === "https://mcp.linear.app") {
      return modern(request, message);
    }
    if (origin === "https://legacy.example") {
      return this.legacy(request, message);
    }
    if (origin === "https://edge.example") {
      return await edge(request, message);
    }
    if (origin === "https://redirect.example") {
      return new Response(null, {
        headers: { location: "https://evil.example/mcp" },
        status: 307,
      });
    }
    return new Response("no such server", { status: 502 });
  };

  /** Requests one stand-in received, by origin. */
  to(origin: string): Received[] {
    return this.received.filter((received) => received.origin === origin);
  }

  /** The older server: a handshake, a session, answers over an event stream. */
  private legacy(request: Request, message: Message): Response {
    const session = request.headers.get("mcp-session-id");
    if (request.method === "DELETE") {
      if (session !== null && this.sessions.has(session)) {
        this.sessions.set(session, "ended");
      }
      return new Response(null, { status: 200 });
    }
    if (message.rpc === "initialize") {
      const opened = `session-${this.sessions.size + 1}`;
      this.sessions.set(opened, "open");
      return Response.json(
        {
          id: message.id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: "2025-06-18",
            serverInfo: { name: "legacy", version: "1" },
          },
        },
        { headers: { "mcp-session-id": opened } }
      );
    }
    if (session === null || this.sessions.get(session) !== "open") {
      return rpcError(
        null,
        -32_000,
        "Bad Request: No valid session ID provided",
        400
      );
    }
    if (message.rpc === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const name = v.safeParse(ToolCallSchema, message.params);
    const result =
      message.rpc === "tools/list"
        ? { tools: LEGACY_TOOLS.map(tool) }
        : {
            content: [{ text: "legacy", type: "text" }],
            structuredContent: { tool: name.success ? name.output.name : null },
          };
    // An event stream with a notification before the answer, as a streamable HTTP server may send.
    const events = [
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { data: "working", level: "info" },
      },
      { id: message.id, jsonrpc: "2.0", result },
    ];
    return new Response(
      events
        .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } }
    );
  }
}
