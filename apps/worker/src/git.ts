/**
 * The shelf's repository over Git's smart HTTP protocol: `/git/{shelf}.git`, for `git clone`, `fetch`, and `push`,
 * and for APM installing from it. The Worker decides who may do what with the same auth module as every other
 * surface, then relays the exchange to the shelf's repository in Artifacts with a token it mints for that one
 * request, so a revoked key fails here at once and no Artifacts token ever reaches a client.
 *
 * A Git client presents a key as HTTP Basic (any user name, the key as the password) or as a Bearer header
 * (`git -c http.extraHeader="Authorization: Bearer <key>"`). Reading needs `read` on the shelf, or nothing on a public
 * shelf; pushing needs write access, as `shelfkit push` does, and the owner may push a shelf that does not exist yet.
 * After a push, the shelf's object indexes the new head (`ShelfIndex.syncRepository`), refusing a head the engine
 * cannot load. The browser's cookie is never read here.
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { authenticateHeader, existingShelf } from "./auth/index.ts";
import type { Session } from "./auth/index.ts";
import { problem } from "./http.ts";
import type { JobMessage } from "./jobs/messages.ts";
import { shelfRepository } from "./repository/index.ts";
import type { GitExchange } from "./repository/index.ts";

const ROUTE =
  /^\/git\/(?<shelf>[^/]+)\.git\/(?<rest>info\/refs|git-upload-pack|git-receive-pack)$/u;

/** The request headers a Git exchange needs, passed on to the repository. */
const FORWARDED = [
  "accept",
  "content-type",
  "content-encoding",
  "git-protocol",
];

/** `401` with the challenge a Git client answers with its credential helper. */
function challenge(detail: string): Response {
  return problem(401, "Unauthorized", detail, {
    "www-authenticate": 'Basic realm="shelfkit", charset="UTF-8"',
  });
}

/** What a request to the Git route asks for, once its path is read. */
interface GitRequest {
  readonly shelf: string;
  readonly service: "git-upload-pack" | "git-receive-pack";
  /** True for the ref advertisement (`GET info/refs`), false for the exchange itself (`POST <service>`). */
  readonly advertise: boolean;
}

/** Read the route's path, or answer why it is not one. */
function gitRequest(request: Request): GitRequest | Response {
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname)?.groups;
  const shelf = match?.shelf ?? "";
  const advertise = match?.rest === "info/refs";
  const service = advertise ? url.searchParams.get("service") : match?.rest;
  if (
    !v.is(ShelfIdSchema, shelf) ||
    (service !== "git-upload-pack" && service !== "git-receive-pack")
  ) {
    return problem(
      404,
      "Not Found",
      "a shelf's repository is /git/{shelf}.git, over Git's smart HTTP protocol"
    );
  }
  const expected = advertise ? "GET" : "POST";
  if (request.method !== expected) {
    return problem(405, "Method Not Allowed", undefined, { allow: expected });
  }
  return { advertise, service, shelf };
}

type ShelfStub = NonNullable<Awaited<ReturnType<typeof existingShelf>>>;

/**
 * Whether `session` may make this exchange: read what it may read, push where it may write, and, as the owner, push a
 * shelf that does not exist yet. Answers the refusal, or null.
 */
async function refusal(
  session: Session,
  wanted: GitRequest,
  existing: ShelfStub | null
): Promise<Response | null> {
  const write = wanted.service === "git-receive-pack";
  let allowed = write && session.kind === "owner";
  if (existing !== null) {
    allowed = write
      ? await existing.mayUpload(session, wanted.shelf)
      : await existing.mayReadRepository(session, wanted.shelf);
  }
  if (allowed) {
    return null;
  }
  if (session.kind === "anonymous") {
    return challenge("this shelf's repository needs a key");
  }
  return write && existing !== null
    ? problem(403, "Forbidden", "this key cannot push to this shelf")
    : problem(404, "Not Found", "there is no such shelf");
}

/** The exchange to relay: the request's Git headers and body, and nothing else it carries. */
function exchangeOf(request: Request, wanted: GitRequest): GitExchange {
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return {
    body: wanted.advertise ? null : request.body,
    headers,
    method: wanted.advertise ? "GET" : "POST",
    path: wanted.advertise
      ? `info/refs?service=${wanted.service}`
      : wanted.service,
    scope: wanted.service === "git-receive-pack" ? "write" : "read",
  };
}

export async function gitRoute(
  request: Request,
  env: Env,
  context: ExecutionContext
): Promise<Response> {
  const wanted = gitRequest(request);
  if (wanted instanceof Response) {
    return wanted;
  }
  const repository = shelfRepository(env);
  if (repository === null) {
    return problem(
      404,
      "Not Found",
      "this deployment keeps no repositories: it runs without Artifacts"
    );
  }
  const session = await authenticateHeader(request, env);
  if (session.kind === "invalid") {
    return challenge(
      "the key is not valid: it is malformed, unknown, or revoked"
    );
  }
  const existing = await existingShelf(env, wanted.shelf);
  const refused = await refusal(session, wanted, existing);
  if (refused !== null) {
    return refused;
  }
  const exchange = exchangeOf(request, wanted);
  let upstream = await repository.exchange(wanted.shelf, exchange);
  if (upstream === null && existing !== null) {
    // A shelf indexed before the deployment had Artifacts: commit its files to a new repository, then read that.
    await existing.syncRepository(
      { job: "repository.sync", kind: "system" },
      wanted.shelf
    );
    upstream = await repository.exchange(wanted.shelf, exchange);
  }
  if (upstream === null) {
    return problem(404, "Not Found", "the shelf has no repository yet");
  }
  const pushed = !wanted.advertise && wanted.service === "git-receive-pack";
  return relayed(upstream, env, context, wanted.shelf, pushed);
}

/** The repository's answer, as the client receives it; after a push, the shelf's object indexes the new head. */
function relayed(
  upstream: Response,
  env: Env,
  context: ExecutionContext,
  shelf: string,
  pushed: boolean
): Response {
  const headers = new Headers({ "cache-control": "no-cache" });
  const type = upstream.headers.get("content-type");
  if (type !== null) {
    headers.set("content-type", type);
  }
  if (!pushed || !upstream.ok || upstream.body === null) {
    return new Response(upstream.body, { headers, status: upstream.status });
  }
  // The push is done when the repository has sent its whole report; only then is the new head there to index.
  const [toClient, watched] = upstream.body.tee();
  const sync: JobMessage = { shelf, type: "repository.sync" };
  context.waitUntil(
    (async () => {
      await new Response(watched).arrayBuffer();
      await env.JOBS.send(sync);
    })()
  );
  return new Response(toClient, { headers, status: upstream.status });
}
