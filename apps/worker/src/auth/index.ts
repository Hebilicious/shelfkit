/**
 * The one place a request becomes a `Session`: GraphQL, the registry routes, the raw object routes, and `/mcp` all
 * call `authenticate`, so a key revoked in its shelf's Durable Object fails on every surface at once. Nothing caches a
 * key's resolution.
 *
 * A key arrives as `Authorization: Bearer <key>`, as HTTP Basic with the key as the password (the registry's
 * alternative form), or, from the browser, in the `HttpOnly` cookie `shelfkit_key`, which the `signIn` mutation sets
 * so the SPA never holds the key. An `Authorization` header wins over the cookie. There are no accounts, sessions, or
 * `/api/auth` routes (`docs/PRD.md` section 10.3).
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { parseSecret, sameHash, secretHash } from "./keys.ts";
import type { Session } from "./session.ts";

export type { Session, ShelfAccess } from "./session.ts";
export { access, mayEditProfile, mayRelay, registryAccess } from "./session.ts";

/** The cookie the browser holds its key in. */
export const KEY_COOKIE = "shelfkit_key";

/** The key a request presents, read from its headers without looking anything up. */
export type Presented =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "key"; readonly key: string };

/** Where a presented key came from: the `Authorization` header, or the browser's cookie. */
export type CredentialSource = "header" | "cookie";

export function presentedKey(request: Request): Presented {
  return presented(request).credential;
}

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
  const cookie = readCookie(request.headers.get("cookie"), KEY_COOKIE);
  return cookie === undefined || cookie === ""
    ? { credential: { kind: "none" }, source: null }
    : { credential: { key: cookie, kind: "key" }, source: "cookie" };
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

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return undefined;
}

/** A request's session, where its credential came from, and whether the browser's cookie should be cleared. */
export interface Authenticated {
  readonly session: Session;
  readonly source: CredentialSource | null;
  /**
   * The cookie held a key that is no longer valid. The request is anonymous instead, so a browser holding a revoked
   * key can still sign in again, and the response clears the cookie.
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
  const session = await sessionForKey(env, credential.key);
  if (session.kind === "invalid" && source === "cookie") {
    return { clearCookie: true, session: { kind: "anonymous" }, source };
  }
  return { clearCookie: false, session, source };
}

/** Resolve the request's credential to a session. A stale cookie is anonymous; a bad header is `invalid`. */
export async function authenticate(
  request: Request,
  env: Env
): Promise<Session> {
  const authenticated = await authenticateRequest(request, env);
  return authenticated.session;
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

/** `Set-Cookie` for signing in: the key, `HttpOnly`, `Secure`, `SameSite=Strict`, for a year. */
export function signInCookie(key: string): string {
  return `${KEY_COOKIE}=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
}

/** `Set-Cookie` for signing out. */
export function signOutCookie(): string {
  return `${KEY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * The shelf's Durable Object. One per shelf, named by the shelf's id. Naming it creates it, so a request reaches a
 * shelf through `existingShelf` unless it is creating the shelf (the owner's first push).
 */
export function shelfStub(env: Env, shelf: string) {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}
