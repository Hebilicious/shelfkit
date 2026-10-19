/**
 * A client for one relayed server, alive for one `/mcp` request and discarded with it.
 *
 * It speaks MCP revision 2026-07-28 first, which keeps no state: each message carries its revision, and there is no
 * handshake. A server that only knows an older revision of the streamable HTTP transport refuses that, and the client
 * then does the older handshake (`initialize`, `notifications/initialized`) inside the same request, makes its calls
 * under the session the server hands out, and ends that session before the request completes. Nothing about a server
 * survives the request: no session, no negotiated revision, no cached tool list.
 *
 * The credentials in `headers` go to the server and nowhere else. Redirects are not followed, because following one
 * would send them to whatever origin the server names, and nothing the server sends back in its headers reaches the
 * caller: the relay only reads JSON-RPC bodies.
 */
import * as v from "valibot";

import {
  AnswerSchema,
  InitializeResultSchema,
  readJson,
  VERSION_META,
} from "./wire.ts";
import type { Answer, Id, JsonObject } from "./wire.ts";

/** The revision ShelfKit speaks. */
export const PROTOCOL_VERSION = "2026-07-28";

/** The older revision the fallback handshake asks for; a server answers with the one it agrees to. */
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";

/** How long one relayed request may take, beside the caller's own cancellation. */
const DEADLINE_MS = 30_000;

/** How long ending an older revision's session may take. */
const CLOSE_DEADLINE_MS = 5000;

/** The most a relayed answer may be, in bytes. */
const MAXIMUM_ANSWER_BYTES = 4 * 1024 * 1024;

/** JSON-RPC errors a 2026-07-28 server or an older one gives for a request it cannot take without a handshake. */
const NEEDS_HANDSHAKE = new Set([-32_000, -32_020, -32_022, -32_600]);

/** HTTP statuses an older server gives, with no JSON-RPC answer, to a request that skipped the handshake. */
const REFUSED_WITHOUT_HANDSHAKE = new Set([400, 404, 405, 406]);

/** Where to call, and with what credentials. */
export interface UpstreamTarget {
  readonly url: string;
  readonly transport: "http" | "sse" | "streamable-http";
  /** Sent to `url` only. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The server could not be reached or would not answer; the message is for the agent and holds no credential. */
export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
}

export type Fetcher = (request: Request) => Promise<Response>;

export interface Upstream {
  /** Send one request and wait for its answer. */
  readonly request: (
    method: string,
    params: JsonObject,
    signal: AbortSignal
  ) => Promise<Answer>;
  /** End the older revision's session, if one was opened. */
  readonly close: () => Promise<void>;
}

/** The older revision's session, for the rest of one request. */
interface LegacySession {
  readonly session: string | null;
  readonly version: string;
}

/** One JSON-RPC message the client sends: a request with an `id`, or a notification without. */
interface Outgoing {
  readonly id?: number;
  readonly method: string;
  readonly params?: JsonObject;
}

interface Posted {
  readonly response: Response;
  readonly answer: Answer | null;
}

/** Open a client for one request. Nothing is sent until the first call. */
export function openUpstream(
  target: UpstreamTarget,
  fetcher: Fetcher,
  clientVersion: string
): Upstream {
  if (target.transport === "sse") {
    // The HTTP+SSE transport needs a long-lived GET stream per client: a session in all but name.
    return refusing(
      "the relay speaks streamable HTTP, and this server declares the older HTTP+SSE transport; configure it in the client directly"
    );
  }
  let legacy: LegacySession | null = null;
  let ids = 0;

  async function post(
    message: Outgoing,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal
  ): Promise<Posted> {
    const response = await send(
      fetcher,
      new Request(target.url, {
        body: JSON.stringify({ jsonrpc: "2.0", ...message }),
        headers: {
          ...target.headers,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...headers,
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]),
      })
    );
    if (message.id === undefined) {
      await response.body?.cancel();
      return { answer: null, response };
    }
    return { answer: await readAnswer(response, message.id), response };
  }

  async function handshake(signal: AbortSignal): Promise<LegacySession> {
    ids += 1;
    const { answer, response } = await post(
      {
        id: ids,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "shelfkit-relay", version: clientVersion },
          protocolVersion: LEGACY_PROTOCOL_VERSION,
        },
      },
      {},
      signal
    );
    if (answer === null || "error" in answer) {
      const reason = answer === null ? "" : `: ${answer.error.message}`;
      throw new UpstreamError(
        `the server refused the MCP handshake (HTTP ${response.status}${reason})`
      );
    }
    const agreed = v.safeParse(InitializeResultSchema, answer.result);
    const opened = {
      session: response.headers.get("mcp-session-id"),
      version:
        (agreed.success ? agreed.output.protocolVersion : undefined) ??
        LEGACY_PROTOCOL_VERSION,
    };
    await post(
      { method: "notifications/initialized" },
      legacyHeaders(opened),
      signal
    );
    return opened;
  }

  return {
    async close() {
      const session = legacy?.session ?? null;
      legacy = null;
      if (session === null) {
        return;
      }
      try {
        const response = await send(
          fetcher,
          new Request(target.url, {
            headers: { ...target.headers, "mcp-session-id": session },
            method: "DELETE",
            redirect: "manual",
            signal: AbortSignal.timeout(CLOSE_DEADLINE_MS),
          })
        );
        await response.body?.cancel();
      } catch {
        // The server keeps a session it would have dropped anyway; the relay keeps nothing.
      }
    },

    async request(method, params, signal) {
      if (legacy === null) {
        ids += 1;
        const modern = await post(
          {
            id: ids,
            method,
            params: { ...params, _meta: { [VERSION_META]: PROTOCOL_VERSION } },
          },
          { "mcp-protocol-version": PROTOCOL_VERSION },
          signal
        );
        if (!needsHandshake(modern)) {
          return answerOf(modern);
        }
        legacy = await handshake(signal);
      }
      ids += 1;
      return answerOf(
        await post({ id: ids, method, params }, legacyHeaders(legacy), signal)
      );
    },
  };
}

