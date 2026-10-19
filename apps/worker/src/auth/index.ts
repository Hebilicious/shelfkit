/**
 * The one place a request becomes a `Session`: GraphQL, the registry routes, the raw object routes, and `/mcp` all
 * call it, so a key revoked in its shelf's Durable Object, or a grant removed from it, fails on every surface at once.
 * Nothing caches a key's or a grant's resolution.
 *
 * Programs present a key: `Authorization: Bearer <key>`, or HTTP Basic with the key as the password (the registry's
 * alternative form). A browser presents the session cookie that signing in with GitHub sets (`browser.ts`,
 * `github.ts`), which names a GitHub account and holds no key and no GitHub token. An `Authorization` header wins over
 * the cookie. `/mcp` is for programs and reads the header only (`authenticateHeader`). See `docs/PRD.md` section 10.3.
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { readCookie, SESSION_COOKIE, verifySession } from "./browser.ts";
import { parseSecret, sameHash, secretHash } from "./keys.ts";
import type { GitHubIdentity, Session } from "./session.ts";

export type { GitHubIdentity, Session, ShelfAccess } from "./session.ts";
export {
  access,
  githubKeyId,
  grantSession,
  mayEditProfile,
  mayRelay,
  registryAccess,
} from "./session.ts";
export { sessionCookie, signOutCookie } from "./browser.ts";

/** The credential a request presents, read from its headers without looking anything up. */
export type Presented =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "session"; readonly token: string };

/** Where a presented credential came from: the `Authorization` header, or the browser's cookie. */
export type CredentialSource = "header" | "cookie";

/** A request's credential and where it came from. */
interface PresentedCredential {
  readonly credential: Presented;
  readonly source: CredentialSource | null;
}

function presented(request: Request): PresentedCredential {
  const header = request.headers.get("authorization");
  if (header !== null) {
    return { credential: readAuthorization(header), source: "header" };
  }
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return cookie === undefined || cookie === ""
    ? { credential: { kind: "none" }, source: null }
    : { credential: { kind: "session", token: cookie }, source: "cookie" };
}

/** `Bearer <key>`, or Basic with the key as the password, as the registry reads them. */
export function readAuthorization(header: string): Presented {
  const value = header.trim();
  const space = value.indexOf(" ");
  const scheme = (space === -1 ? value : value.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : value.slice(space + 1).trim();
  if (scheme === "bearer") {
    return rest === "" ? { kind: "unreadable" } : { key: rest, kind: "key" };
  }
  if (scheme === "basic") {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(rest), (char) => char.codePointAt(0) ?? 0)
      );
      const colon = decoded.indexOf(":");
      const password = colon === -1 ? "" : decoded.slice(colon + 1);
      return password === ""
        ? { kind: "unreadable" }
        : { key: password, kind: "key" };
    } catch {
      return { kind: "unreadable" };
    }
  }
  return { kind: "unreadable" };
}

/** A request's session, where its credential came from, and whether the browser's cookie should be cleared. */
export interface Authenticated {
  readonly session: Session;
  readonly source: CredentialSource | null;
  /**
   * The cookie held a session that is no longer valid: tampered with, expired, or signed with a rotated secret. The
   * request is anonymous instead, so the browser can sign in again, and the response clears the cookie.
   */
  readonly clearCookie: boolean;
}

/** Resolve the request's credential to a session, saying where it came from. */
export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<Authenticated> {
  const { credential, source } = presented(request);
  if (credential.kind === "none") {
    return { clearCookie: false, session: { kind: "anonymous" }, source };
  }
  if (credential.kind === "unreadable") {
    return { clearCookie: false, session: { kind: "invalid" }, source };
  }
  if (credential.kind === "session") {
    const session = await sessionForCookie(env, credential.token);
    return session === null
      ? { clearCookie: true, session: { kind: "anonymous" }, source }
      : { clearCookie: false, session, source };
  }
  return {
    clearCookie: false,
    session: await sessionForKey(env, credential.key),
    source,
  };
}

/** Resolve the request's credential to a session. A stale cookie is anonymous; a bad header is `invalid`. */
export async function authenticate(
  request: Request,
  env: Env
): Promise<Session> {
  const authenticated = await authenticateRequest(request, env);
  return authenticated.session;
}

