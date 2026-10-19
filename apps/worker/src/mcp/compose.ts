/**
 * `/mcp` as one MCP server made of two parts, side by side (`docs/PRD.md` section 8):
 *
 * - ShelfKit's own tools, served by AcidCat's MCP binding (`mcpHandler` of `@acid-cat/core-ts`), which names each tool
 *   by its capability id;
 * - the narrow relay, whose tools are `<item>__<tool>` (`names.ts`).
 *
 * `tools/list` is AcidCat's list followed by the relayed tools, `tools/call` on a relayed name goes to the relay, and
 * every other message, including each rejection, is AcidCat's to answer. A capability id contains no `_`, so the two
 * namespaces are disjoint by construction; the composition still drops any relayed tool that is not of the relayed
 * form or that names one of AcidCat's tools, so a relay cannot shadow a `shelf.*` tool even if it were wrong.
 *
 * Both parts keep nothing between requests: AcidCat opens a session per request and closes it with the response, and
 * the relay is made per request too. This module imports nothing of the Worker's, so `acid-cat conform` drives exactly
 * this composition in Node (`test/mcp/conform.node.ts`) with AcidCat's conformance fixture in place of ShelfKit's tools.
 */
import { mcpHandler } from "@acid-cat/core-ts";
import type { App, ToJsonSchema } from "@acid-cat/core-ts";
import {
  MCP_PROTOCOL_VERSION,
  MCP_REJECTIONS,
  MCP_UNKNOWN_TOOL,
  readBounded,
  screenRequest,
} from "@acid-cat/spec-ts";
import type { Rejection } from "@acid-cat/spec-ts";

import { isRelayedName } from "./names.ts";
import {
  IncomingSchema,
  readJson,
  ToolsReplySchema,
  VERSION_META,
} from "./wire.ts";
import type {
  Id,
  Incoming,
  JsonObject,
  RelayedResult,
  RelayedTool,
} from "./wire.ts";

export type { RelayedResult, RelayedTool } from "./wire.ts";

/** The relay of one request. */
export interface Relay {
  /** The relayed tools this request's credential may see. */
  readonly list: (signal: AbortSignal) => Promise<readonly RelayedTool[]>;
  /** Call one, or `null` when `name` is not a tool this request's credential may call. */
  readonly call: (
    name: string,
    input: JsonObject,
    signal: AbortSignal
  ) => Promise<RelayedResult | null>;
}

/** A relay with no tools, for a request that may relay nothing. */
export const NO_RELAY: Relay = {
  call: async () => await Promise.resolve(null),
  list: async () => await Promise.resolve([]),
};

export interface McpEndpoint<Context> {
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  /** The origins a browser may call from. A request with no `Origin` is accepted, as the binding requires. */
  readonly allowedOrigins: readonly string[];
  readonly toJsonSchema: ToJsonSchema;
  /** The context of one request's capabilities. */
  readonly createContext: (request: Request) => Context | Promise<Context>;
  /** The relay of one request. */
  readonly relay: (request: Request) => Relay | Promise<Relay>;
  /** The largest request body, in bytes; 1 MiB when absent. */
  readonly maximumBytes?: number;
}

const ONE_MEBIBYTE = 1_048_576;

