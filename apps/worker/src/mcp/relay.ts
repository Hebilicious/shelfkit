/**
 * The narrow relay (`docs/PRD.md` sections 8.1 and 8.2): a hosted MCP item's tools, called through ShelfKit so that
 * the server's credential lives in one place instead of in every client config.
 *
 * - **Which shelf.** A key relays its own shelf's items. The owner names the shelf with `/mcp?shelf=<id>`; without it,
 *   the owner relays nothing, because names carry no shelf and two shelves may hold items with the same id. An
 *   anonymous caller relays nothing.
 * - **Which items.** `relayable` lists only the hosted items the key was granted (`mcp:{shelf}/{item}`), so a key never
 *   discovers a backend it was not given. An item's `tools`, when it declares them, are the only tools relayed.
 * - **Credentials.** `relayHeaders` resolves each `{ "secret": NAME }` inside the shelf's object, for the item's own
 *   origin only. When one does not resolve, the item is left out of the list and a call to it is refused: the relay
 *   never calls a server without its credential. Resolved headers go to the server and are never returned.
 * - **No state.** Every list and call opens a client for that request alone (`upstream.ts`) and closes it before
 *   answering. Nothing is cached between requests, not even a tool list.
 */
import * as v from "valibot";

import type { Session } from "../auth/index.ts";
import { existingShelf } from "../auth/index.ts";
import type { Relay, RelayedResult, RelayedTool } from "./compose.ts";
import { NO_RELAY } from "./compose.ts";
import { parseRelayedName, relayedName } from "./names.ts";
import { openUpstream, UpstreamError } from "./upstream.ts";
import type { Fetcher, Upstream, UpstreamTarget } from "./upstream.ts";
import {
  ToolPageSchema,
  ToolResultSchema,
  UpstreamToolSchema,
} from "./wire.ts";
import type { JsonObject } from "./wire.ts";

/** How many pages of an upstream `tools/list` the relay follows. */
const MAXIMUM_PAGES = 10;

/** A granted hosted item, as the relay needs it. */
interface Granted {
  readonly title: string;
  /** The tools the item declares, or `null` to relay every tool its server lists. */
  readonly declared: readonly string[] | null;
}

/** Where the relay may send a call, or why it may not. */
type Target =
  | { readonly target: UpstreamTarget }
  | { readonly refused: string };

/** What a request relays with. */
export interface RelayRequest {
  readonly env: Env;
  readonly session: Session;
  /** The shelf whose items are relayed, from `relayShelf`. */
  readonly shelf: string | null;
  readonly fetcher: Fetcher;
  /** ShelfKit's version, which an older server's handshake is told. */
  readonly version: string;
}

/** The shelf whose items a request relays, or `null` for none. */
export function relayShelf(request: Request, session: Session): string | null {
  const named = new URL(request.url).searchParams.get("shelf");
  if (session.kind === "key") {
    return named === null || named === session.shelf ? session.shelf : null;
  }
  return session.kind === "owner" ? named : null;
}

