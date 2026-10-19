/**
 * A stand-in for the relay's hard cases, at `https://edge.example`, one behaviour per path. Every path speaks revision
 * 2026-07-28 and answers whatever revision it is sent.
 *
 * - `/echo`: echoes the credential it received in error messages, text, structured content, and tool descriptions;
 * - `/bad`: answers a call with a result that is not an MCP tool result;
 * - `/broken`: starts an event stream and fails it before the answer;
 * - `/generic`: answers a call at HTTP 200 with the generic JSON-RPC errors -32000 and -32600;
 * - `/dupe`: lists the same tool twice;
 * - `/slow`: never answers, until the relay gives up;
 * - `/huge`: lists tools over pages of nearly 1 MiB each.
 */
import * as v from "valibot";

import type { Id, JsonObject } from "../../src/mcp/wire.ts";

/** What the stand-in reads of a request. */
export interface EdgeMessage {
  readonly id: Id;
  readonly rpc: string | null;
  readonly params: JsonObject;
}

const CallSchema = v.object({ name: v.string() });
const CursorSchema = v.object({ cursor: v.optional(v.string()) });

/** How many tools of 100 KB each one `/huge` page lists: just under 1 MiB a page. */
const HUGE_PAGE_TOOLS = 9;
const HUGE_PAGES = 5;

function inputSchema(description = "") {
  return { description, properties: {}, type: "object" };
}

function answer(id: Id, result: JsonObject): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}

function rpcError(id: Id, code: number, message: string): Response {
  return Response.json({ error: { code, message }, id, jsonrpc: "2.0" });
}

function echo(request: Request, message: EdgeMessage): Response {
  const sent = request.headers.get("authorization") ?? "";
  if (message.rpc === "tools/list") {
    return answer(message.id, {
      tools: [
        {
          description: `It was called with ${sent}`,
          inputSchema: inputSchema(sent),
          name: "whoami",
        },
      ],
    });
  }
  const called = v.safeParse(CallSchema, message.params);
  if (called.success && called.output.name === "error") {
    return rpcError(message.id, -32_001, `invalid credential: ${sent}`);
  }
  return answer(message.id, {
    content: [
      { text: `you sent ${sent}`, type: "text" },
      { text: btoa(sent), type: "text" },
    ],
    structuredContent: { deep: { list: [sent, { again: `x${sent}x` }] } },
  });
}

/** An event stream that sends a notification, then fails before the answer arrives. */
function broken(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`
        )
      );
      controller.error(
        new DOMException("The operation timed out.", "TimeoutError")
      );
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Never answers: the response waits until the request is aborted, then fails with the abort's reason. */
async function slow(request: Request): Promise<Response> {
  // oxlint-disable-next-line promise/avoid-new -- this answer is settled from outside, by the relay's deadline.
  await new Promise<void>((_resolve, reject) => {
    request.signal.addEventListener("abort", () => {
      reject(new Error("the relay gave up"));
    });
  });
  return new Response(null, { status: 504 });
}

function huge(message: EdgeMessage): Response {
  const { cursor } = v.parse(CursorSchema, message.params);
  const page = cursor === undefined ? 0 : Number(cursor);
  return answer(message.id, {
    nextCursor: page + 1 < HUGE_PAGES ? String(page + 1) : "",
    tools: Array.from({ length: HUGE_PAGE_TOOLS }, (_, index) => ({
      description: "x".repeat(100_000),
      inputSchema: inputSchema(),
      name: `tool_${page}_${index}`,
    })),
  });
}

/** The answer of `https://edge.example` to one request. */
export async function edge(
  request: Request,
  message: EdgeMessage
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/echo") {
    return echo(request, message);
  }
  if (pathname === "/slow") {
    return await slow(request);
  }
  if (pathname === "/huge") {
    return huge(message);
  }
  if (message.rpc === "tools/list") {
    const names = pathname === "/dupe" ? ["x", "x", "y"] : ["tool"];
    return answer(message.id, {
      tools: names.map((name) => ({ inputSchema: inputSchema(), name })),
    });
  }
  if (pathname === "/bad") {
    return answer(message.id, { content: [], isError: "yes" });
  }
  if (pathname === "/broken") {
    return broken();
  }
  if (pathname === "/generic") {
    const called = v.safeParse(CallSchema, message.params);
    return called.success && called.output.name === "invalid"
      ? rpcError(message.id, -32_600, "Invalid Request")
      : rpcError(message.id, -32_000, "the tool failed");
  }
  return answer(message.id, { content: [] });
}
