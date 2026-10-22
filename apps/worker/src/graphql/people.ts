/**
 * The GraphQL resolvers for people in the browser: one-time links, invites, passkeys, and removing someone. The schema
 * (`schema.ts`) declares the fields; these do the work, through the account objects (`auth/accounts.ts`) and the shelf
 * objects. See `docs/PRD.md` section 10.3.
 */
import { GraphQLError } from "graphql";
import * as v from "valibot";

import {
  PrincipalSchema,
  sessionCookie,
  signSession,
} from "../auth/browser.ts";
import { githubSignInEnabled } from "../auth/github.ts";
import {
  existingShelf,
  grantedShelves,
  OWNER_PRINCIPAL,
} from "../auth/index.ts";
import type { Person } from "../auth/index.ts";
import {
  createSignInLink,
  linkHash,
  linkUrl,
  parseLink,
} from "../auth/links.ts";
import {
  accountExists,
  accountStub,
  newPersonPrincipal,
  PEOPLE_MARKERS,
} from "../auth/principals.ts";
import type { PasskeyRecord } from "../auth/principals.ts";
import type { InvitePreview, InviteRecord } from "../shelf-index.ts";
import type { GraphQLContext } from "./context.ts";

function refusedLink(): GraphQLError {
  return new GraphQLError(
    "this link was already used, has expired, or was revoked: ask for a new one",
    { extensions: { code: "LINK_REFUSED" } }
  );
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
}

function origin(context: GraphQLContext): string {
  return new URL(context.request.url).origin;
}

function sessionSecret(context: GraphQLContext): string {
  const secret = context.env.SESSION_SECRET ?? "";
  if (secret === "") {
    throw new GraphQLError(
      "this deployment has no SESSION_SECRET: run `moon run worker:setup`",
      { extensions: { code: "UNAVAILABLE" } }
    );
  }
  return secret;
}

/** How the browser may sign in. */
export function signInMethods(context: GraphQLContext) {
  return {
    github: githubSignInEnabled(context.env),
    passkey: (context.env.SESSION_SECRET ?? "") !== "",
  };
}

/**
 * The account a request may manage passkeys and sign-in links for: the owner's, for the owner key or the owner
 * signed in in the browser, or an invited person's own. `null` for anyone else, a GitHub account included.
 */
function ownAccount(context: GraphQLContext): string | null {
  const { session } = context;
  if (session.kind === "owner") {
    return OWNER_PRINCIPAL;
  }
  return session.kind === "person" && session.person.id.startsWith("person:")
    ? session.person.id
    : null;
}

function requireOwnAccount(context: GraphQLContext): string {
  const principal = ownAccount(context);
  if (principal === null) {
    throw forbidden(
      "sign in as the owner or as an invited person, or use the owner key"
    );
  }
  return principal;
}

/** A one-time link that signs a browser in as the caller's own account: to add a device, or for `shelfkit open`. */
export async function newSignInLink(context: GraphQLContext) {
  const principal = requireOwnAccount(context);
  const link = await createSignInLink(context.env, principal, origin(context));
  if (link === null) {
    throw forbidden("this account was removed");
  }
  return link;
}

export async function passkeys(
  context: GraphQLContext
): Promise<PasskeyRecord[]> {
  const principal = ownAccount(context);
  if (principal === null) {
    return [];
  }
  return await accountStub(context.env, principal).passkeys();
}

export async function renamePasskey(
  context: GraphQLContext,
  id: string,
  label: string
): Promise<boolean> {
  return await accountStub(
    context.env,
    requireOwnAccount(context)
  ).renamePasskey(id, label);
}

export async function removePasskey(
  context: GraphQLContext,
  id: string,
  allowLast: boolean
): Promise<boolean> {
  const outcome = await accountStub(
    context.env,
    requireOwnAccount(context)
  ).removePasskey(id, allowLast);
  if (!outcome.ok && outcome.reason === "last-passkey") {
    throw new GraphQLError(
      "this is the account's last passkey: without it, signing in takes a link (`shelfkit open`, or one made on a signed-in device). Remove it with allowLast to go ahead",
      { extensions: { code: "LAST_PASSKEY" } }
    );
  }
  return outcome.ok;
}

/** What an invite offers, for its page; `null` when it cannot be used. */
export async function previewInvite(
  context: GraphQLContext,
  token: string
): Promise<InvitePreview | null> {
  const parsed = parseLink(token);
  if (parsed.kind !== "invite") {
    return null;
  }
  const target = await existingShelf(context.env, parsed.shelf);
  return target === null
    ? null
    : await target.previewInvite(await linkHash(token));
}

export interface Redeemed {
  readonly name: string;
  readonly owner: boolean;
  readonly shelf: string | null;
  readonly offerPasskey: boolean;
}

/**
 * Use a one-time link. A sign-in link signs the browser in as its account. An invite gives its grant to whoever is
 * signed in (not the owner, who holds every scope), or else makes a new account for the person opening it, holding
 * the grant, and signs the browser in as it.
 */