/** The relay of one request. */
export async function relayFor(relaying: RelayRequest): Promise<Relay> {
  const { env, fetcher, session, shelf, version } = relaying;
  const stub = shelf === null ? null : await existingShelf(env, shelf);
  if (shelf === null || stub === null) {
    return NO_RELAY;
  }
  const object = stub;
  const shelfId = shelf;

  async function grantedItems(): Promise<Map<string, Granted>> {
    const relayable = await object.relayable(session, shelfId);
    return new Map(
      (relayable?.servers ?? []).map((server) => [
        server.id,
        { declared: server.tools ?? null, title: server.title },
      ])
    );
  }

  /** Where to call `item`, with its credentials resolved in the object, or why the relay may not. */
  async function target(item: string): Promise<Target> {
    const answer = await object.relayHeaders(session, shelfId, item);
    return answer.ok
      ? { target: answer.value }
      : { refused: answer.failure.message };
  }

  async function withUpstream<T>(
    found: UpstreamTarget,
    use: (upstream: Upstream) => Promise<T>
  ): Promise<T> {
    const upstream = openUpstream(found, fetcher, version);
    try {
      return await use(upstream);
    } finally {
      await upstream.close();
    }
  }

  async function listItem(
    item: string,
    granted: Granted,
    signal: AbortSignal
  ): Promise<RelayedTool[]> {
    const found = await target(item);
    if ("refused" in found) {
      return [];
    }
    const tools = await withUpstream(
      found.target,
      async (upstream) => await listPages(upstream, signal)
    );
    return tools.flatMap((listed) => {
      const tool = v.safeParse(UpstreamToolSchema, listed);
      if (
        !tool.success ||
        (granted.declared !== null &&
          !granted.declared.includes(tool.output.name))
      ) {
        return [];
      }
      const relayed = relayedTool(item, granted.title, tool.output);
      return relayed === null ? [] : [relayed];
    });
  }

  async function callItem(
    item: string,
    tool: string,
    input: JsonObject,
    signal: AbortSignal
  ): Promise<RelayedResult> {
    const found = await target(item);
    if ("refused" in found) {
      return refusal(`the relay refused to call \`${item}\`: ${found.refused}`);
    }
    try {
      const answer = await withUpstream(
        found.target,
        async (upstream) =>
          await upstream.request(
            "tools/call",
            { arguments: input, name: tool },
            signal
          )
      );
      if ("error" in answer) {
        return refusal(
          `\`${item}\` answered with an error (${answer.error.code}): ${answer.error.message}`
        );
      }
      return v.parse(ToolResultSchema, answer.result);
    } catch (error) {
      if (error instanceof UpstreamError) {
        return refusal(`\`${item}\`: ${error.message}`);
      }
      throw error;
    }
  }

  return {
    async call(name, input, signal) {
      const parsed = parseRelayedName(name);
      if (parsed === null) {
        return null;
      }
      const items = await grantedItems();
      const granted = items.get(parsed.item);
      if (
        granted === undefined ||
        (granted.declared !== null && !granted.declared.includes(parsed.tool))
      ) {
        return null;
      }
      return await callItem(parsed.item, parsed.tool, input, signal);
    },

    async list(signal) {
      const items = await grantedItems();
      const lists = await Promise.all(
        [...items].map(async ([item, granted]) => {
          try {
            return await listItem(item, granted, signal);
          } catch {
            // A server that cannot be reached or refuses its credential lists nothing this time.
            return [];
          }
        })
      );
      return lists.flat();
    },
  };
}

/** Every page of a relayed server's `tools/list`, up to `MAXIMUM_PAGES`. */
async function listPages(
  upstream: Upstream,
  signal: AbortSignal
): Promise<unknown[]> {
  const tools: unknown[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const params: JsonObject = cursor === undefined ? {} : { cursor };
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page names the next.
    const answer = await upstream.request("tools/list", params, signal);
    if ("error" in answer) {
      throw new UpstreamError(answer.error.message);
    }
    const listed = v.parse(ToolPageSchema, answer.result);
    tools.push(...listed.tools);
    if (listed.nextCursor === undefined || listed.nextCursor === "") {
      break;
    }
    cursor = listed.nextCursor;
  }
  return tools;
}

/** One upstream tool, namespaced as `<item>__<tool>`, or `null` when that would not be a valid MCP tool name. */
function relayedTool(
  item: string,
  title: string,
  tool: RelayedTool
): RelayedTool | null {
  const name = relayedName(item, tool.name);
  if (name === null) {
    return null;
  }
  const from = `Relayed by ShelfKit from ${title} (\`${item}\`).`;
  return {
    ...tool,
    description:
      tool.description === undefined ? from : `${from} ${tool.description}`,
    name,
  };
}

/** A refusal the agent can read, as a tool result, the way AcidCat gives a call failure. */
function refusal(message: string): RelayedResult {
  return {
    content: [
      { text: JSON.stringify({ kind: "unavailable", message }), type: "text" },
    ],
    isError: true,
  };
}
