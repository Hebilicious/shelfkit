/**
 * The browser's session cookie, set when someone signs in: with a passkey (`passkeys.ts`), a one-time sign-in link
 * (`links.ts`), or GitHub when it is enabled (`github.ts`).
 *
 * It holds no key, no passkey, and no GitHub token: only the principal (`owner`, `person:<id>`, or `github:<id>`),
 * a name to show, when it was issued, and an expiry, signed with HMAC-SHA256 under the Worker secret
 * `SESSION_SECRET`. The Worker resolves it to a `Session` on every request (`auth/index.ts`), so what the principal
 * may do is read fresh each time, and a person whose account the owner removed is signed out at their next request.
 * Rotating `SESSION_SECRET` signs every browser out.
 *
 * `HttpOnly`, so the SPA never reads it; `Secure`; `SameSite=Strict`, so no other site's request carries it; and the
 * `__Host-` prefix, so it is set only by this origin, for every path, with no `Domain`.
 */
import * as v from "valibot";

import type { Person } from "./session.ts";

export const SESSION_COOKIE = "__Host-shelfkit_session";

/** How long a sign-in lasts: 30 days. */
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

/** A principal, as `Person.id` names it. */
export const PrincipalSchema = v.pipe(
  v.string(),
  v.regex(/^(?:owner|person:[0-9a-f]{32}|github:[1-9][0-9]{0,19})$/u)
);

const ClaimsSchema = v.strictObject({
  exp: v.pipe(v.number(), v.integer()),
  iat: v.pipe(v.number(), v.integer()),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  sub: PrincipalSchema,
  v: v.literal(2),
});

/** A verified session: who, and when it was issued (seconds). */
export interface SessionClaims {
  readonly person: Person;
  readonly issuedAt: number;
}

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) {
    return null;
  }
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
}

/** What a signed token carries: a flat JSON object. */
export type Claims = Readonly<Record<string, string | number>>;

/** `claims` as JSON, base64url, and its HMAC-SHA256 under `secret`: `<payload>.<signature>`. */
export async function signClaims(
  secret: string,
  claims: Claims
): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(payload)
  );
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * The claims `signClaims` signed, or `null` when the token is malformed or was not signed with `secret`.
 * BOUNDARY: the claims are whatever JSON was signed; the caller parses them with its schema.
 */
export async function verifyClaims(
  secret: string,
  token: string
): Promise<unknown> {
  const [payload, signature, ...rest] = token.split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) {
    return null;
  }
  const signatureBytes = fromBase64url(signature);
  if (signatureBytes === null) {
    return null;
  }
  // `verify` compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signatureBytes,
    encoder.encode(payload)
  );
  const payloadBytes = valid ? fromBase64url(payload) : null;
  if (payloadBytes === null) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
}

/** A signed session for `person`, valid for `SESSION_SECONDS` from `now` (milliseconds). */
export async function signSession(
  secret: string,
  person: Person,
  now: number = Date.now()
): Promise<string> {
  const issued = Math.floor(now / 1000);
  const claims: v.InferOutput<typeof ClaimsSchema> = {
    exp: issued + SESSION_SECONDS,
    iat: issued,
    name: person.name.slice(0, 64),
    sub: person.id,
    v: 2,
  };
  return await signClaims(secret, claims);
}

/** Who a session names, or `null` when it is malformed, signed with another secret, or expired. */
export async function verifySession(
  secret: string,
  token: string,
  now: number = Date.now()
): Promise<SessionClaims | null> {
  const claims = v.safeParse(ClaimsSchema, await verifyClaims(secret, token));
  if (!claims.success || claims.output.exp <= Math.floor(now / 1000)) {
    return null;
  }
  return {
    issuedAt: claims.output.iat,
    person: { id: claims.output.sub, name: claims.output.name },
  };
}

/** `Set-Cookie` for a new session. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

/** `Set-Cookie` for signing out. */
export function signOutCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** A cookie's value from a `Cookie` header. */
export function readCookie(
  header: string | null,
  name: string
): string | undefined {
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
