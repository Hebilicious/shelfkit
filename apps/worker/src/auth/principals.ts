/**
 * Accounts by principal, without the account object's code: the names, shapes, and lookups the rest of the Worker
 * (and the GraphQL schema, printed in Node) uses. The object itself is `accounts.ts`.
 */
import * as v from "valibot";

import { OWNER_PRINCIPAL } from "./session.ts";

/** How long a passkey ceremony may take: 5 minutes. */
export const CHALLENGE_SECONDS = 5 * 60;

/** The relying party: this deployment, as the request reached it. */
export interface RelyingParty {
  /** The deployment's hostname, which a passkey is bound to. */
  readonly id: string;
  /** The deployment's origin, which every ceremony must come from. */
  readonly origin: string;
}

/** A passkey as the owner and the person see it. */
export interface PasskeyRecord {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** Why a ceremony or a link was refused. */
export type AccountRefusal =
  | "removed"
  | "challenge"
  | "unknown-passkey"
  | "verification"
  | "counter"
  | "link"
  | "last-passkey";

export type AccountOutcome<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: AccountRefusal };

/** The challenge a ceremony's client data names, read without trusting it: the library checks it again. */
export function clientChallenge(clientDataJSON: string): string | null {
  try {
    const decoded = atob(
      clientDataJSON.replaceAll("-", "+").replaceAll("_", "/")
    );
    const parsed = v.safeParse(
      v.object({ challenge: v.string() }),
      JSON.parse(decoded)
    );
    return parsed.success ? parsed.output.challenge : null;
  } catch {
    return null;
  }
}

/** A principal's account object. */
export function accountStub(env: Env, principal: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(principal));
}

/** Where the deployment notes the invited people it holds: an empty object `people/<32 hex>` per person. */
export const PEOPLE_MARKERS = "people/";

/** Whether a principal names an account that exists: the owner always does; a person when its marker does. */
export async function accountExists(
  env: Env,
  principal: string
): Promise<boolean> {
  if (principal === OWNER_PRINCIPAL) {
    return true;
  }
  const match = /^person:(?<id>[0-9a-f]{32})$/u.exec(principal)?.groups?.id;
  return (
    match !== undefined &&
    (await env.BLOBS.head(`${PEOPLE_MARKERS}${match}`)) !== null
  );
}

/** A new person's principal: 16 random bytes, in hex. */
export function newPersonPrincipal(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `person:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