export async function redeemLink(
  context: GraphQLContext,
  token: string,
  switchAccount: boolean
): Promise<Redeemed> {
  const secret = sessionSecret(context);
  const parsed = parseLink(token);
  if (parsed.kind === "malformed") {
    throw refusedLink();
  }
  const hash = await linkHash(token);
  if (parsed.kind === "sign-in") {
    if (!(await accountExists(context.env, parsed.principal))) {
      throw refusedLink();
    }
    // A link never quietly replaces who this browser is signed in as: someone could send theirs to the owner, who
    // would then work, and save a passkey, in the sender's account. Switching takes saying so.
    const current = signedInPrincipal(context);
    if (current !== null && current !== parsed.principal && !switchAccount) {
      throw new GraphQLError(
        "this link signs the browser in as another account than the one it is signed in as: confirm the switch",
        { extensions: { code: "SWITCH_REQUIRED" } }
      );
    }
    const person = await accountStub(context.env, parsed.principal).redeemLink(
      hash
    );
    if (person === null) {
      throw refusedLink();
    }
    context.cookies.push(sessionCookie(await signSession(secret, person)));
    return {
      name: person.name,
      offerPasskey: true,
      owner: person.id === OWNER_PRINCIPAL,
      shelf: null,
    };
  }
  const target = await existingShelf(context.env, parsed.shelf);
  if (target === null) {
    throw refusedLink();
  }
  const { session } = context;
  if (session.kind === "owner") {
    throw forbidden(
      "you own this deployment, so you already hold every scope: send the invite to the person it is for"
    );
  }
  if (session.kind === "person") {
    const grant = await target.redeemInvite(hash, session.person);
    if (grant === null) {
      throw refusedLink();
    }
    return {
      name: session.person.name,
      offerPasskey: session.person.id.startsWith("person:"),
      owner: false,
      shelf: parsed.shelf,
    };
  }
  if (session.kind !== "anonymous") {
    throw forbidden("an invite is opened in a browser, not with a key");
  }
  const preview = await target.previewInvite(hash);
  if (preview === null) {
    throw refusedLink();
  }
  const person = await newPerson(context.env, preview.name);
  const grant = await target.redeemInvite(hash, person);
  if (grant === null) {
    // Another browser used the invite meanwhile: the account made for this one goes.
    await removeAccount(context.env, person.id);
    throw refusedLink();
  }
  context.cookies.push(sessionCookie(await signSession(secret, person)));
  return {
    name: person.name,
    offerPasskey: true,
    owner: false,
    shelf: parsed.shelf,
  };
}

/** The principal the browser is signed in as, by its cookie; `null` for none, or for a program's key. */
function signedInPrincipal(context: GraphQLContext): string | null {
  const { session } = context;
  if (session.kind === "owner") {
    return session.person === undefined ? null : OWNER_PRINCIPAL;
  }
  return session.kind === "person" ? session.person.id : null;
}

/**
 * Whom a sign-in link would sign the browser in as, without using it, and whom it is signed in as now: for the page
 * that asks before switching. `null` when the link cannot be used.
 */
export async function previewSignInLink(
  context: GraphQLContext,
  token: string
): Promise<{ readonly name: string; readonly switching: boolean } | null> {
  const parsed = parseLink(token);
  if (
    parsed.kind !== "sign-in" ||
    !(await accountExists(context.env, parsed.principal))
  ) {
    return null;
  }
  const person = await accountStub(context.env, parsed.principal).linkPerson(
    await linkHash(token)
  );
  if (person === null) {
    return null;
  }
  const current = signedInPrincipal(context);
  return {
    name: person.name,
    switching: current !== null && current !== parsed.principal,
  };
}

/** A new invited person's account: its marker, then its object. */
async function newPerson(env: Env, name: string): Promise<Person> {
  const principal = newPersonPrincipal();
  await env.BLOBS.put(
    `${PEOPLE_MARKERS}${principal.slice("person:".length)}`,
    new Uint8Array()
  );
  return await accountStub(env, principal).ensure({ id: principal, name });
}

/** Remove an invited person's account: their passkeys and links go, and their sessions end at the next request. */
async function removeAccount(env: Env, principal: string): Promise<boolean> {
  if (!principal.startsWith("person:")) {
    return false;
  }
  const removed = await accountStub(env, principal).remove();
  await env.BLOBS.delete(
    `${PEOPLE_MARKERS}${principal.slice("person:".length)}`
  );
  return removed;
}

/**
 * Remove someone: their grant on this shelf and on every other shelf their grant markers name, and, for an invited
 * person, their account, so they can sign in nowhere and every stream they hold closes. The owner only. A principal
 * that is malformed, or names no account, changes nothing and makes no account object.
 */
export async function removePerson(
  context: GraphQLContext,
  shelf: string,
  principal: string
): Promise<boolean> {
  const { session } = context;
  if (session.kind !== "owner") {
    throw forbidden("only the owner removes people");
  }
  if (!v.is(PrincipalSchema, principal) || principal === OWNER_PRINCIPAL) {
    throw new GraphQLError(`\`${principal}\` names nobody who can be removed`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  const shelves = new Set([
    shelf,
    ...(await grantedShelves(context.env, principal)),
  ]);
  const revoked = await Promise.all(
    [...shelves].map(async (id) => {
      const target = await existingShelf(context.env, id);
      return target === null
        ? false
        : await target.revokeAccess(session, principal);
    })
  );
  const exists =
    principal.startsWith("person:") &&
    (await accountExists(context.env, principal));
  const removed = exists ? await removeAccount(context.env, principal) : false;
  return removed || revoked.some(Boolean);
}

/** A new invite on a shelf, with its link. The owner only. */
export async function createInvite(
  context: GraphQLContext,
  shelf: string,
  name: string,
  scopes: readonly string[]
): Promise<{ readonly invite: InviteRecord; readonly url: string }> {
  const target = await existingShelf(context.env, shelf);
  if (target === null) {
    throw new GraphQLError(`there is no shelf \`${shelf}\``, {
      extensions: { code: "NOT_FOUND" },
    });
  }
  const created = await target.createInvite(context.session, {
    name,
    scopes,
  });
  if (!created.ok) {
    throw context.session.kind === "owner"
      ? new GraphQLError(created.errors.join("; "), {
          extensions: { code: "BAD_USER_INPUT" },
        })
      : forbidden(created.errors.join("; "));
  }
  return {
    invite: created.invite,
    url: linkUrl(origin(context), created.token),
  };
}
