/**
 * One-time links, which open a browser without anyone typing a key.
 *
 * - A **sign-in link**, `ssl_<account>_<secret>`, signs the browser in as one account: the owner's (`owner`), or a
 *   person's (`p<32 hex>`). `moon run worker:setup` opens one for the owner, `shelfkit open` mints one with the key it
 *   holds, and a signed-in browser mints one to add another device. It lasts `SIGN_IN_LINK_SECONDS`.
 * - An **invite**, `ssi_<shelf>_<secret>`, carries a grant on one shelf. Opened by someone signed in (not the owner),
 *   it adds the grant to their account; opened by anyone else, it makes them an account holding the grant. It lasts
 *   `INVITE_SECONDS`.
 *
 * Both are used once. Only the SHA-256 of a token is stored: a sign-in link's in the account's object, an invite's in
 * the shelf's. The token travels in the URL's fragment (`/link#<token>`), which browsers never send to a server or in
 * a `Referer`, and the SPA hands it to `redeemLink` in a `POST` body, so no log holds it.
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { sha256Hex } from "../storage/objects.ts";
import { base64url } from "./browser.ts";
import { accountExists, accountStub } from "./principals.ts";
import { OWNER_PRINCIPAL } from "./session.ts";

/** How long a sign-in link lasts: 15 minutes, enough to open it on another device. */
export const SIGN_IN_LINK_SECONDS = 15 * 60;

/** How long an invite lasts: 7 days, since the person it is for may not read it at once. */
export const INVITE_SECONDS = 7 * 24 * 60 * 60;

const SIGN_IN_PREFIX = "ssl_";
const INVITE_PREFIX = "ssi_";
const SECRET = /^[A-Za-z0-9_-]{43}$/u;

/** A link's token, read without looking anything up. */
export type ParsedLink =
  | { readonly kind: "sign-in"; readonly principal: string }
  | { readonly kind: "invite"; readonly shelf: string }
  | { readonly kind: "malformed" };

export function parseLink(token: string): ParsedLink {
  const prefix = token.slice(0, 4);
  const rest = token.slice(4);
  const separator = rest.indexOf("_");
  const subject = rest.slice(0, separator);
  if (separator <= 0 || !SECRET.test(rest.slice(separator + 1))) {
    return { kind: "malformed" };
  }
  if (prefix === SIGN_IN_PREFIX) {
    if (subject === OWNER_PRINCIPAL) {
      return { kind: "sign-in", principal: OWNER_PRINCIPAL };
    }
    return /^p[0-9a-f]{32}$/u.test(subject)
      ? { kind: "sign-in", principal: `person:${subject.slice(1)}` }
      : { kind: "malformed" };
  }
  if (prefix === INVITE_PREFIX && v.is(ShelfIdSchema, subject)) {
    return { kind: "invite", shelf: subject };
  }
  return { kind: "malformed" };
}

function secret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What is stored for a link: the lowercase hex SHA-256 of its whole token. */
export async function linkHash(token: string): Promise<string> {
  return await sha256Hex(token);
}

/** A new invite token for `shelf`. */
export function newInviteToken(shelf: string): string {
  return `${INVITE_PREFIX}${shelf}_${secret()}`;
}

/** Where a link opens: the SPA's `/link` page, with the token in the fragment. */
export function linkUrl(origin: string, token: string): string {
  return `${origin}/link#${token}`;
}

/**
 * Make a sign-in link for an account. `null` when the account does not exist or was removed. The account object keeps
 * the hash; the token is returned once, to its caller.
 */
export async function createSignInLink(
  env: Env,
  principal: string,
  origin: string
): Promise<{ readonly url: string; readonly expiresAt: string } | null> {
  if (!(await accountExists(env, principal))) {
    return null;
  }
  const subject =
    principal === OWNER_PRINCIPAL
      ? OWNER_PRINCIPAL
      : `p${principal.slice("person:".length)}`;
  const token = `${SIGN_IN_PREFIX}${subject}_${secret()}`;
  const expiresAt = Math.floor(Date.now() / 1000) + SIGN_IN_LINK_SECONDS;
  const stub = accountStub(env, principal);
  if (principal === OWNER_PRINCIPAL) {
    await stub.ensure({ id: OWNER_PRINCIPAL, name: "Owner" });
  }
  if (!(await stub.createLink(await linkHash(token), expiresAt))) {
    return null;
  }
  return {
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    url: linkUrl(origin, token),
  };
}
