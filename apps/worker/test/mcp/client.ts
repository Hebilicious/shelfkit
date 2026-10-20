/** An MCP client the way an agent with only a key is one: JSON-RPC over `POST /mcp`, revision 2026-07-28, no SDK. */
import { exports } from "cloudflare:workers";
import * as v from "valibot";

import type { JsonObject } from "../../src/mcp/wire.ts";
import { ORIGIN } from "../helpers.ts";

export const PROTOCOL_VERSION = "2026-07-28";

const ReplySchema = v.object({
  error: v.optional(
    v.object({
      code: v.number(),
      data: v.optional(v.unknown()),
      message: v.string(),
    })
  ),
  id: v.unknown(),
  jsonrpc: v.literal("2.0"),
  result: v.optional(v.looseObject({})),
});

export type Reply = v.InferOutput<typeof ReplySchema> & {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
};

/** The headers of a 2026-07-28 request, with `key` as a Bearer key when given. */
export function mcpHeaders(key?: string): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
  });
  if (key !== undefined) {
    headers.set("authorization", `Bearer ${key}`);
  }
  return headers;
}

/** Send one request to `/mcp` (with `query`, e.g. `?shelf=x`), with `key` as a Bearer key when given. */
export async function rpc(
  method: string,
  params: JsonObject = {},
  key?: string,
  query = ""
): Promise<Reply> {
  const response = await exports.default.fetch(`${ORIGIN}/mcp${query}`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION },
      },
    }),
    headers: mcpHeaders(key),
    method: "POST",
  });
  const text = await response.text();
  if (
    response.headers.get("content-type")?.startsWith("application/json") !==
    true
  ) {
    throw new Error(`/mcp answered ${response.status} without JSON: ${text}`);
  }
  return {
    ...v.parse(ReplySchema, JSON.parse(text)),
    headers: response.headers,
    status: response.status,
    text,
  };
}

const ToolsSchema = v.object({
  tools: v.array(
    v.object({
      annotations: v.optional(v.looseObject({})),
      description: v.optional(v.string()),
      inputSchema: v.looseObject({}),
      name: v.string(),
    })
  ),
});

/** The tools `/mcp` lists for `key`. */
export async function tools(key?: string, query = "") {
  const reply = await rpc("tools/list", {}, key, query);
  return v.parse(ToolsSchema, reply.result).tools;
}

/** The names of the tools `/mcp` lists for `key`. */
export async function toolNames(key?: string, query = ""): Promise<string[]> {
  const listed = await tools(key, query);
  return listed.map((tool) => tool.name);
}

const ToolResultSchema = v.object({
  content: v.array(v.looseObject({ type: v.string() })),
  isError: v.optional(v.boolean()),
  structuredContent: v.optional(v.unknown()),
});

/** Call a tool and read its result; a JSON-RPC error is returned as is. */
export async function call(
  name: string,
  input: JsonObject,
  key?: string,
  query = ""
) {
  const reply = await rpc("tools/call", { arguments: input, name }, key, query);
  return {
    reply,
    result:
      reply.result === undefined
        ? undefined
        : v.parse(ToolResultSchema, reply.result),
  };
}

/** The JSON-RPC error code a call is answered with, or `null` when it was answered with a result. */
export async function errorCode(
  name: string,
  input: JsonObject,
  key?: string,
  query = ""
): Promise<number | null> {
  const { reply } = await call(name, input, key, query);
  return reply.error?.code ?? null;
}

/** The value of a call that must succeed: its `structuredContent`. */
export async function value<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  name: string,
  input: JsonObject,
  key?: string
): Promise<v.InferOutput<TSchema>> {
  const { reply, result } = await call(name, input, key);
  if (result === undefined || result.isError === true) {
    throw new Error(`${name} failed: ${reply.text}`);
  }
  return v.parse(schema, result.structuredContent);
}

const TextContentSchema = v.object({ text: v.string() });

/** The JSON in the text content of a tool result. */
export function textOf(result: { readonly content: readonly unknown[] }) {
  const [first] = result.content;
  return v.parse(
    v.looseObject({}),
    JSON.parse(v.parse(TextContentSchema, first).text)
  );
}

const FailureSchema = v.object({
  error: v.looseObject({ _tag: v.string() }),
  ok: v.literal(false),
});

/** The failure of a call that must fail with an AcidCat failure: `{ ok: false, error }`. */
export async function failure(name: string, input: JsonObject, key?: string) {
  const { reply, result } = await call(name, input, key);
  if (result?.isError !== true) {
    throw new Error(`${name} did not fail: ${reply.text}`);
  }
  return v.parse(FailureSchema, textOf(result)).error;
}
