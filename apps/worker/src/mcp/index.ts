/**
 * The MCP endpoint, `/mcp` (`docs/PRD.md` section 8): a stateless fetch handler on MCP revision 2026-07-28.
 *
 * - ShelfKit's six tools (`app.ts`) are AcidCat capabilities, served by AcidCat's MCP binding and named by their ids:
 *   `shelf.search`, `shelf.recommend`, `shelf.profile.get`, `shelf.item.get`, `shelf.compile.plan`, `shelf.report`.
 *   Each call is one call on the named shelf's object, which checks the session again.
 * - The narrow relay (`relay.ts`) sits beside them at the same URL, with tools named `<item>__<tool>` (`names.ts`),
 *   composed so that the namespaces cannot meet (`compose.ts`).
 * - MCP definitions are the product: `shelf.search` with `kinds: ["mcp"]` lists a shelf's servers, and
 *   `shelf.item.get` gives each one's whole definition (transport, command and arguments or URL, and its environment
 *   and headers with secrets by name), so an agent configures and runs a server in its own environment. A `stdio`
 *   item is a definition the agent runs; ShelfKit never runs a shelf's server code, in any form.
 *
 * Nothing is held between requests: no MCP session, no Durable Object handshake, no upstream connection, no cache.
 *
 * The Worker has authenticated the request before this runs (`src/auth/index.ts`): `session` is never `invalid`,
 * because an unknown, malformed, or revoked key is answered `401` first. It may be `anonymous`, which reads public
 * shelves only and relays nothing.
 */
import { toCatalogJsonSchema } from "@shelfkit/schema/json-schema";

import type { Session } from "../auth/index.ts";
import { shelfApp } from "./app.ts";
import { serveMcp } from "./compose.ts";
import { relayFor, relayShelf } from "./relay.ts";

/**
 * The composition `handleMcp` serves. `acid-cat conform` imports it from here (`test/mcp/conform.node.ts`), so the
 * conformance run and the endpoint cannot use different code.
 */
export { serveMcp } from "./compose.ts";

/** The relay's way out: the platform's `fetch`, looked up when a request runs. */
async function platformFetch(request: Request): Promise<Response> {
  return await fetch(request);
}

/** The name the endpoint gives itself in `serverInfo`. */
export const SERVER_NAME = "shelfkit";

/** The `/mcp` handler. `session` is authenticated and never `invalid`. */
export async function handleMcp(
  request: Request,
  env: Env,
  _context: ExecutionContext,
  session: Session
): Promise<Response> {
  return await serveMcp(shelfApp, {
    // A browser may call only from the Worker's own origin; agents send no `Origin`.
    allowedOrigins: [new URL(request.url).origin],
    createContext: () => ({ env, session }),
    name: SERVER_NAME,
    relay: async () =>
      await relayFor({
        env,
        fetcher: platformFetch,
        session,
        shelf: relayShelf(request, session),
        version: env.SHELFKIT_VERSION,
      }),
    toJsonSchema: toCatalogJsonSchema,
    version: env.SHELFKIT_VERSION,
  })(request);
}
