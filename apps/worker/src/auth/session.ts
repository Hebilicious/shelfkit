/**
 * Who a request is, and what that lets it do on one shelf. A `Session` is what the auth module resolves a credential
 * to; it is a plain object, so the Worker passes it to the shelf's Durable Object, which checks it again before it
 * reads or writes anything (`access`).
 */
import { parseScopes, registryScopes } from "./scopes.ts";

/**
 * Someone signed in in a browser: a principal and what to call them.
 *
 * - `owner`: the deployment's owner, by passkey, a sign-in link, or (when GitHub sign-in is enabled) the owner's
 *   GitHub account;
 * - `person:<32 hex>`: someone the owner invited, signed in by passkey or sign-in link; their passkeys are in the
 *   account object of that name (`auth/accounts.ts`);
 * - `github:<numeric id>`: a GitHub account, when GitHub sign-in is enabled. The id, which GitHub never reassigns.
 */
export interface Person {
  readonly id: string;
  readonly name: string;
}

export const OWNER_PRINCIPAL = "owner";

export type Session =
  /** No credential was presented. */
  | { readonly kind: "anonymous" }
  /** A credential was presented and is not a key the service knows: malformed, unknown, or revoked. */
  | { readonly kind: "invalid" }
  /**
   * The owner: every scope on every shelf, and key, grant, and settings management. Presented as the owner key, or as
   * the browser's session cookie for the owner principal (`person`).
   */
  | {
      readonly kind: "owner";
      readonly keyId: "owner";
      readonly person?: Person;
    }
  /**
   * A browser signed in as someone who is not the owner. What they may do on a shelf is that shelf's grant to their
   * principal, which the shelf's object looks up on every call and turns into a `key` session (`grantSession`), so a
   * revoked grant fails at once. Without a grant, they are anonymous there.
   */
  | { readonly kind: "person"; readonly person: Person }
  /**
   * The Worker itself, running a queued job or the cron (an import, an upstream check, a scan). Never resolved from a
   * request: only the job code makes one, and only it may record discoveries, drift, and verdicts.
   */
  | { readonly kind: "system"; readonly job: string }
  /** A scoped key of one shelf. */
  | {
      readonly kind: "key";
      readonly shelf: string;
      readonly keyId: string;
      readonly name: string;
      readonly scopes: readonly string[];
    };

/** What a session may do on one shelf. */
export interface ShelfAccess {
  /** The id favourites, recents, and records are kept under: a key id, `owner`, or `null` for no key. */
  readonly keyId: string | null;
  /** Read items, profiles, and plans. True for anyone on a public shelf. */
  readonly read: boolean;
  /** Read what is the key holder's business: activity, favourites, recents, imports, keys' own record. */
  readonly member: boolean;
  /** Write the shelf: push, edit, import, publish every profile, share. */
  readonly write: boolean;
  /** Manage keys and settings, and create the shelf. */
  readonly owner: boolean;
  /** Profiles this session may edit, publish, and report on, besides every one when `write`. */
  readonly profiles: ReadonlySet<string>;
  /** Hosted MCP items whose relayed tools this session may call: every one for the owner, else its `mcp:` grants. */
  readonly relay: "all" | ReadonlySet<string>;
}

/**
 * A person's session on one shelf, from the scopes that shelf granted their principal: a key session, as a key's would
 * be, whose id (for favourites, recents, and records) is the principal.
 */
export function grantSession(
  shelf: string,
  person: Person,
  scopes: readonly string[]
): Session {
  return {
    keyId: person.id,
    kind: "key",
    name: person.name,
    scopes,
    shelf,
  };
}

/**
 * What a session may do on one shelf. A `person` session is resolved to its grant by the shelf's object before it
 * gets here; one that was not is treated as anonymous.
 */
export function access(
  session: Session,
  shelf: string,
  isPublic: boolean
): ShelfAccess {
  if (session.kind === "owner" || session.kind === "system") {
    return {
      keyId: session.kind,
      member: true,
      owner: true,
      profiles: new Set(),
      read: true,
      relay: "all",
      write: true,
    };
  }
  if (session.kind !== "key" || session.shelf !== shelf) {
    return {
      keyId: null,
      member: false,
      owner: false,
      profiles: new Set(),
      read: isPublic && session.kind !== "invalid",
      relay: new Set(),
      write: false,
    };
  }
  const scopes = parseScopes(shelf, session.scopes);
  const kinds = new Set(scopes.map((scope) => scope.kind));
  const write = kinds.has("publish-all");
  const member = write || kinds.has("read");
  return {
    keyId: session.keyId,
    member,
    owner: false,
    profiles: new Set(
      scopes.flatMap((scope) =>
        scope.kind === "publish" ? [scope.profile] : []
      )
    ),
    read: member || isPublic,
    relay: new Set(
      scopes.flatMap((scope) => (scope.kind === "mcp" ? [scope.item] : []))
    ),
    write,
  };
}

/** Whether `granted` may edit, publish, and report on `profile`. */
export function mayEditProfile(granted: ShelfAccess, profile: string): boolean {
  return granted.write || granted.profiles.has(profile);
}

/** Whether `granted` may call the relayed tools of the hosted MCP item `item`. */
export function mayRelay(granted: ShelfAccess, item: string): boolean {
  return granted.relay === "all" || granted.relay.has(item);
}

/**
 * The registry's view of a session on this shelf. A key of another shelf is a key the deployment knows: it reads this
 * shelf if it is public, as any known key does, and otherwise finds no shelf at all, so a key cannot learn that a
 * private shelf exists.
 */
export function registryAccess(session: Session, owner: string) {
  // A `person` session the shelf's object did not resolve to its grant holds nothing here.
  if (session.kind === "anonymous" || session.kind === "person") {
    return { credential: "anonymous" } as const;
  }
  if (session.kind === "owner" || session.kind === "system") {
    return {
      credential: "key",
      scopes: ["read", `publish:${owner}/*`],
    } as const;
  }
  if (session.kind === "key") {
    // A scope names its package, so a key's scopes grant nothing on another shelf's packages, except `read`, which
    // the registry defines as every package; `registryShelf` hides a private shelf from such a key.
    return {
      credential: "key",
      scopes: registryScopes(session.scopes),
    } as const;
  }
  return { credential: "invalid" } as const;
}
