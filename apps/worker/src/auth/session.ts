/**
 * Who a request is, and what that lets it do on one shelf. A `Session` is what the auth module resolves a credential
 * to; it is a plain object, so the Worker passes it to the shelf's Durable Object, which checks it again before it
 * reads or writes anything (`access`).
 */
import { parseScopes } from "./scopes.ts";

export type Session =
  /** No credential was presented. */
  | { readonly kind: "anonymous" }
  /** A credential was presented and is not a key the service knows: malformed, unknown, or revoked. */
  | { readonly kind: "invalid" }
  /** The owner key: every scope on every shelf, and key and settings management. */
  | { readonly kind: "owner"; readonly keyId: "owner" }
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
