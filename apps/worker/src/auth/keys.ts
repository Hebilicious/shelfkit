/**
 * The shape of a key, and of a share token. Both are bearer secrets: 32 random bytes, base64url, behind a prefix that
 * says what the secret is and, for a scoped key, which shelf holds it. The service keeps only the SHA-256 of the
 * whole string, so a plaintext key exists only in the response that created it and wherever its holder put it.
 *
 * - `sko_<secret>`: the owner key. Its hash is the Worker secret `OWNER_KEY_HASH`.
 * - `sks_<shelf>_<secret>`: a scoped key, stored (hashed) in the shelf's Durable Object. A shelf id is kebab-case, so
 *   it never contains `_`, and the first `_` after it ends it.
 * - `shs_<shelf>_<secret>`: a read-only share link's token, stored (hashed) in the shelf's object.
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { sha256Hex } from "../storage/objects.ts";

export const OWNER_PREFIX = "sko_";
export const KEY_PREFIX = "sks_";
export const SHARE_PREFIX = "shs_";

const SECRET = /^[A-Za-z0-9_-]{43}$/u;

/** A key or token as presented, read without looking anything up. */
export type ParsedSecret =
  | { readonly kind: "owner" }
  | { readonly kind: "key"; readonly shelf: string }
  | { readonly kind: "share"; readonly shelf: string }
  | { readonly kind: "malformed" };

export function parseSecret(text: string): ParsedSecret {
  if (text.startsWith(OWNER_PREFIX)) {
    return SECRET.test(text.slice(OWNER_PREFIX.length))
      ? { kind: "owner" }
      : { kind: "malformed" };
  }
  for (const [prefix, kind] of [
    [KEY_PREFIX, "key"],
    [SHARE_PREFIX, "share"],
  ] as const) {
    if (text.startsWith(prefix)) {
      const rest = text.slice(prefix.length);
      const separator = rest.indexOf("_");
      const shelf = rest.slice(0, separator);
      if (
        separator > 0 &&
        v.is(ShelfIdSchema, shelf) &&
        SECRET.test(rest.slice(separator + 1))
      ) {
        return { kind, shelf };
      }
      return { kind: "malformed" };
    }
  }
  return { kind: "malformed" };
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function newOwnerKey(): string {
  return `${OWNER_PREFIX}${randomSecret()}`;
}

export function newShelfKey(shelf: string): string {
  return `${KEY_PREFIX}${shelf}_${randomSecret()}`;
}

export function newShareToken(shelf: string): string {
  return `${SHARE_PREFIX}${shelf}_${randomSecret()}`;
}

/** What the service stores for a key or token: the lowercase hex SHA-256 of the whole string. */
export async function secretHash(text: string): Promise<string> {
  return await sha256Hex(text);
}

/** How many characters of a key's secret its stored prefix shows. */
export const PREFIX_SECRET_CHARACTERS = 4;

/**
 * Enough of a key to recognise it in a list, and never enough to use it: `sks_<shelf>_` and the first four characters
 * of the secret. The secret is base64url and may itself contain `_`, so the cut is counted from the shelf's end, which
 * is the first `_` after the prefix (a shelf id has none).
 */
export function displayPrefix(key: string): string {
  const shelfEnd = key.indexOf("_", KEY_PREFIX.length);
  const secretStart = shelfEnd === -1 ? KEY_PREFIX.length : shelfEnd + 1;
  return `${key.slice(0, secretStart + PREFIX_SECRET_CHARACTERS)}…`;
}

/** Compare two hex hashes in time that does not depend on where they differ. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    // oxlint-disable-next-line eslint/no-bitwise -- a constant-time comparison: OR every XOR, with no early exit.
    difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
  }
  return difference === 0;
}