function refusing(message: string): Upstream {
  return {
    close: async () => {
      // Nothing was opened.
    },
    // oxlint-disable-next-line eslint/require-await -- it refuses at once, as a rejected call.
    request: async () => {
      throw new UpstreamError(message);
    },
  };
}

function legacyHeaders(legacy: LegacySession): Record<string, string> {
  return legacy.session === null
    ? { "mcp-protocol-version": legacy.version }
    : {
        "mcp-protocol-version": legacy.version,
        "mcp-session-id": legacy.session,
      };
}

/** Whether a server answered the stateless request in a way that says it wants the older handshake. */
function needsHandshake({ answer, response }: Posted): boolean {
  if (answer === null) {
    return REFUSED_WITHOUT_HANDSHAKE.has(response.status);
  }
  return "error" in answer && NEEDS_HANDSHAKE.has(answer.error.code);
}

function answerOf({ answer, response }: Posted): Answer {
  if (answer !== null) {
    return answer;
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError(
      `the server refused the relay's credential (HTTP ${response.status})`
    );
  }
  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError(
      `the server answered with a redirect (HTTP ${response.status}), which the relay does not follow`
    );
  }
  throw new UpstreamError(
    `the server gave no MCP answer (HTTP ${response.status})`
  );
}

async function send(fetcher: Fetcher, request: Request): Promise<Response> {
  try {
    return await fetcher(request);
  } catch (error) {
    if (request.signal.aborted) {
      throw new UpstreamError("the server did not answer in time", {
        cause: error,
      });
    }
    throw new UpstreamError("the server could not be reached", {
      cause: error,
    });
  }
}

/**
 * The JSON-RPC answer with `id` in a response: a JSON body, or the event with that id in an event stream, read only
 * until it arrives. `null` when the body is neither.
 */
async function readAnswer(response: Response, id: Id): Promise<Answer | null> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) {
    return null;
  }
  const type = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type === "text/event-stream") {
    return await readEventStream(body, id);
  }
  if (type !== "application/json") {
    await body.cancel();
    return null;
  }
  return answerIn(await readText(body), id);
}

/** The body as text, or `null` when it is longer than an answer may be. */
async function readText(
  body: ReadableStream<Uint8Array>
): Promise<string | null> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  let length = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a body arrives a chunk at a time, each after the last.
    const chunk = await reader.read();
    if (chunk.done) {
      return text + decoder.decode();
    }
    length += chunk.value.byteLength;
    if (length > MAXIMUM_ANSWER_BYTES) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the read ends here; this is its last await.
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/** The answer to `id` among a stream's events, read until it arrives; the rest of the stream is cancelled. */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  id: Id
): Promise<Answer | null> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  let length = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- events arrive one after another; the answer ends the read.
      const chunk = await reader.read();
      if (chunk.done) {
        return answerIn(eventData(buffered + decoder.decode()), id);
      }
      length += chunk.value.byteLength;
      if (length > MAXIMUM_ANSWER_BYTES) {
        return null;
      }
      buffered = (
        buffered + decoder.decode(chunk.value, { stream: true })
      ).replaceAll("\r\n", "\n");
      const events = buffered.split("\n\n");
      buffered = events.pop() ?? "";
      const answer = events
        .map((event) => answerIn(eventData(event), id))
        .find((found) => found !== null);
      if (answer !== undefined) {
        return answer;
      }
    }
  } finally {
    await reader.cancel().catch(() => null);
  }
}

/** The data of one server-sent event: its `data:` lines, joined. */
function eventData(event: string): string {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /u, ""))
    .join("\n");
}

/** The answer to `id` in one JSON-RPC message, or `null` when the text is not that. */
function answerIn(text: string | null, id: Id): Answer | null {
  if (text === null || text === "") {
    return null;
  }
  const parsed = readJson(AnswerSchema, text);
  return parsed?.success === true && parsed.output.id === id
    ? parsed.output
    : null;
}
