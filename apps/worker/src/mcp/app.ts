/**
 * ShelfKit's own MCP tools: the frozen descriptors of `packages/schema/src/capabilities.ts`, each given a `run` that is
 * one call on the named shelf's object. The object checks the session again and answers with the capability's output
 * or one of its failures, already in AcidCat's shape, so `run` only passes the answer on.
 *
 * The context is made per request from the authenticated session, and the tools a session lists are computed from its
 * key (`docs/PRD.md` section 8.1, rule 2):
 *
 * - the five reading tools, for the owner, an anonymous caller (public shelves only), and a key that reads the shelf
 *   (`read` or `publish:{shelf}/*`). A key holding only `mcp:` relay grants sees its relayed tools and nothing else
 *   (rule 4), and a `read:{shelf}/{profile}` key is registry-only;
 * - `shelf.report`, for the owner and a key that may publish a profile. A `publish:{shelf}/{profile}` key lists only
 *   this tool: it reports on its profile and cannot read the shelf.
 *
 * Availability narrows the list; it is not what protects a shelf. The object decides every call.
 */
import {
  AVAILABLE,
  capabilitiesFor,
  defineApp,
  unavailable,
} from "@acid-cat/core-ts";
import type { Availability, Observable, Result } from "@acid-cat/core-ts";
import {
  catalog,
  shelfCompilePlan,
  shelfItemGet,
  shelfProfileGet,
  shelfRecommend,
  shelfReport,
  shelfSearch,
} from "@shelfkit/schema";

import { existingShelf } from "../auth/index.ts";
import type { Session } from "../auth/index.ts";
import { parseScopes } from "../auth/scopes.ts";
import type { Outcome, ShelfNotFound } from "../shelf/api.ts";

/** What one request's capabilities run with. */
export interface McpContext {
  readonly env: Env;
  /** Never `invalid`: the Worker answered `401` before the handler ran. */
  readonly session: Session;
}

/** What a session's key lets it use over MCP, before any shelf is named. */
export interface ToolAccess {
  /** The five reading tools. */
  readonly reads: boolean;
  /** `shelf.report`. */
  readonly reports: boolean;
}

export function toolAccess(session: Session): ToolAccess {
  if (session.kind === "owner" || session.kind === "system") {
    return { reads: true, reports: true };
  }
  if (session.kind !== "key") {
    return { reads: session.kind === "anonymous", reports: false };
  }
  const kinds = new Set(
    parseScopes(session.shelf, session.scopes).map((scope) => scope.kind)
  );
  // `publish:{shelf}/{profile}` reports on its profile and reads nothing; `publish:{shelf}/*` writes the shelf.
  return {
    reads: kinds.has("read") || kinds.has("publish-all"),
    reports: kinds.has("publish") || kinds.has("publish-all"),
  };
}

function constant(availability: Availability): Observable<Availability> {
  return {
    getSnapshot: () => availability,
    subscribe: () => ({
      unsubscribe: () => {
        // A constant never changes, so there is nothing to stop.
      },
    }),
  };
}

const forReaders = (context: McpContext) =>
  constant(
    toolAccess(context.session).reads
      ? AVAILABLE
      : unavailable("this key reads no shelf over MCP")
  );

const forReporters = (context: McpContext) =>
  constant(
    toolAccess(context.session).reports
      ? AVAILABLE
      : unavailable("reporting needs a key that may publish a profile")
  );

/** The object's answer as AcidCat's result. */
function result<T, F>(outcome: Outcome<T, F>): Result<T, F> {
  return outcome.ok
    ? { ok: true, value: outcome.value }
    : { error: outcome.failure, ok: false };
}

function shelfNotFound(shelf: string): Result<never, ShelfNotFound> {
  return {
    error: {
      _tag: "ShelfNotFound",
      message: `there is no shelf \`${shelf}\` this key can read`,
      shelf,
    },
    ok: false,
  };
}

/** The shelf's object, or `null` without creating one when the deployment does not hold the shelf. */
async function shelfObject(context: McpContext, shelf: string) {
  return await existingShelf(context.env, shelf);
}

const capability = capabilitiesFor<McpContext>();

export const shelfApp = defineApp<McpContext>({
  ...catalog,
  capabilities: [
    capability({
      ...shelfSearch,
      availability: forReaders,
      run: async ({ shelf, ...input }, { context }) => {
        const object = await shelfObject(context, shelf);
        return object === null
          ? shelfNotFound(shelf)
          : result(await object.search(context.session, shelf, input));
      },
    }),
    capability({
      ...shelfRecommend,
      availability: forReaders,
      run: async ({ markers, shelf }, { context }) => {
        const object = await shelfObject(context, shelf);
        return object === null
          ? shelfNotFound(shelf)
          : result(await object.recommend(context.session, shelf, markers));
      },
    }),
    capability({
      ...shelfProfileGet,
      availability: forReaders,
      run: async ({ profile, shelf }, { context }) => {
        const object = await shelfObject(context, shelf);
        return object === null
          ? shelfNotFound(shelf)
          : result(await object.getProfile(context.session, shelf, profile));
      },
    }),
    capability({
      ...shelfItemGet,
      availability: forReaders,
      run: async ({ item, shelf }, { context }) => {
        const object = await shelfObject(context, shelf);
        return object === null
          ? shelfNotFound(shelf)
          : result(await object.getItem(context.session, shelf, item));
      },
    }),
    capability({
      ...shelfCompilePlan,
      availability: forReaders,
      run: async ({ profile, shelf }, { context }) => {
        const object = await shelfObject(context, shelf);
        return object === null
          ? shelfNotFound(shelf)
          : result(await object.planCompile(context.session, shelf, profile));
      },
    }),
    capability({
      ...shelfReport,
      availability: forReporters,
      run: async ({ shelf, ...input }, { context }) => {
        const object = await shelfObject(context, shelf);
        return object === null
          ? shelfNotFound(shelf)
          : result(await object.report(context.session, shelf, input));
      },
    }),
  ],
});
