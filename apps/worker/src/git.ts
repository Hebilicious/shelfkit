/**
 * The shelf's repository over Git's smart HTTP protocol: `/git/{shelf}.git`, for `git clone`, `fetch`, and `push`,
 * and for APM installing from it. The Worker decides who may do what with the same auth module as every other
 * surface, then relays the exchange to the shelf's repository in Artifacts with a token it mints for that one request,
 * so a revoked key fails here at once and no Artifacts token ever reaches a client.
 *
 * Git is the one way a checkout's files reach a hosted shelf. A shelf that is a repository of its own pushes and pulls
 * here; a shelf inside a larger repository is a submodule of this one.
 *
 * A Git client presents a key as HTTP Basic (any user name, the key as the password) or as a Bearer header
 * (`git -c http.extraHeader="Authorization: Bearer <key>"`). Reading needs `read` on the shelf, or nothing on a public
 * shelf; pushing needs write access, and the owner may push a shelf that does not exist yet.
 * After a push, the shelf's object indexes the new head (`ShelfIndex.syncRepository`), refusing a head the engine
 * cannot load. The browser's cookie is never read here.
 *
 * `/git/{shelf}/{profile}.git` is a published profile's own repository (`src/packages.ts`), the Artifacts repository
 * `<shelf>.<profile>`: every version the registry published, tagged `v{version}`, which APM installs with a version
 * range and no experimental flag. It is cloned and fetched, never pushed: publishing writes it. Reading it needs what
 * reading the package from the registry needs, and the exchange is relayed with a read token, as a shelf's is.
 */
import { ProfileIdSchema, ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { authenticateHeader, existingShelf, shelfStub } from "./auth/index.ts";
import type { Session } from "./auth/index.ts";
import { problem } from "./http.ts";
import type { JobMessage } from "./jobs/messages.ts";
import { commitVersions, packageRepositoryName } from "./packages.ts";
import { shelfRepository } from "./repository/index.ts";
import type { GitExchange } from "./repository/index.ts";

const ROUTE =
  /^\/git\/(?<shelf>[^/]+)\.git\/(?<rest>info\/refs|git-upload-pack|git-receive-pack)$/u;

const PACKAGE_ROUTE =
  /^\/git\/(?<shelf>[^/]+)\/(?<profile>[^/]+)\.git\/(?<rest>info\/refs|git-upload-pack|git-receive-pack)$/u;

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
      ? await existing.mayCommit(session, wanted.shelf)
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

export async function gitRoute(request: Request, env: Env): Promise<Response> {
  const published = PACKAGE_ROUTE.exec(new URL(request.url).pathname)?.groups;
  if (published !== undefined) {
    return await packageRoute(request, env, published);
  }
  const wanted = gitRequest(request);
  if (wanted instanceof Response) {
    return wanted;
  }
  const repository = shelfRepository(env);
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
  const upstream = await repository.exchange(
    wanted.shelf,
    exchangeOf(request, wanted)
  );
  if (upstream === null) {
    return problem(404, "Not Found", "the shelf has no repository yet");
  }
  const pushed = !wanted.advertise && wanted.service === "git-receive-pack";
  return await relayed(upstream, env, wanted.shelf, pushed);
}

/**
 * The repository's answer, as the client receives it. A push is indexed before the client hears that it landed, so a
 * `git push` that returns is on the shelf.
 */
async function relayed(
  upstream: Response,
  env: Env,
  shelf: string,
  pushed: boolean
): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-cache" });
  const type = upstream.headers.get("content-type");
  if (type !== null) {
    headers.set("content-type", type);
  }
  if (!pushed || !upstream.ok || upstream.body === null) {
    return new Response(upstream.body, { headers, status: upstream.status });
  }
  // The push is done when the repository has sent its whole report; only then is the new head there to index. The
  // sync is queued first, so an index that fails is retried, and then run here, because a Worker Preview runs no queue
  // consumer. Elsewhere the job then finds the shelf current.
  const report = await upstream.arrayBuffer();
  const sync: JobMessage = { shelf, type: "repository.sync" };
  await env.JOBS.send(sync);
  try {
    await shelfStub(env, shelf).syncRepository(
      { job: sync.type, kind: "system" },
      shelf
    );
  } catch (error) {
    console.error(
      `indexing ${shelf}'s new head failed; the queued sync retries it`,
      error
    );
  }
  return new Response(report, { headers, status: upstream.status });
}

/** What a request to a published profile's repository asks for, once its path is read. */
interface PackageRequest {
  readonly shelf: string;
  readonly profile: string;
  readonly advertise: boolean;
}

/** Read a published profile repository's path: clone and fetch only, never a push. Or answer why not. */
function packageRequest(
  request: Request,
  path: Readonly<Record<string, string | undefined>>
): PackageRequest | Response {
  const shelf = path.shelf ?? "";
  const profile = path.profile ?? "";
  const advertise = path.rest === "info/refs";
  const service = advertise
    ? new URL(request.url).searchParams.get("service")
    : path.rest;
  if (service === "git-receive-pack") {
    return problem(
      403,
      "Forbidden",
      "a published profile's repository is written by publishing the profile (`shelfkit publish`), not by a push"
    );
  }
  if (
    !v.is(ShelfIdSchema, shelf) ||
    !v.is(ProfileIdSchema, profile) ||
    service !== "git-upload-pack"
  ) {
    return problem(
      404,
      "Not Found",
      "a published profile's repository is /git/{shelf}/{profile}.git, over Git's smart HTTP protocol"
    );
  }
  const expected = advertise ? "GET" : "POST";
  if (request.method !== expected) {
    return problem(405, "Method Not Allowed", undefined, { allow: expected });
  }
  return { advertise, profile, shelf };
}

/** The refusal a Git client gets for the registry's: a challenge it answers with its credential helper, or the status. */
function packageRefusal(status: number): Response {
  if (status === 401) {
    return challenge("this profile's repository needs a key");
  }
  return status === 403
    ? problem(403, "Forbidden", "this key cannot read this profile")
    : problem(404, "Not Found", "this shelf has published no such profile");
}

/**
 * A published profile's repository: clone and fetch only. The registry decides who may read it, as it decides for the
 * package's list of versions; the repository first commits every version it lacks.
 */
async function packageRoute(
  request: Request,
  env: Env,
  path: Readonly<Record<string, string | undefined>>
): Promise<Response> {
  const wanted = packageRequest(request, path);
  if (wanted instanceof Response) {
    return wanted;
  }
  const { advertise, profile, shelf } = wanted;
  const session = await authenticateHeader(request, env);
  if (session.kind === "invalid") {
    return challenge(
      "the key is not valid: it is malformed, unknown, or revoked"
    );
  }
  const existing = await existingShelf(env, shelf);
  const granted =
    existing === null
      ? null
      : await existing.packageVersions(session, shelf, profile);
  if (granted === null || !granted.ok) {
    return packageRefusal(granted?.status ?? 404);
  }
  if (advertise) {
    await commitVersions(env, shelf, profile, granted.versions);
  }
  const upstream = await shelfRepository(env).exchange(
    packageRepositoryName(shelf, profile),
    exchangeOf(request, { advertise, service: "git-upload-pack", shelf })
  );
  if (upstream === null) {
    return packageRefusal(404);
  }
  const headers = new Headers({ "cache-control": "no-cache" });
  const type = upstream.headers.get("content-type");
  if (type !== null) {
    headers.set("content-type", type);
  }
  return new Response(upstream.body, { headers, status: upstream.status });
}
