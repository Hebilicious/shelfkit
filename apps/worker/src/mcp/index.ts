/**
 * The MCP endpoint, `/mcp`: issue #6 fills this in. It is a stateless fetch handler on MCP spec revision 2026-07-28,
 * serving the six capabilities in `packages/schema/src/capabilities.ts` through AcidCat's MCP binding, plus the
 * narrow relay. No sessions, nothing held between calls, and no server code of a shelf is ever run.
 *
 * What it builds on, all outside this directory and frozen:
 *
 * - The Worker has already authenticated the request (`src/auth/index.ts`): `session` is never `invalid`, because an
 *   unknown, malformed, or revoked key is answered `401` before this handler runs. It may be `anonymous`, which reads
 *   public shelves only.
 * - Each capability is one call on the shelf's object (`src/shelf-index.ts`), addressed by the input's `shelf` with
 *   `shelfStub(env, shelf)`: `search`, `recommend`, `getProfile`, `getItem`, `planCompile`, and `report`, each taking
 *   `(session, shelf, input)` and answering `{ ok: true, value }` with the capability's output or `{ ok: false,
 *   failure }` with one of its failures. A shelf the session cannot read answers `ShelfNotFound`.
 * - The relay: a hosted MCP item is one whose item.json has `"flavour": "hosted"`. A session may call its tools when
 *   `mayRelay(access(session, shelf, isPublic), item)` holds: the owner, or a key with the scope `mcp:{shelf}/{item}`
 *   (`src/auth/scopes.ts`). Tools are namespaced `<item>__<tool>`. The item's `headers` values that are `{ "secret":
 *   "NAME" }` resolve with `resolveSecret` (`src/secrets.ts`), and never reach the caller.
 */
import type { Session } from "../auth/index.ts";
import { problem } from "../http.ts";

/** The `/mcp` handler. `session` is authenticated and never `invalid`. */
// oxlint-disable-next-line eslint/require-await -- the handler issue #6 writes awaits the shelf's object.
export async function handleMcp(
  request: Request,
  _env: Env,
  _context: ExecutionContext,
  _session: Session
): Promise<Response> {
  return problem(
    501,
    "Not Implemented",
    `the MCP endpoint is not served yet (${request.method} ${new URL(request.url).pathname})`
  );
}