/** The `/mcp` handler: `app`'s capabilities through AcidCat's MCP binding, with the relay beside them. */
export function serveMcp<Context>(
  app: App<Context>,
  endpoint: McpEndpoint<Context>
): (request: Request) => Promise<Response> {
  const maximumBytes = endpoint.maximumBytes ?? ONE_MEBIBYTE;
  const acidcat = mcpHandler(app, {
    allowedOrigins: endpoint.allowedOrigins,
    createContext: endpoint.createContext,
    instructions: endpoint.instructions,
    maximumBytes,
    name: endpoint.name,
    toJsonSchema: endpoint.toJsonSchema,
    version: endpoint.version,
  });

  async function callRelayed(
    request: Request,
    message: Incoming,
    name: string
  ): Promise<Response> {
    const refused = screenMessage(request, message);
    if (refused !== null) {
      return refused;
    }
    const id = message.id ?? null;
    const relay = await endpoint.relay(request);
    const result = await relay.call(
      name,
      message.params.arguments ?? {},
      request.signal
    );
    if (result === null) {
      return error(200, id, MCP_UNKNOWN_TOOL, `Tool '${name}' not found`);
    }
    return Response.json({
      id,
      jsonrpc: "2.0",
      result: {
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: endpoint.name,
            version: endpoint.version,
          },
        },
        resultType: "complete",
        ...result,
      },
    });
  }

  return async (request) => {
    // A request AcidCat rejects before reading it is AcidCat's to reject.
    const screened = screenRequest(request, {
      allowedOrigins: endpoint.allowedOrigins,
      maximumBytes,
      mediaType: "application/json",
      methods: ["POST"],
    });
    if (screened !== undefined) {
      return await acidcat(request);
    }
    const body = await readBounded(request, maximumBytes);
    if ("rejection" in body) {
      return rejection(body.rejection);
    }
    const message = readJson(IncomingSchema, body.text);
    if (message === null) {
      return rejection("not-utf8");
    }
    // The body is read, so AcidCat gets the same request again with the text it held.
    const forward = async () =>
      await acidcat(
        new Request(request.url, {
          body: body.text,
          headers: request.headers,
          method: "POST",
          signal: request.signal,
        })
      );
    if (!message.success) {
      return await forward();
    }
    const { method, params } = message.output;
    if (method === "tools/list") {
      return await withRelayedTools(await forward(), async () => {
        const relay = await endpoint.relay(request);
        return await relay.list(request.signal);
      });
    }
    if (
      method === "tools/call" &&
      params.name !== undefined &&
      isRelayedName(params.name)
    ) {
      return await callRelayed(request, message.output, params.name);
    }
    return await forward();
  };
}

/** AcidCat's `tools/list` answer, with the relayed tools after its own. Anything else passes unchanged. */
async function withRelayedTools(
  answered: Response,
  relayed: () => Promise<readonly RelayedTool[]>
): Promise<Response> {
  if (answered.status !== 200) {
    return answered;
  }
  const text = await answered.text();
  const reply = readJson(ToolsReplySchema, text);
  if (reply === null || !reply.success) {
    return new Response(text, answered);
  }
  const own = reply.output.result.tools;
  const taken = new Set(own.map((tool) => tool.name));
  let tools: readonly RelayedTool[] = [];
  try {
    tools = await relayed();
  } catch {
    // A relay that cannot list gives no tools; ShelfKit's own still answer.
  }
  const accepted = tools.filter(
    (tool) => isRelayedName(tool.name) && !taken.has(tool.name)
  );
  return Response.json({
    ...reply.output,
    result: { ...reply.output.result, tools: [...own, ...accepted] },
  });
}

/**
 * The checks AcidCat's binding makes of a message after its body is read, for the one message it does not see: a call
 * to a relayed tool. Each answer is the one the binding gives.
 */
function screenMessage(request: Request, message: Incoming): Response | null {
  const id = message.id ?? null;
  const version = request.headers.get("MCP-Protocol-Version");
  if (version === null) {
    return error(400, id, -32_020, "MCP-Protocol-Version header is required");
  }
  if (version !== MCP_PROTOCOL_VERSION) {
    return error(400, id, -32_022, `Unsupported protocol version ${version}`, {
      supported: [MCP_PROTOCOL_VERSION],
    });
  }
  if (message.id === undefined) {
    return new Response(null, {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }
  const meta = message.params._meta?.[VERSION_META];
  if (meta === undefined) {
    return error(400, id, -32_602, "Required request metadata is missing");
  }
  if (meta !== version) {
    return error(
      400,
      id,
      -32_020,
      "MCP-Protocol-Version header does not match request metadata"
    );
  }
  return null;
}

function error(
  status: number,
  id: Id,
  code: number,
  message: string,
  data?: JsonObject
): Response {
  return Response.json(
    {
      error: data === undefined ? { code, message } : { code, data, message },
      id,
      jsonrpc: "2.0",
    },
    { status }
  );
}

const REJECTION_MESSAGES: Readonly<Record<Rejection, string>> = {
  "media-type": "Use application/json.",
  method: "Use POST.",
  "not-utf8": "The request body is not UTF-8 JSON.",
  origin: "This origin is not allowed.",
  "too-large": "The request body is too large.",
};

/** A rejection of a body, as AcidCat's binding gives it. */
function rejection(reason: Rejection): Response {
  const { code, status } = MCP_REJECTIONS[reason];
  if (code === undefined) {
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status,
    });
  }
  return Response.json(
    {
      error: { code, message: REJECTION_MESSAGES[reason] },
      id: null,
      jsonrpc: "2.0",
    },
    { headers: { "Cache-Control": "no-store" }, status }
  );
}