/** Resolve the request's `Authorization` header alone, for surfaces only programs use: the cookie is not read. */
export async function authenticateHeader(
  request: Request,
  env: Env
): Promise<Session> {
  const header = request.headers.get("authorization");
  if (header === null) {
    return { kind: "anonymous" };
  }
  const credential = readAuthorization(header);
  return credential.kind === "key"
    ? await sessionForKey(env, credential.key)
    : { kind: "invalid" };
}

/**
 * Resolve the browser's session cookie: the owner when it names the deployment's owner account (`OWNER_GITHUB_ID`),
 * else a `github` session that each shelf's object resolves to its grant. `null` when the cookie is not a valid
 * session, or the deployment has no `SESSION_SECRET` to check it with.
 */
export async function sessionForCookie(
  env: Env,
  token: string
): Promise<Session | null> {
  const secret = env.SESSION_SECRET;
  if (secret === undefined || secret === "") {
    return null;
  }
  const identity = await verifySession(secret, token);
  return identity === null ? null : sessionForGitHub(env, identity);
}

/** The session of a GitHub account: the owner's when it is the deployment's owner account. */
export function sessionForGitHub(env: Env, identity: GitHubIdentity): Session {
  const owner = env.OWNER_GITHUB_ID?.trim();
  return owner !== undefined && owner !== "" && owner === identity.id
    ? { github: identity, keyId: "owner", kind: "owner" }
    : { github: identity, kind: "github" };
}

/** Where the deployment lists the shelves it holds: an empty object per shelf, written by the shelf's first commit. */
export const SHELF_MARKERS = "shelves/";

/**
 * Whether the deployment holds `shelf`. Checked before any request touches a shelf's object, because naming a
 * Durable Object creates it: a request for a shelf that does not exist must never make one.
 */
export async function shelfExists(env: Env, shelf: string): Promise<boolean> {
  if (!v.is(ShelfIdSchema, shelf)) {
    return false;
  }
  return (await env.BLOBS.head(`${SHELF_MARKERS}${shelf}`)) !== null;
}

/**
 * Every shelf the deployment holds, from the markers, every page of them. `pageSize` is R2's own page size unless a
 * test asks for a smaller one, so crossing a page takes a few markers rather than a thousand.
 */
export async function listShelves(
  env: Env,
  pageSize?: number
): Promise<string[]> {
  const shelves: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- R2 lists a page at a time, each after the last.
    const page = await env.BLOBS.list({
      cursor,
      limit: pageSize,
      prefix: SHELF_MARKERS,
    });
    shelves.push(
      ...page.objects.map((object) => object.key.slice(SHELF_MARKERS.length))
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return shelves;
}

/** The shelf's object when the deployment holds the shelf, else `null`, with no object created. */
export async function existingShelf(env: Env, shelf: string) {
  return (await shelfExists(env, shelf)) ? shelfStub(env, shelf) : null;
}

/** Resolve a key: the owner key against `OWNER_KEY_HASH`, a scoped key in its own shelf's object. */
export async function sessionForKey(env: Env, key: string): Promise<Session> {
  const parsed = parseSecret(key);
  if (parsed.kind === "owner") {
    const expected = env.OWNER_KEY_HASH;
    if (expected === undefined || expected === "") {
      return { kind: "invalid" };
    }
    return sameHash(await secretHash(key), expected.toLowerCase())
      ? { keyId: "owner", kind: "owner" }
      : { kind: "invalid" };
  }
  if (parsed.kind !== "key") {
    return { kind: "invalid" };
  }
  // A well-formed key of a shelf the deployment does not hold is no key, and its shelf's object is never created.
  const stub = await existingShelf(env, parsed.shelf);
  if (stub === null) {
    return { kind: "invalid" };
  }
  const found = await stub.resolveKey(await secretHash(key));
  if (found === null) {
    return { kind: "invalid" };
  }
  return {
    keyId: found.id,
    kind: "key",
    name: found.name,
    scopes: found.scopes,
    shelf: parsed.shelf,
  };
}

/**
 * The shelf's Durable Object. One per shelf, named by the shelf's id. Naming it creates it, so a request reaches a
 * shelf through `existingShelf` unless it is creating the shelf (the owner's first push).
 */
export function shelfStub(env: Env, shelf: string) {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}
