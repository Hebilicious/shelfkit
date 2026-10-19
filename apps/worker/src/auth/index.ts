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
import { parseSecret, sameHash, secretHash } from "./keys.ts";
import type { Session } from "./session.ts";

export type { Session, ShelfAccess } from "./session.ts";
export { access, mayEditProfile, mayRelay } from "./session.ts";

/** The cookie the browser holds its key in. */
export const KEY_COOKIE = "shelfkit_key";

/** The key a request presents, read from its headers without looking anything up. */
export type Presented =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "key"; readonly key: string };

export function presentedKey(request: Request): Presented {
  const header = request.headers.get("authorization");
  if (header !== null) {
    return readAuthorization(header);
  }
  const cookie = readCookie(request.headers.get("cookie"), KEY_COOKIE);
  return cookie === undefined || cookie === ""
    ? { kind: "none" }
    : { key: cookie, kind: "key" };
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

/** Resolve the request's credential to a session. */
export async function authenticate(
  request: Request,
  env: Env
): Promise<Session> {
  const presented = presentedKey(request);
  if (presented.kind === "none") {
    return { kind: "anonymous" };
  }
  if (presented.kind === "unreadable") {
    return { kind: "invalid" };
  }
  return await sessionForKey(env, presented.key);
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
  const stub = env.SHELF.get(env.SHELF.idFromName(parsed.shelf));
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

/** The shelf's Durable Object. One per shelf, named by the shelf's id. */
export function shelfStub(env: Env, shelf: string) {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}
