/**
 * The JSON-RPC messages `/mcp` reads: from its caller, and from a relayed server. Each is parsed here, at the wire,
 * and only the fields the endpoint acts on are read. Tool arguments, tool schemas, and tool results are passed through
 * as the JSON they are: they belong to the caller and the relayed server, and ShelfKit neither reads nor changes them.
 */
import type { JsonObject } from "@acid-cat/spec-ts";
import * as v from "valibot";

export type { JsonObject } from "@acid-cat/spec-ts";

/** BOUNDARY: any JSON object, carried through unread; `JsonObject` is AcidCat's name for it. */
const JsonObjectSchema = v.pipe(
  v.record(v.string(), v.unknown()),
  v.transform((value): JsonObject => value)
);

/** A JSON-RPC id. */
export const IdSchema = v.union([v.string(), v.number(), v.null()]);

export type Id = v.InferOutput<typeof IdSchema>;

/** The metadata key a 2026-07-28 request names its revision with. */
export const VERSION_META = "io.modelcontextprotocol/protocolVersion";

/** A request to `/mcp`, read only as far as routing it needs. */
export const IncomingSchema = v.object({
  id: v.optional(IdSchema),
  method: v.string(),
  params: v.optional(
    v.object({
      _meta: v.optional(v.object({ [VERSION_META]: v.optional(v.unknown()) })),
      arguments: v.optional(JsonObjectSchema),
      name: v.optional(v.string()),
    }),
    {}
  ),
});

export type Incoming = v.InferOutput<typeof IncomingSchema>;

/** AcidCat's `tools/list` answer, keeping every field it gives. */
export const ToolsReplySchema = v.looseObject({
  result: v.looseObject({
    tools: v.array(v.looseObject({ name: v.string() })),
  }),
});

/** An answer from a relayed server: its result, or its error. */
export const AnswerSchema = v.union([
  v.object({ id: IdSchema, result: JsonObjectSchema }),
  v.object({
    error: v.object({
      code: v.fallback(v.number(), -32_603),
      message: v.fallback(v.string(), "unknown error"),
    }),
    id: IdSchema,
  }),
]);

export type Answer =
  | { readonly result: JsonObject }
  | { readonly error: { readonly code: number; readonly message: string } };

/** What a relayed server answers to `initialize`, read for the revision it agrees to. */
export const InitializeResultSchema = v.object({
  protocolVersion: v.optional(v.string()),
});

/** One page of a relayed server's `tools/list`. */
export const ToolPageSchema = v.object({
  nextCursor: v.optional(v.string()),
  tools: v.fallback(v.array(v.unknown()), []),
});

/** A relayed server's tool, with only the fields MCP defines for one. */
export const UpstreamToolSchema = v.object({
  annotations: v.optional(JsonObjectSchema),
  description: v.optional(v.string()),
  inputSchema: JsonObjectSchema,
  name: v.string(),
  outputSchema: v.optional(JsonObjectSchema),
  title: v.optional(v.string()),
});

/** A relayed tool as `tools/list` gives it: an upstream tool, renamed `<item>__<tool>`. */
export type RelayedTool = v.InferOutput<typeof UpstreamToolSchema>;

/** A relayed server's tool result, keeping only what MCP defines for one: nothing of its `_meta` passes. */
export const ToolResultSchema = v.object({
  content: v.fallback(v.array(v.unknown()), []),
  isError: v.optional(v.boolean()),
  structuredContent: v.optional(v.unknown()),
});

export type RelayedResult = v.InferOutput<typeof ToolResultSchema>;

/** `text` as JSON, checked against `schema`; `null` when it is not JSON at all. */
export function readJson<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  text: string
): v.SafeParseResult<TSchema> | null {
  try {
    return v.safeParse(schema, JSON.parse(text));
  } catch {
    return null;
  }
}
