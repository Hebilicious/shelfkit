/**
 * One Durable Object per shelf, holding its own SQLite database.
 *
 * Items, profiles, revisions, keys, scan records, and activity live here, as metadata. Content lives in R2 keyed by
 * `sha256`, so no database ever holds a blob. There is no D1 database and no cross-shelf query: every read and write
 * happens in the context of one shelf, and the object serializes its writes, which is what makes a publish a
 * transaction (`docs/PRD.md` section 10.1).
 *
 * The object is addressed by the shelf's id, its registry namespace (`env.SHELF.idFromName(shelf)`). Its RPC methods
 * are the shelf's API (`src/shelf/api.ts`): GraphQL and the MCP endpoint both call them, and each checks the caller's
 * session itself before it reads or writes.
 */
import type { GitNewFile, RegistryResponse } from "@shelfkit/engine";
import {
  CandidateSchema,
  ImportedItemSchema,
  ImportSourceSchema,
  PickSchema,
  ScanVerdictSchema,
  sourceKindOf,
  UpstreamStateSchema,
} from "@shelfkit/importers";
import type {
  Candidate,
  ImportedItem,
  ImportSource,
  Pick,
  ScanVerdict,
  UpstreamState,
} from "@shelfkit/importers";
import {
  ItemKindSchema,
  ItemSchema,
  NoticeSchema,
  ProfileSchema,
  ShelfIdSchema,
  ShelfManifestSchema,
} from "@shelfkit/schema";
import type {
  Bundle,
  Inventory,
  Item,
  ShelfSource,
  SourceKind,
  ItemSummary,
  Markers,
  Profile,
  ShelfManifest,
} from "@shelfkit/schema";
import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import * as v from "valibot";

import { githubSignInEnabled } from "./auth/github.ts";
import { grantMarker, SHELF_MARKERS } from "./auth/index.ts";
import {
  displayPrefix,
  newShareToken,
  newShelfKey,
  secretHash,
} from "./auth/keys.ts";
import { INVITE_SECONDS, linkHash, newInviteToken } from "./auth/links.ts";
import { accountStub } from "./auth/principals.ts";
import { parseScope } from "./auth/scopes.ts";
import {
  access,
  grantSession,
  mayEditProfile,
  mayRelay,
  registryAccess,
} from "./auth/session.ts";
import type { Person, Session, ShelfAccess } from "./auth/session.ts";
import { migrateDatabase, openDatabase } from "./db/migrate.ts";
import type { ShelfDatabase } from "./db/migrate.ts";
import * as table from "./db/schema.ts";
import { engine } from "./engine.ts";
import { shelfRepository, REPOSITORY_BRANCH } from "./repository/index.ts";
import type { ShelfRepository, RepositoryEntry } from "./repository/index.ts";
import { resolveSecret, secretOrigin } from "./secrets.ts";
import type { SecretBindingRecord } from "./secrets.ts";
import type {
  Committed,
  CompileFailed,
  Forbidden,
  InventoryInput,
  InventoryOutput,
  ItemNotFound,
  ItemOutput,
  KeyRecord,
  Outcome,
  Plan,
  ProfileNotFound,
  ProfileOutput,
  RecommendOutput,
  ReportInput,
  ReportOutput,
  RevisionNotFound,
  SearchInput,
  SearchOutput,
  ShelfEvent,
  ShelfNotFound,
  ShelfProblem,
  SnapshotFile,
  SnapshotRecord,
  RelayRefused,
  RelayTarget,
} from "./shelf/api.ts";
import {
  bodyText,
  compare,
  decoded,
  encoded,
  engineFiles,
  isShelfPath,
  manifestText,
} from "./shelf/files.ts";
import {
  bodySnippet,
  ftsQuery,
  queryWords,
  SEARCH_SQL,
} from "./shelf/search.ts";
import {
  archiveKey,
  isSha256Hex,
  objectKey,
  putObject,
  readObjects,
} from "./storage/objects.ts";

/** The registry's mount on the Worker: packages are `/apm/v1/packages/...`. */
export const REGISTRY_MOUNT = "/apm";

/** The time, RFC 3339 UTC to the second. */
function now(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/** The failure half of an `Outcome`. */
interface Refused<F> {
  readonly ok: false;
  readonly failure: F;
}

function shelfNotFound(shelf: string): Refused<ShelfNotFound> {
  return {
    failure: {
      _tag: "ShelfNotFound",
      message: `there is no shelf \`${shelf}\` this key can read`,
      shelf,
    },
    ok: false,
  };
}

function profileNotFound(profile: string): Refused<ProfileNotFound> {
  return {
    failure: {
      _tag: "ProfileNotFound",
      message: `the shelf has no profile \`${profile}\``,
      profile,
    },
    ok: false,
  };
}

/** What a request to the registry routes carries into the object. */
export interface RegistryRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType?: string;
  readonly ifNoneMatch?: string;
  readonly body?: Uint8Array;
}

/** The registry's answer: the engine's response, with an `archive` body named by the R2 object that holds it. */
export interface RegistryAnswer {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body:
    | { readonly kind: "empty" }
    | { readonly kind: "json"; readonly text: string }
    | { readonly kind: "object"; readonly sha256: string };
}

/** The shelf's identity and state, for the Shelf screen and a client deciding what to fetch. */
export interface ShelfSummary {
  readonly id: string;
  readonly manifest: ShelfManifest;
  readonly public: boolean;
  readonly snapshot: SnapshotRecord | null;
  readonly itemCount: number;
  readonly profileCount: number;
  /** Bytes of the database, which the platform caps at 10 GB per object. */
  readonly databaseBytes: number;
  readonly notices: Inventory["notices"];
  /** The shelf's repository; null where the deployment has no Artifacts. */
  readonly repository: RepositoryState | null;
}

/** Where the shelf's repository stands against its index. */
export interface RepositoryState {
  /** The commit the shelf is indexed at; null until its files are first committed to the repository. */
  readonly commit: string | null;
  /** The newest head of the repository that could not be indexed, and why; null when the index is at the head. */
  readonly refused: {
    readonly commit: string;
    readonly errors: readonly ShelfProblem[];
  } | null;
}

/** A commit already in the shelf's repository, being indexed: its id and every entry of its tree. */
interface FromRepository {
  readonly commit: string;
  readonly entries: readonly RepositoryEntry[];
}

/** An item in full, for the Item screen. */
export interface ItemDetail {
  readonly summary: ItemSummary;
  readonly document: Item;
  readonly path: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly coordinate: Inventory["items"][number]["coordinate"];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** What else in the shelf names this item: items that require it, stacks that recommend it, bundles and profiles. */
  readonly dependents: {
    readonly requiredBy: readonly string[];
    readonly recommendedBy: readonly string[];
    readonly bundles: readonly string[];
    readonly profiles: readonly string[];
  };
  readonly upstream: UpstreamRecord | null;
  /** Every verdict on every revision; the current revision's are what `scanStatus` reads. */
  readonly scans: readonly ScanRecord[];
  readonly favourite: boolean;
}

export interface RevisionRecord {
  readonly revision: string;
  readonly createdAt: string;
  readonly snapshot: string;
  readonly keyId: string | null;
  readonly message: string | null;
  readonly document: Item;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
}

export interface ScanRecord {
  readonly id: string;
  readonly revision: string;
  readonly scanner: string;
  readonly verdict: ScanVerdict["verdict"];
  readonly summary: string | null;
  readonly detailsUrl: string | null;
  readonly observed: string | null;
  readonly recordedAt: string;
}

export interface UpstreamRecord {
  readonly status: UpstreamState["status"];
  readonly latest: UpstreamState["latest"] | null;
  readonly error: string | null;
  readonly checkedAt: string;
}

export interface ActivityRecord {
  readonly id: string;
  readonly profile: string;
  readonly profileRevision: string;
  readonly repository: string;
  readonly commit: string | null;
  readonly apmYmlDigest: string;
  readonly outcome: string;
  readonly message: string | null;
  readonly keyId: string | null;
  readonly recordedAt: string;
  /** The profile has moved on since this compile. */
  readonly stale: boolean;
}

export interface ImportJobRecord {
  readonly id: string;
  readonly source: ImportSource;
  readonly status:
    | "queued"
    | "discovering"
    | "ready"
    | "importing"
    | "done"
    | "failed";
  readonly candidates: readonly Candidate[];
  readonly picks: readonly Pick[];
  readonly imported: readonly string[];
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShareLinkRecord {
  readonly id: string;
  readonly profile: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface PackageRecord {
  readonly package: string;
  readonly versions: readonly {
    readonly version: string;
    readonly digest: string;
    readonly sizeBytes: number;
    readonly publishedAt: string;
  }[];
}

/** A profile as a share link shows it: read-only, no key needed. */
export interface SharedProfile {
  readonly shelf: string;
  readonly profile: Profile;
  readonly resolution: ProfileOutput["resolution"];
  readonly items: readonly ItemSummary[];
  readonly plan: Plan | null;
  readonly errors: readonly ShelfProblem[];
}

/** A composer preview: an unsaved profile resolved and compiled, or why it does not. */
export interface ProfilePreview {
  readonly resolution: ProfileOutput["resolution"] | null;
  readonly plan: Plan | null;
  readonly errors: readonly ShelfProblem[];
}

interface FileEntry {
  readonly sha256: string;
  readonly size: number;
}

/** A new set of the shelf's files, to validate, commit, and index. */
interface CommitInput {
  readonly shelf: string;
  readonly entries: ReadonlyMap<string, FileEntry>;
  readonly contents: ReadonlyMap<string, Uint8Array>;
  readonly message: string | null;
  readonly origin: SnapshotRecord["origin"];
  /** The snapshot the writer read, which must still be current; any snapshot when absent. */
  readonly parent: string | undefined;
  /** A commit already in the shelf's repository whose files these are: index it rather than commit them again. */
  readonly from?: FromRepository;
}

/** What syncing the index with the repository's head did. */
export type Synced =
  | { readonly status: "none" | "current" | "indexed" | "backfilled" }
  | {
      readonly status: "refused";
      readonly commit: string;
      readonly errors: readonly ShelfProblem[];
    };

/** What `index` changed: the item and profile ids it wrote, and the item ids it removed. */
interface IndexChanges {
  readonly items: string[];
  readonly profiles: string[];
  readonly removed: string[];
}

/** The shelf's files in memory: what the engine reads, kept while the snapshot is current. */
interface Loaded {
  readonly digest: string;
  readonly contents: ReadonlyMap<string, Uint8Array>;
}

const encoder = new TextEncoder();

/** The full-text index's layout: rebuilt when the stored version is not this. */
const SEARCH_INDEX_VERSION = "contentless-1";

export class ShelfIndex extends DurableObject<Env> {
  private readonly db: ShelfDatabase;
  private loaded: Loaded | undefined;
  /** The last write to the shelf's files queued: each waits for the one before (`serially`). */
  private writes: Promise<void> = Promise.resolve();
  private readonly plans = new Map<string, Plan | CompileFailed>();
  /**
   * Each open event stream, with the session that opened it, which is checked again before every event, and the
   * stream's delivery so far, so its events go out in order even when a check has to wait.
   */
  private readonly subscribers = new Map<
    WritableStreamDefaultWriter<Uint8Array>,
    { readonly session: Session; delivered: Promise<void> }
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = openDatabase(ctx.storage);
    // There is no CLI path to a Durable Object's SQLite, so the schema is migrated here, before any request reaches
    // the object. `PRAGMA user_version` is unsupported, so the version is recorded explicitly (`src/db/migrate.ts`).
    void ctx.blockConcurrencyWhile(async () => {
      migrateDatabase(ctx.storage);
      await this.rebuildSearchIndex();
    });
  }

  // --- Identity and access ---------------------------------------------------------------------------------------

  /** The shelf's id, once it exists. */
  private shelfId(): string | null {
    return this.metaValue("shelf");
  }

  private metaValue(key: string): string | null {
    return (
      this.db
        .select({ value: table.meta.value })
        .from(table.meta)
        .where(eq(table.meta.key, key))
        .get()?.value ?? null
    );
  }

  private setMeta(key: string, value: string): void {
    this.db
      .insert(table.meta)
      .values({ key, value })
      .onConflictDoUpdate({ set: { value }, target: table.meta.key })
      .run();
  }

  private manifest(): ShelfManifest | null {
    const text = this.metaValue("manifest");
    return text === null
      ? null
      : v.parse(ShelfManifestSchema, JSON.parse(text));
  }

  private isPublic(): boolean {
    return this.manifest()?.registry?.public ?? false;
  }

  /** What `session` may do here; `null` when the shelf does not exist. */
  private granted(session: Session): ShelfAccess | null {
    const shelf = this.shelfId();
    if (shelf === null) {
      return null;
    }
    return access(this.effectiveSession(session), shelf, this.isPublic());
  }

  /**
   * The session as this shelf sees it. A browser signed in as someone who is not the owner holds this shelf's grant to
   * their principal, read now, so a removed grant takes effect at once: a key session with the grant's scopes, or
   * anonymous when there is none. Every other session is itself.
   */
  effectiveSession(session: Session): Session {
    const shelf = this.shelfId();
    if (session.kind !== "person") {
      return session;
    }
    // A GitHub account's grant holds only while the deployment signs people in with GitHub.
    if (
      session.person.id.startsWith("github:") &&
      !githubSignInEnabled(this.env)
    ) {
      return { kind: "anonymous" };
    }
    const grant =
      shelf === null
        ? undefined
        : this.db
            .select({ scopes: table.accessGrant.scopes })
            .from(table.accessGrant)
            .where(eq(table.accessGrant.principal, session.person.id))
            .get();
    return shelf === null || grant === undefined
      ? { kind: "anonymous" }
      : grantSession(shelf, session.person, grant.scopes);
  }

  /** The access a reader needs, or the failure that hides the shelf. */
  private reader(
    session: Session,
    shelf: string
  ): ShelfAccess | { readonly ok: false; readonly failure: ShelfNotFound } {
    const granted = this.granted(session);
    if (granted === null || !granted.read || this.shelfId() !== shelf) {
      return shelfNotFound(shelf);
    }
    return granted;
  }

  // --- Keys --------------------------------------------------------------------------------------------------------

  /** Look a scoped key up by its hash. A revoked key is no key. Called by the auth module on every request. */
  resolveKey(hash: string): {
    readonly id: string;
    readonly name: string;
    readonly scopes: readonly string[];
  } | null {
    const found = this.db
      .select()
      .from(table.apiKey)
      .where(and(eq(table.apiKey.hash, hash), isNull(table.apiKey.revokedAt)))
      .get();
    if (found === undefined) {
      return null;
    }
    const used = now();
    if (
      found.lastUsedAt === null ||
      found.lastUsedAt.slice(0, 16) !== used.slice(0, 16)
    ) {
      this.db
        .update(table.apiKey)
        .set({ lastUsedAt: used })
        .where(eq(table.apiKey.id, found.id))
        .run();
    }
    return { id: found.id, name: found.name, scopes: found.scopes };
  }

  listKeys(session: Session): KeyRecord[] | null {
    if (this.granted(session)?.owner !== true) {
      return null;
    }
    return this.db
      .select()
      .from(table.apiKey)
      .orderBy(asc(table.apiKey.createdAt))
      .all()
      .map((row) => ({
        createdAt: row.createdAt,
        id: row.id,
        lastUsedAt: row.lastUsedAt,
        name: row.name,
        prefix: row.prefix,
        revokedAt: row.revokedAt,
        scopes: row.scopes,
      }));
  }

  /** Create a scoped key. The plaintext is in this answer and nowhere else; only its hash is kept. */
  async createKey(
    session: Session,
    input: { readonly name: string; readonly scopes: readonly string[] }
  ): Promise<
    | { readonly ok: true; readonly key: KeyRecord; readonly secret: string }
    | { readonly ok: false; readonly errors: readonly string[] }
  > {
    const shelf = this.shelfId();
    if (shelf === null || this.granted(session)?.owner !== true) {
      return { errors: ["only the owner key manages keys"], ok: false };
    }
    const name = input.name.trim();
    const errors = input.scopes.flatMap((scope) => {
      const parsed = parseScope(shelf, scope);
      return "error" in parsed ? [parsed.error] : [];
    });
    if (name.length === 0 || name.length > 64) {
      errors.push("a key needs a name of 1 to 64 characters");
    }
    if (input.scopes.length === 0) {
      errors.push("a key needs at least one scope");
    }
    if (errors.length > 0) {
      return { errors, ok: false };
    }
    const secret = newShelfKey(shelf);
    const record: KeyRecord = {
      createdAt: now(),
      id: crypto.randomUUID(),
      lastUsedAt: null,
      name,
      prefix: displayPrefix(secret),
      revokedAt: null,
      scopes: [...new Set(input.scopes)],
    };
    this.db
      .insert(table.apiKey)
      .values({
        ...record,
        hash: await secretHash(secret),
        scopes: [...record.scopes],
      })
      .run();
    this.broadcast({ at: record.createdAt, id: record.id, kind: "keys" });
    return { key: record, ok: true, secret };
  }

  /** Revoke a key. It fails on the next request on every surface, because nothing caches a key's resolution. */
  revokeKey(session: Session, id: string): boolean {
    if (this.granted(session)?.owner !== true) {
      return false;
    }
    const revoked = this.db
      .update(table.apiKey)
      .set({ revokedAt: now() })
      .where(and(eq(table.apiKey.id, id), isNull(table.apiKey.revokedAt)))
      .returning({ id: table.apiKey.id })
      .all();
    if (revoked.length > 0) {
      this.broadcast({ at: now(), id, kind: "keys" });
    }
    return revoked.length > 0;
  }

  // --- People -----------------------------------------------------------------------------------------------------

  /** Who the owner granted access to this shelf, for the browser. The owner only. */
  listGrants(session: Session): GrantRecord[] | null {
    if (this.granted(session)?.owner !== true) {
      return null;
    }
    return this.db
      .select()
      .from(table.accessGrant)
      .orderBy(asc(table.accessGrant.createdAt))
      .all()
      .map(grantRecord);
  }

  /** Give `person` `scopes` on this shelf, replacing what they had, and note the shelf under their grant markers. */
  private async putGrant(
    shelf: string,
    person: Person,
    scopes: readonly string[]
  ): Promise<GrantRecord> {
    const record = {
      createdAt: now(),
      name: person.name,
      principal: person.id,
      scopes: [...new Set(scopes)],
    };
    this.db
      .insert(table.accessGrant)
      .values(record)
      .onConflictDoUpdate({
        set: { name: record.name, scopes: record.scopes },
        target: table.accessGrant.principal,
      })
      .run();
    await this.env.BLOBS.put(grantMarker(person.id, shelf), new Uint8Array());
    this.broadcast({ at: record.createdAt, id: person.id, kind: "keys" });
    return grantRecord(record);
  }

  /**
   * Grant a person scopes on this shelf, the same scopes a key holds, replacing any they had. The owner only. Used for
   * a GitHub account (when GitHub sign-in is enabled), named by its id, which the caller resolved from a login.
   */
  async grantAccess(
    session: Session,
    input: { readonly person: Person; readonly scopes: readonly string[] }
  ): Promise<
    | { readonly ok: true; readonly grant: GrantRecord }
    | { readonly ok: false; readonly errors: readonly string[] }
  > {
    const shelf = this.shelfId();
    if (shelf === null || this.granted(session)?.owner !== true) {
      return { errors: ["only the owner grants access"], ok: false };
    }
    const errors = scopeErrors(shelf, input.scopes);
    if (
      input.person.id.startsWith("github:") &&
      !githubSignInEnabled(this.env)
    ) {
      errors.push("GitHub sign-in is not enabled on this deployment");
    }
    if (errors.length > 0) {
      return { errors, ok: false };
    }
    return {
      grant: await this.putGrant(shelf, input.person, input.scopes),
      ok: true,
    };
  }

  /** Remove a person's grant. A browser signed in as them loses the access at its next request. The owner only. */
  async revokeAccess(session: Session, principal: string): Promise<boolean> {
    const shelf = this.shelfId();
    if (shelf === null || this.granted(session)?.owner !== true) {
      return false;
    }
    const removed = this.db
      .delete(table.accessGrant)
      .where(eq(table.accessGrant.principal, principal))
      .returning({ principal: table.accessGrant.principal })
      .all();
    // Removed whether or not a row was: a marker left by an earlier failure goes too.
    await this.env.BLOBS.delete(grantMarker(principal, shelf));
    if (removed.length > 0) {
      // The event also closes the person's open streams, which no longer pass `stillGranted`.
      this.broadcast({ at: now(), id: principal, kind: "keys" });
    }
    return removed.length > 0;
  }

  // --- Invites -----------------------------------------------------------------------------------------------------

  /**
   * Make an invite: a one-time link that gives whoever opens it `scopes` on this shelf, for `INVITE_SECONDS`. The
   * owner only. The token is in this answer and nowhere else; only its hash is kept.
   */
  async createInvite(
    session: Session,
    input: { readonly name: string; readonly scopes: readonly string[] }
  ): Promise<
    | {
        readonly ok: true;
        readonly invite: InviteRecord;
        readonly token: string;
      }
    | { readonly ok: false; readonly errors: readonly string[] }
  > {
    const shelf = this.shelfId();
    if (shelf === null || this.granted(session)?.owner !== true) {
      return { errors: ["only the owner invites people"], ok: false };
    }
    const name = input.name.trim();
    const errors = scopeErrors(shelf, input.scopes);
    if (name.length === 0 || name.length > 64) {
      errors.push(
        "an invite needs a name of 1 to 64 characters: who it is for"
      );
    }
    if (errors.length > 0) {
      return { errors, ok: false };
    }
    const token = newInviteToken(shelf);
    const row = {
      createdAt: now(),
      expiresAt: `${new Date(Date.now() + INVITE_SECONDS * 1000).toISOString().slice(0, 19)}Z`,
      id: crypto.randomUUID(),
      name,
      revokedAt: null,
      scopes: [...new Set(input.scopes)],
      tokenHash: await linkHash(token),
      usedAt: null,
      usedBy: null,
    };
    this.db.insert(table.invite).values(row).run();
    this.broadcast({ at: row.createdAt, id: row.id, kind: "keys" });
    return { invite: inviteRecord(row), ok: true, token };
  }

  /** The shelf's invites, newest first. The owner only. */
  listInvites(session: Session): InviteRecord[] | null {
    if (this.granted(session)?.owner !== true) {
      return null;
    }
    return this.db
      .select()
      .from(table.invite)
      .orderBy(desc(table.invite.createdAt))
      .all()
      .map(inviteRecord);
  }

  /** Revoke an invite that has not been used. The owner only. */
  revokeInvite(session: Session, id: string): boolean {
    if (this.granted(session)?.owner !== true) {
      return false;
    }
    const revoked = this.db
      .update(table.invite)
      .set({ revokedAt: now() })
      .where(
        and(
          eq(table.invite.id, id),
          isNull(table.invite.revokedAt),
          isNull(table.invite.usedAt)
        )
      )
      .returning({ id: table.invite.id })
      .all();
    if (revoked.length > 0) {
      this.broadcast({ at: now(), id, kind: "keys" });
    }
    return revoked.length > 0;
  }

  /** The invite a token's hash names, if it can still be used: for the page that offers to accept it. */
  previewInvite(hash: string): InvitePreview | null {
    const shelf = this.shelfId();
    const row = this.usableInvite(hash);
    if (shelf === null || row === undefined) {
      return null;
    }
    return {
      expiresAt: row.expiresAt,
      name: row.name,
      scopes: row.scopes,
      shelf,
      shelfName: this.manifest()?.name ?? shelf,
    };
  }

  private usableInvite(hash: string) {
    const row = this.db
      .select()
      .from(table.invite)
      .where(eq(table.invite.tokenHash, hash))
      .get();
    return row === undefined ||
      row.usedAt !== null ||
      row.revokedAt !== null ||
      row.expiresAt <= now()
      ? undefined
      : row;
  }

  /**
   * Use an invite for `person`: once, before it expires or is revoked. It is spent before anything is awaited, so two
   * people racing with one link cannot both hold the grant. The grant it gave, or `null`.
   */
  async redeemInvite(
    hash: string,
    person: Person
  ): Promise<GrantRecord | null> {
    const shelf = this.shelfId();
    const row = this.usableInvite(hash);
    if (shelf === null || row === undefined) {
      return null;
    }
    this.db
      .update(table.invite)
      .set({ usedAt: now(), usedBy: person.id })
      .where(eq(table.invite.id, row.id))
      .run();
    return await this.putGrant(shelf, person, row.scopes);
  }

  // --- The shelf ---------------------------------------------------------------------------------------------------

  summary(
    session: Session,
    shelf: string
  ): Outcome<ShelfSummary, ShelfNotFound> {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return granted;
    }
    const manifest = this.manifest();
    if (manifest === null) {
      return shelfNotFound(shelf);
    }
    const count = (from: typeof table.item | typeof table.profile) =>
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(from)
        .get()?.n ?? 0;
    const notices = this.metaValue("notices");
    return {
      ok: true,
      value: {
        databaseBytes: this.ctx.storage.sql.databaseSize,
        id: shelf,
        itemCount: count(table.item),
        manifest,
        notices:
          notices === null
            ? []
            : v.parse(v.array(NoticeSchema), JSON.parse(notices)),
        profileCount: count(table.profile),
        public: manifest.registry?.public ?? false,
        repository: this.repositoryState(),
        snapshot: this.currentSnapshot(),
      },
    };
  }

  private currentSnapshot(): SnapshotRecord | null {
    const digest = this.metaValue("snapshot");
    if (digest === null) {
      return null;
    }
    const row = this.db
      .select()
      .from(table.snapshot)
      .where(eq(table.snapshot.digest, digest))
      .get();
    return row === undefined ? null : snapshotRecord(row);
  }

  snapshots(
    session: Session,
    shelf: string,
    limit = 50
  ): SnapshotRecord[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || !granted.member) {
      return null;
    }
    return this.db
      .select()
      .from(table.snapshot)
      .orderBy(desc(table.snapshot.createdAt))
      .limit(Math.min(limit, 200))
      .all()
      .map(snapshotRecord);
  }

  /** The current snapshot's files, by path and hash: what `shelfkit fetch` downloads. */
  files(
    session: Session,
    shelf: string
  ): {
    readonly snapshot: SnapshotRecord;
    readonly files: readonly SnapshotFile[];
  } | null {
    const granted = this.reader(session, shelf);
    const snapshot = this.currentSnapshot();
    if ("ok" in granted || snapshot === null) {
      return null;
    }
    const files = this.db
      .select()
      .from(table.file)
      .orderBy(asc(table.file.path))
      .all();
    return { files, snapshot };
  }

  /**
   * Whether a committed snapshot of the shelf references the R2 object `sha256`, so `session` may download it. An
   * upload no commit took is not served: a refused push leaves nothing readable.
   */
  mayReadObject(session: Session, shelf: string, sha256: string): boolean {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return false;
    }
    return this.referenced([sha256]).length === 1;
  }

  /**
   * Which of `hashes` a committed snapshot of the shelf has ever referenced: content the service has, now or in its
   * history. `shelfkit fetch` uses it to tell a local file it may replace from local work it must not.
   */
  referencedObjects(
    session: Session,
    shelf: string,
    hashes: readonly string[]
  ): string[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    return this.referenced(hashes);
  }

  private referenced(hashes: readonly string[]): string[] {
    const wanted = [...new Set(hashes)].filter((hash) => isSha256Hex(hash));
    if (wanted.length === 0) {
      return [];
    }
    return this.db
      .select({ sha256: table.blob.sha256 })
      .from(table.blob)
      .where(
        and(inArray(table.blob.sha256, wanted), eq(table.blob.referenced, 1))
      )
      .all()
      .map((row) => row.sha256);
  }

  /**
   * Record objects `session` uploaded for this shelf, so a later snapshot may name them. The owner may upload to a
   * shelf that does not exist yet: the first push creates it.
   */
  recordObjects(
    session: Session,
    shelf: string,
    objects: readonly FileEntry[]
  ): boolean {
    if (!this.mayWriteFiles(session, shelf)) {
      return false;
    }
    const createdAt = now();
    for (const object of objects) {
      this.db
        .insert(table.blob)
        .values({ createdAt, sha256: object.sha256, size: object.size })
        .onConflictDoNothing()
        .run();
    }
    return true;
  }

  /** Whether `session` may clone and fetch the shelf's repository: anyone who may read the shelf. */
  mayReadRepository(session: Session, shelf: string): boolean {
    return !("ok" in this.reader(session, shelf));
  }

  /** Whether `session` may upload objects for this shelf: a writer, or the owner creating it. */
  mayUpload(session: Session, shelf: string): boolean {
    return this.mayWriteFiles(session, shelf);
  }

  private mayWriteFiles(session: Session, shelf: string): boolean {
    if (!v.is(ShelfIdSchema, shelf)) {
      return false;
    }
    const existing = this.shelfId();
    if (existing === null) {
      return session.kind === "owner" || session.kind === "system";
    }
    return existing === shelf && this.granted(session)?.write === true;
  }

  /**
   * Make `files` the shelf's snapshot: every file must already be in R2 (`recordObjects`), the engine must load the
   * whole shelf, and `shelf.json`'s `registry.namespace` must be this shelf's id. The first snapshot creates the
   * shelf, and only the owner may make it. `parent`, when given, must be the current snapshot, so a client that read
   * an older one cannot overwrite a newer one.
   */
  async commitSnapshot(
    session: Session,
    input: {
      readonly shelf: string;
      readonly files: readonly SnapshotFile[];
      readonly message?: string;
      readonly origin?: SnapshotRecord["origin"];
      readonly parent?: string;
    }
  ): Promise<Committed> {
    if (!this.mayWriteFiles(session, input.shelf)) {
      return {
        errors: [
          { message: "this key cannot write to this shelf", path: "<shelf>" },
        ],
        ok: false,
        reason: "forbidden",
      };
    }
    const problems: ShelfProblem[] = [];
    const entries = new Map<string, FileEntry>();
    for (const file of input.files) {
      if (!isShelfPath(file.path)) {
        problems.push({
          message:
            "not a shelf path: shelf.json, or a file under items/, bundles/, or profiles/",
          path: file.path,
        });
      } else if (!isSha256Hex(file.sha256)) {
        problems.push({
          message: "`sha256` must be 64 lowercase hex digits",
          path: file.path,
        });
      } else if (entries.has(file.path)) {
        problems.push({ message: "the path is listed twice", path: file.path });
      } else {
        entries.set(file.path, { sha256: file.sha256, size: file.size });
      }
    }
    if (problems.length > 0) {
      return { errors: problems, ok: false, reason: "invalid" };
    }
    const known = new Set(
      this.db
        .select({ sha256: table.blob.sha256 })
        .from(table.blob)
        .where(
          inArray(table.blob.sha256, [
            ...new Set([...entries.values()].map((entry) => entry.sha256)),
          ])
        )
        .all()
        .map((row) => row.sha256)
    );
    const missing = [
      ...new Set([...entries.values()].map((entry) => entry.sha256)),
    ].filter((hash) => !known.has(hash));
    if (missing.length > 0) {
      return {
        errors: missing.map((hash) => ({
          message: "upload this object before the snapshot that names it",
          path: objectKey(hash),
        })),
        missing,
        ok: false,
        reason: "missing",
      };
    }
    const contents = await this.readContents(entries);
    return await this.commit(session, {
      contents,
      entries,
      message: input.message ?? null,
      origin: input.origin ?? "push",
      parent: input.parent,
      shelf: input.shelf,
    });
  }

  /** The bytes of `entries`, from memory when the current snapshot holds them, else from R2. */
  private async readContents(
    entries: ReadonlyMap<string, FileEntry>
  ): Promise<Map<string, Uint8Array>> {
    const cached = new Map<string, Uint8Array>();
    if (this.loaded !== undefined) {
      const current = new Map(
        this.db
          .select()
          .from(table.file)
          .all()
          .map((row) => [row.sha256, row.path])
      );
      for (const [hash, path] of current) {
        const bytes = this.loaded.contents.get(path);
        if (bytes !== undefined) {
          cached.set(hash, bytes);
        }
      }
    }
    const wanted = [...entries.values()]
      .map((entry) => entry.sha256)
      .filter((hash) => !cached.has(hash));
    const fetched = await readObjects(this.env.BLOBS, wanted);
    const contents = new Map<string, Uint8Array>();
    for (const [path, entry] of entries) {
      const bytes = cached.get(entry.sha256) ?? fetched.get(entry.sha256);
      if (bytes === undefined) {
        throw new Error(`no bytes for ${path}`);
      }
      contents.set(path, bytes);
    }
    return contents;
  }

  /** The current snapshot's files, in memory. */
  private async contents(): Promise<ReadonlyMap<string, Uint8Array>> {
    const digest = this.metaValue("snapshot");
    if (digest === null) {
      return new Map();
    }
    if (this.loaded?.digest === digest) {
      return this.loaded.contents;
    }
    const entries = new Map(
      this.db
        .select()
        .from(table.file)
        .all()
        .map(
          (row) => [row.path, { sha256: row.sha256, size: row.size }] as const
        )
    );
    const contents = await this.readContents(entries);
    // Another request may have moved the snapshot while this one read R2.
    if (this.metaValue("snapshot") === digest) {
      this.loaded = { contents, digest };
    }
    return contents;
  }

  /** Run `work` after every write queued before it: one write to the shelf's files, and its repository, at a time. */
  private async serially<T>(work: () => Promise<T>): Promise<T> {
    const before = this.writes;
    const run = (async () => {
      await before;
      return await work();
    })();
    this.writes = settled(run);
    return await run;
  }

  /**
   * Validate and index a new set of files, then make it current. With a repository, the files are first committed
   * to it, or, `from` a commit already there, indexed as they are. Writes run one at a time, and everything after the
   * repository has answered is synchronous, so no other request runs between the parent check and the last write.
   */
  private async commit(
    session: Session,
    input: CommitInput
  ): Promise<Committed> {
    return await this.serially(
      async () => await this.commitNow(session, input)
    );
  }

  private async commitNow(
    session: Session,
    input: CommitInput
  ): Promise<Committed> {
    const shelfEngine = await engine();
    const indexed = shelfEngine.inventory(engineFiles(input.contents));
    if (!indexed.ok) {
      return { errors: indexed.errors, ok: false, reason: "invalid" };
    }
    const inventory = indexed.value;
    const namespace = inventory.manifest.registry?.namespace;
    if (namespace !== input.shelf) {
      return {
        errors: [
          {
            message:
              namespace === undefined
                ? `a hosted shelf needs \`registry.namespace\`, and this one is \`${input.shelf}\``
                : `\`registry.namespace\` is \`${namespace}\`, but this is the shelf \`${input.shelf}\``,
            path: "shelf.json",
          },
        ],
        ok: false,
        reason: "invalid",
      };
    }
    const files: SnapshotFile[] = [...input.entries].map(([path, entry]) => ({
      path,
      sha256: entry.sha256,
      size: entry.size,
    }));
    const manifestBytes = encoder.encode(manifestText(files));
    const manifestHash = await putObject(
      this.env.BLOBS,
      manifestBytes,
      "application/json"
    );
    const stale = this.staleParent(input.parent);
    if (stale !== null) {
      return stale;
    }
    const repository = shelfRepository(this.env);
    let committed: FromRepository | null = input.from ?? null;
    if (repository !== null && committed === null) {
      const pushed = await this.pushFiles(repository, session, input);
      if (!pushed.ok) {
        return pushed.refused;
      }
      ({ committed } = pushed);
    }
    const firstSnapshot = this.shelfId() === null;
    if (firstSnapshot) {
      await this.env.BLOBS.put(
        `${SHELF_MARKERS}${input.shelf}`,
        JSON.stringify({ createdAt: now(), shelf: input.shelf })
      );
    }

    // From here on, nothing awaits: the check and the writes are one step of the object.
    const current = this.metaValue("snapshot");
    const moved = this.staleParent(input.parent);
    if (moved !== null) {
      return moved;
    }
    if (!firstSnapshot && this.shelfId() !== input.shelf) {
      return {
        errors: [
          { message: "this object holds another shelf", path: "shelf.json" },
        ],
        ok: false,
        reason: "forbidden",
      };
    }
    const digest = `sha256:${manifestHash}`;
    const snapshot: SnapshotRecord = {
      commit: committed?.commit ?? null,
      createdAt: now(),
      digest,
      fileCount: files.length,
      keyId: keyIdOf(session),
      message: input.message,
      origin: input.origin,
      parent: current,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    };
    const changed = this.ctx.storage.transactionSync(() => {
      if (committed !== null) {
        this.recordRepository(committed);
      }
      return this.index(
        inventory,
        input.entries,
        input.contents,
        snapshot,
        manifestBytes.length,
        manifestHash
      );
    });
    this.loaded = { contents: input.contents, digest };
    this.plans.clear();
    this.broadcast({ at: snapshot.createdAt, id: digest, kind: "snapshot" });
    for (const id of changed.items) {
      this.broadcast({ at: snapshot.createdAt, id, kind: "item" });
    }
    for (const id of changed.profiles) {
      this.broadcast({ at: snapshot.createdAt, id, kind: "profile" });
    }
    return { changed, ok: true, snapshot };
  }

  /** A conflict when the current snapshot is not `parent`, the snapshot the writer read; null when it is. */
  private staleParent(parent: string | undefined): Committed | null {
    const current = this.metaValue("snapshot");
    if (parent === undefined || parent === current) {
      return null;
    }
    return {
      errors: [
        {
          message: `the shelf is at ${current ?? "no snapshot"}, not ${parent}: fetch it and try again`,
          path: "<snapshot>",
        },
      ],
      ok: false,
      reason: "conflict",
    };
  }

  /**
   * Commit `input`'s files to the shelf's repository, on top of the commit the shelf is indexed at. Files outside the
   * shelf's paths stay as they are; a file whose bytes did not change keeps its object and its mode. Nothing is
   * pushed when the tree is the same.
   */
  private async pushFiles(
    repository: ShelfRepository,
    session: Session,
    input: CommitInput
  ): Promise<
    | { readonly ok: true; readonly committed: FromRepository }
    | { readonly ok: false; readonly refused: Committed }
  > {
    const parent = this.metaValue("commit");
    const base = this.db.select().from(table.repositoryEntry).all();
    const previous = new Map(base.map((entry) => [entry.path, entry]));
    const indexed = new Map(
      this.db
        .select({ path: table.file.path, sha256: table.file.sha256 })
        .from(table.file)
        .all()
        .map((row) => [row.path, row.sha256])
    );
    const files: GitNewFile[] = base
      .filter((entry) => !isShelfPath(entry.path))
      .map((entry) => ({ id: entry.id, mode: entry.mode, path: entry.path }));
    for (const [path, entry] of input.entries) {
      const kept = previous.get(path);
      if (kept !== undefined && indexed.get(path) === entry.sha256) {
        files.push({ id: kept.id, mode: kept.mode, path });
        continue;
      }
      const contents = input.contents.get(path);
      if (contents === undefined) {
        throw new Error(`no bytes for ${path}`);
      }
      // A changed file keeps its mode; a new one, or one that was a submodule, is a regular file.
      const mode =
        kept === undefined || kept.mode === "160000" ? "100644" : kept.mode;
      files.push({ contents, mode, path });
    }
    const author = authorOf(session);
    const shelfEngine = await engine();
    const planned = shelfEngine.gitCommit({
      author: { ...author, offset: 0, time: Math.floor(Date.now() / 1000) },
      base,
      files,
      message: input.message ?? `${input.origin} ${input.shelf}`,
      parent: parent ?? undefined,
      ref: `refs/heads/${REPOSITORY_BRANCH}`,
    });
    if (!planned.ok) {
      return {
        ok: false,
        refused: { errors: planned.errors, ok: false, reason: "invalid" },
      };
    }
    const plan = planned.value;
    if (plan.commit === null || plan.request === null) {
      // The tree is the parent's: there is nothing to push.
      if (parent === null) {
        throw new Error("the engine found no change, but there is no commit");
      }
      return { committed: { commit: parent, entries: base }, ok: true };
    }
    const pushed = await repository.push(input.shelf, plan.request, parent);
    if (!pushed.ok) {
      return {
        ok: false,
        refused: {
          errors: [{ message: pushed.message, path: "<repository>" }],
          ok: false,
          reason: pushed.reason === "conflict" ? "conflict" : "unavailable",
        },
      };
    }
    return {
      committed: { commit: plan.commit, entries: plan.files },
      ok: true,
    };
  }

  /** Record the commit the shelf is now indexed at, and its tree. Runs inside the commit's transaction. */
  private recordRepository(committed: FromRepository): void {
    this.setMeta("commit", committed.commit);
    this.db
      .delete(table.meta)
      .where(eq(table.meta.key, "repository_refused"))
      .run();
    this.db.delete(table.repositoryEntry).run();
    for (const entry of committed.entries) {
      this.db
        .insert(table.repositoryEntry)
        .values({ ...entry })
        .run();
    }
  }

  private repositoryState(): RepositoryState | null {
    if (shelfRepository(this.env) === null) {
      return null;
    }
    const refused = this.metaValue("repository_refused");
    return {
      commit: this.metaValue("commit"),
      refused:
        refused === null
          ? null
          : v.parse(
              v.object({
                commit: v.string(),
                errors: v.array(
                  v.object({ message: v.string(), path: v.string() })
                ),
              }),
              JSON.parse(refused)
            ),
    };
  }

  /**
   * Bring the index up to the head of the shelf's repository: read the commit a Git client pushed, store the bytes of
   * every blob the index does not have yet in R2, and index the files as a snapshot. A head the engine refuses is
   * recorded, with its errors, and the index stays where it was. A shelf indexed before it had a repository has its
   * current files committed as the repository's first commit. Run by the queue after a push and by the hourly cron.
   */
  async syncRepository(session: Session, shelf: string): Promise<Synced> {
    if (session.kind !== "system" || !v.is(ShelfIdSchema, shelf)) {
      return { status: "none" };
    }
    const repository = shelfRepository(this.env);
    if (repository === null) {
      return { status: "none" };
    }
    return await this.serially(async () => {
      const existing = this.shelfId();
      if (existing !== null && existing !== shelf) {
        return { status: "none" };
      }
      const head = await repository.head(shelf);
      if (head === null) {
        return await this.backfill(repository, session, shelf);
      }
      if (head.commit === this.metaValue("commit")) {
        return { status: "current" };
      }
      const entries = await repository.entries(shelf, head.tree);
      const read = await this.readRepository(repository, shelf, entries);
      let errors: readonly ShelfProblem[];
      if ("errors" in read) {
        ({ errors } = read);
      } else {
        const committed = await this.commitNow(session, {
          contents: read.contents,
          entries: read.files,
          from: { commit: head.commit, entries },
          message: head.message,
          origin: "git",
          parent: undefined,
          shelf,
        });
        if (committed.ok) {
          return { status: "indexed" };
        }
        ({ errors } = committed);
      }
      this.setMeta(
        "repository_refused",
        JSON.stringify({ commit: head.commit, errors })
      );
      this.broadcast({ at: now(), id: head.commit, kind: "snapshot" });
      return { commit: head.commit, errors, status: "refused" };
    });
  }

  /**
   * The shelf's files in a commit's tree, with their bytes: from what the index already holds when the Git object is
   * one it has seen, else read from the repository and stored in R2. Files outside the shelf's paths are not read.
   */
  private async readRepository(
    repository: ShelfRepository,
    shelf: string,
    entries: readonly RepositoryEntry[]
  ): Promise<
    | {
        readonly files: Map<string, FileEntry>;
        readonly contents: Map<string, Uint8Array>;
      }
    | { readonly errors: readonly ShelfProblem[] }
  > {
    const wanted = entries.filter((entry) => isShelfPath(entry.path));
    const unreadable = wanted.filter(
      (entry) => entry.mode !== "100644" && entry.mode !== "100755"
    );
    if (unreadable.length > 0) {
      return {
        errors: unreadable.map((entry) => ({
          message:
            entry.mode === "120000"
              ? "a symbolic link is not allowed in a shelf"
              : "a submodule is not allowed in a shelf",
          path: entry.path,
        })),
      };
    }
    const known = new Map<string, FileEntry>();
    const indexed = new Map(
      this.db
        .select()
        .from(table.file)
        .all()
        .map((row) => [row.path, { sha256: row.sha256, size: row.size }])
    );
    for (const entry of this.db.select().from(table.repositoryEntry).all()) {
      const file = indexed.get(entry.path);
      if (file !== undefined) {
        known.set(entry.id, file);
      }
    }
    const fetched = new Map<string, Uint8Array>();
    const missing = [
      ...new Set(
        wanted.map((entry) => entry.id).filter((id) => !known.has(id))
      ),
    ];
    await Promise.all(
      missing.map(async (id) => {
        const bytes = await repository.blob(shelf, id);
        const sha256 = await putObject(this.env.BLOBS, bytes);
        fetched.set(sha256, bytes);
        known.set(id, { sha256, size: bytes.length });
      })
    );
    const createdAt = now();
    for (const [sha256, bytes] of fetched) {
      this.db
        .insert(table.blob)
        .values({ createdAt, sha256, size: bytes.length })
        .onConflictDoNothing()
        .run();
    }
    const files = new Map<string, FileEntry>();
    for (const entry of wanted) {
      const file = known.get(entry.id);
      if (file !== undefined) {
        files.set(entry.path, file);
      }
    }
    const contents = await this.readContents(files);
    return { contents, files };
  }

  /**
   * Commit a shelf that has files but no commit yet, as the first commit of its repository: a shelf indexed before
   * the deployment had Artifacts.
   */
  private async backfill(
    repository: ShelfRepository,
    session: Session,
    shelf: string
  ): Promise<Synced> {
    if (this.shelfId() !== shelf || this.metaValue("commit") !== null) {
      return { status: "current" };
    }
    const entries = new Map(
      this.db
        .select()
        .from(table.file)
        .all()
        .map(
          (row) => [row.path, { sha256: row.sha256, size: row.size }] as const
        )
    );
    const contents = await this.readContents(entries);
    const input: CommitInput = {
      contents,
      entries,
      message: "the shelf's files, before it had a repository",
      origin: "push",
      parent: undefined,
      shelf,
    };
    const pushed = await this.pushFiles(repository, session, input);
    if (!pushed.ok) {
      throw new Error(
        `committing ${shelf}'s files to its repository failed: ${pushed.refused.ok ? "" : pushed.refused.errors.map((error) => error.message).join("; ")}`
      );
    }
    const { committed } = pushed;
    const snapshot = this.metaValue("snapshot");
    this.ctx.storage.transactionSync(() => {
      this.recordRepository(committed);
      if (snapshot !== null) {
        this.db
          .update(table.snapshot)
          .set({ commit: committed.commit })
          .where(eq(table.snapshot.digest, snapshot))
          .run();
      }
    });
    return { status: "backfilled" };
  }

  /** Write an inventory into the database. Runs inside one transaction. */
  private index(
    inventory: Inventory,
    entries: ReadonlyMap<string, FileEntry>,
    contents: ReadonlyMap<string, Uint8Array>,
    snapshot: SnapshotRecord,
    manifestSize: number,
    manifestHash: string
  ): IndexChanges {
    const stamp = snapshot.createdAt;
    const shelf = inventory.manifest.registry?.namespace;
    if (shelf !== undefined) {
      this.setMeta("shelf", shelf);
    }
    this.setMeta("manifest", JSON.stringify(inventory.manifest));
    this.setMeta("notices", JSON.stringify(inventory.notices));
    this.setMeta("snapshot", snapshot.digest);
    this.db
      .insert(table.snapshot)
      .values({ ...snapshot })
      .onConflictDoNothing()
      .run();
    this.db
      .insert(table.blob)
      .values({
        createdAt: stamp,
        referenced: 1,
        sha256: manifestHash,
        size: manifestSize,
      })
      .onConflictDoUpdate({ set: { referenced: 1 }, target: table.blob.sha256 })
      .run();

    this.db.delete(table.file).run();
    for (const [path, entry] of entries) {
      this.db
        .insert(table.file)
        .values({ path, ...entry })
        .run();
      this.db
        .update(table.blob)
        .set({ referenced: 1 })
        .where(eq(table.blob.sha256, entry.sha256))
        .run();
    }

    const before = new Map(
      this.db
        .select({ id: table.item.id, revision: table.item.revision })
        .from(table.item)
        .all()
        .map((row) => [row.id, row.revision])
    );
    const changedItems: string[] = [];
    for (const entry of inventory.items) {
      const { item } = entry;
      const previous = before.get(item.id);
      before.delete(item.id);
      if (previous === entry.revision) {
        continue;
      }
      changedItems.push(item.id);
      const files = entry.files.map((path) => {
        const found = entries.get(`${entry.path}/${path}`);
        return { path, sha256: found?.sha256 ?? "", size: found?.size ?? 0 };
      });
      const row = {
        coordinate: entry.coordinate,
        description: item.description ?? "",
        document: item,
        files: [...entry.files],
        kind: item.kind,
        path: entry.path,
        requires: [...(item.requires ?? [])],
        revision: entry.revision,
        tags: [...(item.tags ?? [])],
        title: item.title,
        updatedAt: stamp,
      };
      this.db
        .insert(table.item)
        .values({ ...row, createdAt: stamp, id: item.id })
        .onConflictDoUpdate({ set: row, target: table.item.id })
        .run();
      this.db
        .insert(table.revision)
        .values({
          createdAt: stamp,
          document: item,
          files,
          itemId: item.id,
          keyId: snapshot.keyId,
          message: snapshot.message,
          revision: entry.revision,
          snapshot: snapshot.digest,
        })
        .onConflictDoNothing()
        .run();
      this.indexText(item, bodyText(entry.path, entry.files, contents));
    }
    const removed = [...before.keys()];
    for (const id of removed) {
      this.db.delete(table.item).where(eq(table.item.id, id)).run();
      this.unindexText(id);
    }
    this.setMeta("search_index", SEARCH_INDEX_VERSION);

    const profilesBefore = new Map(
      this.db
        .select({ id: table.profile.id, revision: table.profile.revision })
        .from(table.profile)
        .all()
        .map((row) => [row.id, row.revision])
    );
    const changedProfiles: string[] = [];
    for (const { profile, resolution } of inventory.profiles) {
      const previous = profilesBefore.get(profile.id);
      profilesBefore.delete(profile.id);
      const row = {
        document: profile,
        path: resolution.path,
        resolution,
        revision: resolution.revision,
        title: profile.title,
        updatedAt: stamp,
      };
      this.db
        .insert(table.profile)
        .values({ ...row, createdAt: stamp, id: profile.id })
        .onConflictDoUpdate({ set: row, target: table.profile.id })
        .run();
      if (previous !== resolution.revision) {
        changedProfiles.push(profile.id);
        this.db
          .insert(table.profileRevision)
          .values({
            createdAt: stamp,
            document: profile,
            profileId: profile.id,
            revision: resolution.revision,
            snapshot: snapshot.digest,
          })
          .onConflictDoNothing()
          .run();
      }
    }
    for (const id of profilesBefore.keys()) {
      this.db.delete(table.profile).where(eq(table.profile.id, id)).run();
      changedProfiles.push(id);
    }

    this.db.delete(table.bundle).run();
    for (const document of inventory.bundles) {
      this.db.insert(table.bundle).values({ document, id: document.id }).run();
    }
    return { items: changedItems, profiles: changedProfiles, removed };
  }

  /** Replace some of the shelf's files (or remove them, with `null`) and commit the result as a new snapshot. */
  private async edit(
    session: Session,
    shelf: string,
    changes: ReadonlyMap<string, Uint8Array | null>,
    message: string | null,
    origin: SnapshotRecord["origin"]
  ): Promise<Committed> {
    const parent = this.metaValue("snapshot") ?? undefined;
    const current = await this.contents();
    const entries = new Map(
      this.db
        .select()
        .from(table.file)
        .all()
        .map(
          (row) => [row.path, { sha256: row.sha256, size: row.size }] as const
        )
    );
    const contents = new Map(current);
    for (const [path, bytes] of changes) {
      if (!isShelfPath(path)) {
        return {
          errors: [{ message: "not a shelf path", path }],
          ok: false,
          reason: "invalid",
        };
      }
      if (bytes === null) {
        entries.delete(path);
        contents.delete(path);
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- an edit changes a handful of files; each is stored before the snapshot names it.
      const sha256 = await putObject(this.env.BLOBS, bytes);
      this.db
        .insert(table.blob)
        .values({ createdAt: now(), sha256, size: bytes.length })
        .onConflictDoNothing()
        .run();
      entries.set(path, { sha256, size: bytes.length });
      contents.set(path, bytes);
    }
    return await this.commit(session, {
      contents,
      entries,
      message,
      origin,
      parent,
      shelf,
    });
  }

  /**
   * Index an item's text in the contentless full-text table: its terms are kept, its text is not. The rowid comes from
   * `item_search_row`, which maps it back to the item.
   */
  private indexText(item: Item, body: string): void {
    this.unindexText(item.id);
    this.db.insert(table.itemSearchRow).values({ itemId: item.id }).run();
    const row = this.db
      .select({ rowid: table.itemSearchRow.rowid })
      .from(table.itemSearchRow)
      .where(eq(table.itemSearchRow.itemId, item.id))
      .get();
    this.ctx.storage.sql.exec(
      "INSERT INTO item_search (rowid, title, description, tags, body) VALUES (?, ?, ?, ?, ?)",
      row?.rowid ?? null,
      item.title,
      item.description ?? "",
      (item.tags ?? []).join(" "),
      body
    );
  }

  private unindexText(itemId: string): void {
    const row = this.db
      .select({ rowid: table.itemSearchRow.rowid })
      .from(table.itemSearchRow)
      .where(eq(table.itemSearchRow.itemId, itemId))
      .get();
    if (row !== undefined) {
      this.ctx.storage.sql.exec(
        "DELETE FROM item_search WHERE rowid = ?",
        row.rowid
      );
      this.db
        .delete(table.itemSearchRow)
        .where(eq(table.itemSearchRow.itemId, itemId))
        .run();
    }
  }

  /**
   * Rebuild the full-text index from the current snapshot when this code's index is not there yet: after the
   * migration that made it contentless, it is empty.
   */
  private async rebuildSearchIndex(): Promise<void> {
    if (
      this.shelfId() === null ||
      this.metaValue("search_index") === SEARCH_INDEX_VERSION
    ) {
      return;
    }
    const contents = await this.contents();
    const items = this.db.select().from(table.item).all();
    this.ctx.storage.transactionSync(() => {
      for (const row of items) {
        this.indexText(row.document, bodyText(row.path, row.files, contents));
      }
      this.setMeta("search_index", SEARCH_INDEX_VERSION);
    });
  }

  // --- The six MCP capabilities ------------------------------------------------------------------------------------

  /** `shelf.search`: items by text over titles, descriptions, tags, and bodies, filtered by kind and tag. */
  async search(
    session: Session,
    shelf: string,
    input: SearchInput
  ): Promise<Outcome<SearchOutput, ShelfNotFound>> {
    const limit = input.limit ?? 20;
    const found = await this.inventory(session, shelf, {
      kinds: input.kinds,
      limit,
      query: input.query,
      tags: input.tags,
    });
    if (!found.ok) {
      return found;
    }
    return {
      ok: true,
      value: { items: found.value.items, truncated: found.value.total > limit },
    };
  }

  /** The Shelf screen's list: every item, or those matching `query`, filtered by kind and tag. */
  async inventory(
    session: Session,
    shelf: string,
    input: InventoryInput
  ): Promise<Outcome<InventoryOutput, ShelfNotFound>> {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return granted;
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    const kinds = new Set(input.kinds);
    const tags = input.tags ?? [];
    const rows = this.db.select().from(table.item).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const query = input.query === undefined ? null : ftsQuery(input.query);
    let ordered: { readonly id: string; readonly snippet?: string }[];
    if (input.query !== undefined && query === null) {
      ordered = [];
    } else if (query === null) {
      ordered = rows
        .toSorted((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id))
        .map((row) => ({ id: row.id }));
    } else {
      const contents = await this.contents();
      const words = queryWords(input.query ?? "");
      ordered = this.ctx.storage.sql
        .exec<{ id: string }>(SEARCH_SQL, query)
        .toArray()
        .map((row) => {
          const item = byId.get(row.id);
          const snippet =
            item === undefined
              ? undefined
              : bodySnippet(bodyText(item.path, item.files, contents), words);
          return snippet === undefined
            ? { id: row.id }
            : { id: row.id, snippet };
        });
    }
    const matching = ordered.filter((entry) => {
      const row = byId.get(entry.id);
      return (
        row !== undefined &&
        (kinds.size === 0 || kinds.has(row.kind)) &&
        tags.every((tag) => row.tags.includes(tag))
      );
    });
    return {
      ok: true,
      value: {
        items: matching.slice(offset, offset + limit).flatMap((entry) => {
          const row = byId.get(entry.id);
          if (row === undefined) {
            return [];
          }
          const item = summaryOf(row);
          return entry.snippet === undefined
            ? [{ item }]
            : [{ item, snippet: entry.snippet }];
        }),
        total: matching.length,
      },
    };
  }

  /** Every tag in the shelf, with how many items carry it. */
  tags(
    session: Session,
    shelf: string
  ): { readonly tag: string; readonly count: number }[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    const counts = new Map<string, number>();
    for (const row of this.db
      .select({ tags: table.item.tags })
      .from(table.item)
      .all()) {
      for (const tag of row.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([tag, count]) => ({ count, tag }))
      .toSorted((a, b) => b.count - a.count || compare(a.tag, b.tag));
  }

  /** `shelf.recommend`: items and profiles for a repository's stack markers. */
  async recommend(
    session: Session,
    shelf: string,
    markers: Markers
  ): Promise<Outcome<RecommendOutput, ShelfNotFound>> {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return granted;
    }
    const shelfEngine = await engine();
    const found = shelfEngine.recommend(
      engineFiles(await this.contents()),
      markers
    );
    if (!found.ok) {
      // The current snapshot loaded when it was committed; a failure here is a bug, not the caller's.
      throw new Error(
        `the current snapshot no longer loads: ${JSON.stringify(found.errors)}`
      );
    }
    const items = new Map(
      this.db
        .select()
        .from(table.item)
        .all()
        .map((row) => [row.id, row])
    );
    const profiles = new Map(
      this.db
        .select()
        .from(table.profile)
        .all()
        .map((row) => [row.id, row])
    );
    return {
      ok: true,
      value: {
        items: found.value.items.flatMap((entry) => {
          const row = items.get(entry.id);
          return row === undefined
            ? []
            : [
                {
                  item: summaryOf(row),
                  matched: entry.matched,
                  recommendedBy: entry.recommendedBy,
                },
              ];
        }),
        profiles: found.value.profiles.flatMap((entry) => {
          const row = profiles.get(entry.id);
          return row === undefined
            ? []
            : [{ items: entry.items, profile: profileSummaryOf(row) }];
        }),
      },
    };
  }

  /** `shelf.profile.get`: a profile as written, and its resolution. */
  getProfile(
    session: Session,
    shelf: string,
    profile: string
  ): Outcome<ProfileOutput, ShelfNotFound | ProfileNotFound> {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return granted;
    }
    const row = this.db
      .select()
      .from(table.profile)
      .where(eq(table.profile.id, profile))
      .get();
    if (row === undefined) {
      return profileNotFound(profile);
    }
    return {
      ok: true,
      value: { profile: row.document, resolution: row.resolution },
    };
  }

  /** `shelf.item.get`: an item's item.json, revision, and files, current or at a pinned revision. */
  async getItem(
    session: Session,
    shelf: string,
    ref: string
  ): Promise<
    Outcome<ItemOutput, ShelfNotFound | ItemNotFound | RevisionNotFound>
  > {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return granted;
    }
    const [id = "", pinned] = ref.split("@");
    const row = this.db
      .select()
      .from(table.item)
      .where(eq(table.item.id, id))
      .get();
    if (row === undefined) {
      return {
        failure: {
          _tag: "ItemNotFound",
          item: id,
          message: `the shelf has no item \`${id}\``,
        },
        ok: false,
      };
    }
    const wanted = pinned ?? row.revision;
    const revision = this.db
      .select()
      .from(table.revision)
      .where(
        and(eq(table.revision.itemId, id), eq(table.revision.revision, wanted))
      )
      .get();
    if (revision === undefined) {
      return {
        failure: {
          _tag: "RevisionNotFound",
          item: id,
          message: `the shelf holds no snapshot of \`${id}\` at ${wanted}`,
          revision: wanted,
        },
        ok: false,
      };
    }
    const bytes = await readObjects(
      this.env.BLOBS,
      revision.files.map((file) => file.sha256)
    );
    return {
      ok: true,
      value: {
        files: revision.files
          .map((file) => ({
            path: file.path,
            ...encoded(bytes.get(file.sha256) ?? new Uint8Array()),
          }))
          .toSorted((a, b) => compare(a.path, b.path)),
        item: revision.document,
        path: row.path,
        revision: revision.revision,
      },
    };
  }

  /** `shelf.compile.plan`: the apm.yml, vendored files, and install command for a profile. Changes nothing. */
  async planCompile(
    session: Session,
    shelf: string,
    profile: string
  ): Promise<Outcome<Plan, ShelfNotFound | ProfileNotFound | CompileFailed>> {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return granted;
    }
    if (
      this.db
        .select({ id: table.profile.id })
        .from(table.profile)
        .where(eq(table.profile.id, profile))
        .get() === undefined
    ) {
      return profileNotFound(profile);
    }
    const key = `${this.metaValue("snapshot") ?? ""} ${profile}`;
    const cached = this.plans.get(key);
    if (cached !== undefined) {
      return "_tag" in cached
        ? { failure: cached, ok: false }
        : { ok: true, value: cached };
    }
    const shelfEngine = await engine();
    const planned = shelfEngine.planCompile(
      engineFiles(await this.contents()),
      { profile }
    );
    const answer: Plan | CompileFailed = planned.ok
      ? planned.plan
      : {
          _tag: "CompileFailed",
          errors: [...planned.errors],
          message: `the profile \`${profile}\` does not compile`,
        };
    this.plans.set(key, answer);
    return "_tag" in answer
      ? { failure: answer, ok: false }
      : { ok: true, value: answer };
  }

  /** `shelf.report`: record that a plan was applied to a repository. Writes the activity record and nothing else. */
  report(
    session: Session,
    shelf: string,
    input: ReportInput
  ): Outcome<ReportOutput, ShelfNotFound | ProfileNotFound | Forbidden> {
    // A `publish:{shelf}/{profile}` key reports on its profile without reading the shelf.
    const held = this.granted(session);
    const granted =
      held !== null &&
      this.shelfId() === shelf &&
      (held.read || mayEditProfile(held, input.profile))
        ? held
        : null;
    if (granted === null) {
      return shelfNotFound(shelf);
    }
    const row = this.db
      .select()
      .from(table.profile)
      .where(eq(table.profile.id, input.profile))
      .get();
    if (row === undefined) {
      return profileNotFound(input.profile);
    }
    if (!mayEditProfile(granted, input.profile)) {
      return {
        failure: {
          _tag: "Forbidden",
          message: `this key cannot write to the shelf: reporting needs publish:${shelf}/${input.profile} or publish:${shelf}/*`,
        },
        ok: false,
      };
    }
    const record = {
      apmYmlDigest: input.apmYmlDigest,
      commit: input.commit ?? null,
      id: crypto.randomUUID(),
      keyId: granted.keyId,
      message: input.message ?? null,
      outcome: input.outcome,
      profileId: input.profile,
      profileRevision: input.profileRevision,
      recordedAt: now(),
      repository: input.repository,
    };
    this.db.insert(table.activity).values(record).run();
    this.broadcast({ at: record.recordedAt, id: record.id, kind: "activity" });
    return {
      ok: true,
      value: {
        currentRevision: row.revision,
        id: record.id,
        recordedAt: record.recordedAt,
        stale: row.revision !== input.profileRevision,
      },
    };
  }

  // --- Items, for the UI ------------------------------------------------------------------------------------------

  itemDetail(session: Session, shelf: string, id: string): ItemDetail | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    const row = this.db.query.item
      .findFirst({ where: { id }, with: { scans: true, upstream: true } })
      .sync();
    if (row === undefined) {
      return null;
    }
    const current = this.db
      .select()
      .from(table.revision)
      .where(
        and(
          eq(table.revision.itemId, id),
          eq(table.revision.revision, row.revision)
        )
      )
      .get();
    const items = this.db.select().from(table.item).all();
    const bundles = this.db.select().from(table.bundle).all();
    const profiles = this.db.select().from(table.profile).all();
    const favourite =
      granted.keyId !== null &&
      this.db
        .select()
        .from(table.favourite)
        .where(
          and(
            eq(table.favourite.keyId, granted.keyId),
            eq(table.favourite.itemId, id)
          )
        )
        .get() !== undefined;
    return {
      coordinate: row.coordinate,
      createdAt: row.createdAt,
      dependents: {
        bundles: bundles
          .filter((entry) =>
            entry.document.items.some((ref) => ref.split("@")[0] === id)
          )
          .map((entry) => entry.id),
        profiles: profiles
          .filter((entry) =>
            entry.resolution.items.some((resolved) => resolved.id === id)
          )
          .map((entry) => entry.id),
        recommendedBy: items
          .filter(
            (entry) =>
              entry.document.kind === "stack" &&
              (entry.document.recommends ?? []).includes(id)
          )
          .map((entry) => entry.id),
        requiredBy: items
          .filter((entry) => entry.requires.includes(id))
          .map((entry) => entry.id),
      },
      document: row.document,
      favourite,
      files: current?.files ?? [],
      path: row.path,
      scans: row.scans
        .map(scanRecord)
        .toSorted((a, b) => compare(b.recordedAt, a.recordedAt)),
      summary: summaryOf(row),
      updatedAt: row.updatedAt,
      upstream:
        row.upstream === null
          ? null
          : {
              checkedAt: row.upstream.checkedAt,
              error: row.upstream.error,
              latest: row.upstream.latest,
              status: v.parse(
                UpstreamStateSchema.entries.status,
                row.upstream.status
              ),
            },
    };
  }

  /** An item's revisions, newest first. */
  itemRevisions(
    session: Session,
    shelf: string,
    id: string
  ): RevisionRecord[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    return this.db
      .select()
      .from(table.revision)
      .where(eq(table.revision.itemId, id))
      .orderBy(desc(table.revision.createdAt))
      .all()
      .map((row) => ({
        createdAt: row.createdAt,
        document: row.document,
        files: row.files,
        keyId: row.keyId,
        message: row.message,
        revision: row.revision,
        snapshot: row.snapshot,
      }));
  }

  /**
   * Create or replace an item: its item.json and its other files, which replace every file the item had. A prompt
   * edited in place is this, and the edit is a new revision of the item and a new snapshot of the shelf.
   */
  async writeItem(
    session: Session,
    shelf: string,
    input: {
      readonly document: Item;
      readonly files: readonly {
        readonly path: string;
        readonly contents: string;
        readonly encoding: "utf-8" | "base64";
      }[];
      readonly message?: string;
    }
  ): Promise<Committed> {
    const granted = this.granted(session);
    if (granted?.write !== true || this.shelfId() !== shelf) {
      return forbidden();
    }
    const parsed = v.safeParse(ItemSchema, input.document);
    if (!parsed.success) {
      return {
        errors: parsed.issues.map((issue) => ({
          message: issue.message,
          path: "item.json",
        })),
        ok: false,
        reason: "invalid",
      };
    }
    const document = parsed.output;
    const existing = this.db
      .select()
      .from(table.item)
      .where(eq(table.item.id, document.id))
      .get();
    const directory =
      existing?.path ??
      `items/${KIND_DIRECTORIES[document.kind]}/${document.id}`;
    const changes = new Map<string, Uint8Array | null>();
    for (const file of existing?.files ?? []) {
      changes.set(`${directory}/${file}`, null);
    }
    changes.set(
      `${directory}/item.json`,
      encoder.encode(`${JSON.stringify(document, null, 2)}\n`)
    );
    for (const file of input.files) {
      if (file.path === "item.json") {
        continue;
      }
      changes.set(
        `${directory}/${file.path}`,
        decoded(file.contents, file.encoding)
      );
    }
    return await this.edit(
      session,
      shelf,
      changes,
      input.message ?? null,
      "edit"
    );
  }

  /** Remove an item. The engine refuses it while a profile, a bundle, or another item still names it. */
  async deleteItem(
    session: Session,
    shelf: string,
    id: string
  ): Promise<Committed> {
    const granted = this.granted(session);
    if (granted?.write !== true || this.shelfId() !== shelf) {
      return forbidden();
    }
    const existing = this.db
      .select()
      .from(table.item)
      .where(eq(table.item.id, id))
      .get();
    if (existing === undefined) {
      return {
        errors: [{ message: `no item \`${id}\``, path: id }],
        ok: false,
        reason: "invalid",
      };
    }
    const changes = new Map<string, Uint8Array | null>(
      existing.files.map((file) => [`${existing.path}/${file}`, null])
    );
    return await this.edit(session, shelf, changes, `remove ${id}`, "edit");
  }

  setFavourite(
    session: Session,
    shelf: string,
    itemId: string,
    favourite: boolean
  ): boolean {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || granted.keyId === null || !granted.member) {
      return false;
    }
    if (favourite) {
      this.db
        .insert(table.favourite)
        .values({ createdAt: now(), itemId, keyId: granted.keyId })
        .onConflictDoNothing()
        .run();
    } else {
      this.db
        .delete(table.favourite)
        .where(
          and(
            eq(table.favourite.keyId, granted.keyId),
            eq(table.favourite.itemId, itemId)
          )
        )
        .run();
    }
    return true;
  }

  /** Record a use of an item (a copy, a compile) for this key's recents. */
  recordUse(session: Session, shelf: string, itemId: string): boolean {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || granted.keyId === null || !granted.member) {
      return false;
    }
    const usedAt = now();
    this.db
      .insert(table.recent)
      .values({ itemId, keyId: granted.keyId, usedAt, uses: 1 })
      .onConflictDoUpdate({
        set: { usedAt, uses: sql`${table.recent.uses} + 1` },
        target: [table.recent.keyId, table.recent.itemId],
      })
      .run();
    return true;
  }

  /** This key's favourites and recents, item summaries newest first. */
  personal(
    session: Session,
    shelf: string,
    limit = 20
  ): {
    readonly favourites: ItemSummary[];
    readonly recents: (ItemSummary & {
      readonly usedAt: string;
      readonly uses: number;
    })[];
  } | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || granted.keyId === null) {
      return null;
    }
    const items = new Map(
      this.db
        .select()
        .from(table.item)
        .all()
        .map((row) => [row.id, row])
    );
    const favourites = this.db
      .select()
      .from(table.favourite)
      .where(eq(table.favourite.keyId, granted.keyId))
      .orderBy(desc(table.favourite.createdAt))
      .all()
      .flatMap((row) => {
        const found = items.get(row.itemId);
        return found === undefined ? [] : [summaryOf(found)];
      });
    const recents = this.db
      .select()
      .from(table.recent)
      .where(eq(table.recent.keyId, granted.keyId))
      .orderBy(desc(table.recent.usedAt))
      .limit(Math.min(limit, 100))
      .all()
      .flatMap((row) => {
        const found = items.get(row.itemId);
        return found === undefined
          ? []
          : [{ ...summaryOf(found), usedAt: row.usedAt, uses: row.uses }];
      });
    return { favourites, recents };
  }

  // --- Profiles, for the UI ---------------------------------------------------------------------------------------

  profiles(
    session: Session,
    shelf: string
  ): (ProfileOutput & { readonly updatedAt: string })[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    return this.db
      .select()
      .from(table.profile)
      .orderBy(asc(table.profile.id))
      .all()
      .map((row) => ({
        profile: row.document,
        resolution: row.resolution,
        updatedAt: row.updatedAt,
      }));
  }

  profileRevisions(
    session: Session,
    shelf: string,
    id: string
  ):
    | {
        readonly revision: string;
        readonly createdAt: string;
        readonly snapshot: string;
        readonly profile: Profile;
      }[]
    | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    return this.db
      .select()
      .from(table.profileRevision)
      .where(eq(table.profileRevision.profileId, id))
      .orderBy(desc(table.profileRevision.createdAt))
      .all()
      .map((row) => ({
        createdAt: row.createdAt,
        profile: row.document,
        revision: row.revision,
        snapshot: row.snapshot,
      }));
  }

  /** Every bundle, as `bundles/<id>.json` holds it, sorted by id. */
  bundles(session: Session, shelf: string): Bundle[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    return this.db
      .select()
      .from(table.bundle)
      .orderBy(asc(table.bundle.id))
      .all()
      .map((row) => row.document);
  }

  /**
   * Resolve and compile an unsaved profile for the composer. Changes nothing.
   *
   * BOUNDARY: GraphQL's JSON scalar hands over an unparsed profile; `ProfileSchema` parses it here.
   */
  async previewProfile(
    session: Session,
    shelf: string,
    document: unknown
  ): Promise<ProfilePreview | null> {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    const parsed = v.safeParse(ProfileSchema, document);
    if (!parsed.success) {
      return {
        errors: parsed.issues.map((issue) => ({
          message: issue.message,
          path: "<profile>",
        })),
        plan: null,
        resolution: null,
      };
    }
    const shelfEngine = await engine();
    const files = engineFiles(await this.contents());
    const resolved = shelfEngine.resolve(files, {
      overrideProfile: parsed.output,
    });
    if (!resolved.ok) {
      return { errors: resolved.errors, plan: null, resolution: null };
    }
    const planned = shelfEngine.planCompile(files, {
      overrideProfile: parsed.output,
    });
    return planned.ok
      ? { errors: [], plan: planned.plan, resolution: resolved.value }
      : { errors: planned.errors, plan: null, resolution: resolved.value };
  }

  /**
   * Create or replace `profiles/<id>.json`.
   *
   * BOUNDARY: GraphQL's JSON scalar hands over an unparsed profile; `ProfileSchema` parses it here.
   */
  async saveProfile(
    session: Session,
    shelf: string,
    document: unknown,
    message?: string
  ): Promise<Committed> {
    const parsed = v.safeParse(ProfileSchema, document);
    if (!parsed.success) {
      return {
        errors: parsed.issues.map((issue) => ({
          message: issue.message,
          path: "<profile>",
        })),
        ok: false,
        reason: "invalid",
      };
    }
    const granted = this.granted(session);
    if (
      granted === null ||
      this.shelfId() !== shelf ||
      !mayEditProfile(granted, parsed.output.id)
    ) {
      return forbidden();
    }
    const path = `profiles/${parsed.output.id}.json`;
    const changes = new Map([
      [path, encoder.encode(`${JSON.stringify(parsed.output, null, 2)}\n`)],
    ]);
    return await this.edit(
      session,
      shelf,
      changes,
      message ?? `save ${path}`,
      "edit"
    );
  }

  async deleteProfile(
    session: Session,
    shelf: string,
    id: string
  ): Promise<Committed> {
    const granted = this.granted(session);
    if (granted?.write !== true || this.shelfId() !== shelf) {
      return forbidden();
    }
    const path = `profiles/${id}.json`;
    return await this.edit(
      session,
      shelf,
      new Map([[path, null]]),
      `remove ${path}`,
      "edit"
    );
  }

  /** The stacks a sample `package.json` matches, and what they bring: the composer's stack-marker tester. */
  async matchStacks(
    session: Session,
    shelf: string,
    packageJson: string,
    files: readonly string[] = []
  ): Promise<
    | {
        readonly ok: true;
        readonly markers: Markers;
        readonly recommendation: RecommendOutput;
      }
    | { readonly ok: false; readonly error: string }
    | null
  > {
    const markers = markersOf(packageJson, files);
    if ("error" in markers) {
      return { error: markers.error, ok: false };
    }
    const found = await this.recommend(session, shelf, markers);
    return found.ok ? { markers, ok: true, recommendation: found.value } : null;
  }

  // --- Activity and packages ---------------------------------------------------------------------------------------

  activity(
    session: Session,
    shelf: string,
    input: {
      readonly profile?: string;
      readonly limit?: number;
      readonly before?: string;
    }
  ): ActivityRecord[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || !granted.member) {
      return null;
    }
    const current = new Map(
      this.db
        .select({ id: table.profile.id, revision: table.profile.revision })
        .from(table.profile)
        .all()
        .map((row) => [row.id, row.revision])
    );
    const conditions = [
      input.profile === undefined
        ? undefined
        : eq(table.activity.profileId, input.profile),
      input.before === undefined
        ? undefined
        : lt(table.activity.recordedAt, input.before),
    ];
    return this.db
      .select()
      .from(table.activity)
      .where(and(...conditions))
      .orderBy(desc(table.activity.recordedAt))
      .limit(Math.min(input.limit ?? 50, 200))
      .all()
      .map((row) => ({
        apmYmlDigest: row.apmYmlDigest,
        commit: row.commit,
        id: row.id,
        keyId: row.keyId,
        message: row.message,
        outcome: row.outcome,
        profile: row.profileId,
        profileRevision: row.profileRevision,
        recordedAt: row.recordedAt,
        repository: row.repository,
        stale: current.get(row.profileId) !== row.profileRevision,
      }));
  }

  packages(session: Session, shelf: string): PackageRecord[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    const grouped = new Map<string, PackageRecord["versions"][number][]>();
    for (const row of this.db
      .select()
      .from(table.packageVersion)
      .orderBy(
        asc(table.packageVersion.package),
        desc(table.packageVersion.sequence)
      )
      .all()) {
      const versions = grouped.get(row.package) ?? [];
      versions.push({
        digest: row.digest,
        publishedAt: row.publishedAt,
        sizeBytes: row.sizeBytes,
        version: row.version,
      });
      grouped.set(row.package, versions);
    }
    return [...grouped].map(([name, versions]) => ({
      package: name,
      versions,
    }));
  }

  // --- The registry ------------------------------------------------------------------------------------------------

  /**
   * Answer a registry request, with the engine deciding (`crates/registry`). A publish is insert-if-absent: the
   * archive is stored in R2 first, then the versions are read again, the engine decides again, and the row is
   * inserted, with no await in between. Two publishes of one version therefore cannot both succeed, whichever order
   * they arrive in: the second sees the first's row and gets `409`.
   */
  async registry(
    session: Session,
    request: RegistryRequest
  ): Promise<RegistryAnswer> {
    const shelfEngine = await engine();
    const prepared = shelfEngine.registry.prepare({
      method: request.method,
      mount: REGISTRY_MOUNT,
      path: request.path,
    });
    if ("respond" in prepared) {
      return this.answer(prepared.respond);
    }
    const effective = this.effectiveSession(session);
    const respond = () =>
      shelfEngine.registry.respond({
        access: registryAccess(effective, prepared.ownerKey),
        body: request.body,
        contentType: request.contentType,
        context: {
          shelf: this.registryShelf(effective, prepared.ownerKey),
          versions: this.versions(prepared.packageKey),
        },
        ifNoneMatch: request.ifNoneMatch,
        method: request.method,
        mount: REGISTRY_MOUNT,
        now: now(),
        path: request.path,
      });
    const first = respond();
    if (first.publish === undefined || request.body === undefined) {
      return this.answer(first.response);
    }
    const sha256 = await putObject(
      this.env.BLOBS,
      request.body,
      "application/gzip",
      archiveKey
    );
    // Nothing awaits from here to the insert.
    const decided = respond();
    const record = decided.publish;
    if (record === undefined) {
      return this.answer(decided.response);
    }
    if (record.digest !== `sha256:${sha256}`) {
      throw new Error(
        `the engine's digest ${record.digest} is not the stored object's sha256:${sha256}`
      );
    }
    this.db
      .insert(table.packageVersion)
      .values({
        digest: record.digest,
        keyId: keyIdOf(session),
        package: prepared.packageKey,
        publishedAt: record.published_at,
        sequence: this.versions(prepared.packageKey).length,
        sizeBytes: record.size_bytes,
        version: record.version,
      })
      .run();
    this.broadcast({
      at: record.published_at,
      id: prepared.packageKey,
      kind: "package",
    });
    return this.answer(decided.response);
  }

  private registryShelf(
    session: Session,
    owner: string
  ): { readonly public: boolean } | null {
    if (this.shelfId() !== owner) {
      return null;
    }
    const isPublic = this.isPublic();
    const foreign = session.kind === "key" && session.shelf !== owner;
    return foreign && !isPublic ? null : { public: isPublic };
  }

  private versions(packageKey: string) {
    return this.db
      .select()
      .from(table.packageVersion)
      .where(eq(table.packageVersion.package, packageKey))
      .orderBy(asc(table.packageVersion.sequence))
      .all()
      .map((row) => ({
        digest: row.digest,
        published_at: row.publishedAt,
        size_bytes: row.sizeBytes,
        version: row.version,
      }));
  }

  private answer(response: RegistryResponse): RegistryAnswer {
    const { body } = response;
    if (body.kind !== "archive") {
      return { body, headers: response.headers, status: response.status };
    }
    const row = this.db
      .select({ digest: table.packageVersion.digest })
      .from(table.packageVersion)
      .where(
        and(
          eq(table.packageVersion.package, body.package),
          eq(table.packageVersion.version, body.version)
        )
      )
      .get();
    if (row === undefined) {
      throw new Error(`no stored version ${body.package} ${body.version}`);
    }
    return {
      body: { kind: "object", sha256: row.digest.slice("sha256:".length) },
      headers: response.headers,
      status: response.status,
    };
  }

  // --- Settings ------------------------------------------------------------------------------------------------------

  /** Make the shelf public or private: `registry.public` in shelf.json, committed as a new snapshot. */
  async setVisibility(
    session: Session,
    shelf: string,
    isPublic: boolean
  ): Promise<Committed> {
    return await this.editManifest(session, shelf, (manifest) => ({
      ...manifest,
      registry: { namespace: shelf, public: isPublic },
    }));
  }

  /** Add or replace a source in shelf.json's `sources`, committed as a new snapshot. */
  async putSource(
    session: Session,
    shelf: string,
    source: NonNullable<ShelfManifest["sources"]>[number]
  ): Promise<Committed> {
    return await this.editManifest(session, shelf, (manifest) => ({
      ...manifest,
      sources: [
        ...(manifest.sources ?? []).filter((entry) => entry.id !== source.id),
        source,
      ],
    }));
  }

  async removeSource(
    session: Session,
    shelf: string,
    id: string
  ): Promise<Committed> {
    return await this.editManifest(session, shelf, (manifest) => ({
      ...manifest,
      sources: (manifest.sources ?? []).filter((entry) => entry.id !== id),
    }));
  }

  private async editManifest(
    session: Session,
    shelf: string,
    change: (manifest: ShelfManifest) => ShelfManifest
  ): Promise<Committed> {
    const manifest = this.manifest();
    if (
      manifest === null ||
      this.shelfId() !== shelf ||
      this.granted(session)?.owner !== true
    ) {
      return forbidden();
    }
    const next = v.parse(ShelfManifestSchema, change(manifest));
    const bytes = encoder.encode(`${JSON.stringify(next, null, 2)}\n`);
    this.broadcast({ at: now(), id: shelf, kind: "settings" });
    return await this.edit(
      session,
      shelf,
      new Map([["shelf.json", bytes]]),
      "edit shelf.json",
      "edit"
    );
  }

  /**
   * The secret names items may reference, and whether each has a value: the Worker secret `SHELFKIT_SECRET_<NAME>`.
   * Values never pass through the API; set them with `wrangler secret put`.
   */
  secretNames(
    session: Session,
    shelf: string
  ):
    | {
        readonly name: string;
        readonly description: string | null;
        readonly origin: string | null;
        readonly createdAt: string;
        readonly configured: boolean;
      }[]
    | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || !granted.member) {
      return null;
    }
    return this.db
      .select()
      .from(table.secretName)
      .orderBy(asc(table.secretName.name))
      .all()
      .map((row) => ({
        ...row,
        configured: secretConfigured(this.env, row.name),
      }));
  }

  /**
   * Create or change a secret name and the one origin its value may be sent to (`https://host[:port]`). The owner
   * only: binding a name to an origin decides where a credential may go.
   */
  putSecretName(
    session: Session,
    shelf: string,
    name: string,
    origin: string,
    description?: string
  ): boolean {
    const bound = secretOrigin(origin);
    if (
      this.granted(session)?.owner !== true ||
      this.shelfId() !== shelf ||
      !/^[A-Z][A-Z0-9_]*$/u.test(name) ||
      bound === null ||
      bound !== origin.replace(/\/$/u, "")
    ) {
      return false;
    }
    this.db
      .insert(table.secretName)
      .values({
        createdAt: now(),
        description: description ?? null,
        name,
        origin: bound,
      })
      .onConflictDoUpdate({
        set: { description: description ?? null, origin: bound },
        target: table.secretName.name,
      })
      .run();
    this.broadcast({ at: now(), id: name, kind: "settings" });
    return true;
  }

  removeSecretName(session: Session, shelf: string, name: string): boolean {
    if (this.granted(session)?.owner !== true || this.shelfId() !== shelf) {
      return false;
    }
    this.db
      .delete(table.secretName)
      .where(eq(table.secretName.name, name))
      .run();
    this.broadcast({ at: now(), id: name, kind: "settings" });
    return true;
  }

  /** The secret names and their origins, for the Worker's own jobs, which resolve a source's secret with them. */
  secretBindings(session: Session, shelf: string): SecretBindingRecord[] {
    if (session.kind !== "system" || this.shelfId() !== shelf) {
      return [];
    }
    return this.db
      .select({ name: table.secretName.name, origin: table.secretName.origin })
      .from(table.secretName)
      .all();
  }

  /**
   * The hosted MCP items (`"flavour": "hosted"`) `session` may relay. The shelf's secret names come with them only for
   * a session that may read the shelf; the relay itself never needs them, because `relayHeaders` resolves the
   * credentials here.
   */
  relayable(
    session: Session,
    shelf: string
  ): {
    readonly servers: readonly Extract<Item, { readonly flavour: "hosted" }>[];
    readonly secretNames: readonly string[];
  } | null {
    const granted = this.granted(session);
    if (granted === null || this.shelfId() !== shelf) {
      return null;
    }
    const secretNames = granted.read
      ? this.db
          .select({ name: table.secretName.name })
          .from(table.secretName)
          .all()
          .map((row) => row.name)
      : [];
    return { secretNames, servers: this.hostedServers(granted) };
  }

  private hostedServers(granted: ShelfAccess) {
    return this.db
      .select()
      .from(table.item)
      .where(eq(table.item.kind, "mcp"))
      .all()
      .map((row) => row.document)
      .filter(
        (document): document is Extract<Item, { readonly flavour: "hosted" }> =>
          "flavour" in document &&
          document.flavour === "hosted" &&
          mayRelay(granted, document.id)
      );
  }

  /**
   * Where the relay sends a call to the hosted MCP item `item`, with its headers resolved: literals as written, and
   * each `{ "secret": "NAME" }` by the secret rule (`src/secrets.ts`), for the item's own URL. A secret that does not
   * resolve (not listed, bound to another origin, or unset) fails the whole call, so a server is never called without
   * its credential and a credential never goes anywhere but the origin the owner bound it to.
   */
  relayHeaders(
    session: Session,
    shelf: string,
    item: string
  ): Outcome<RelayTarget, RelayRefused> {
    const granted = this.granted(session);
    const server =
      granted === null || this.shelfId() !== shelf
        ? undefined
        : this.hostedServers(granted).find((found) => found.id === item);
    if (server === undefined) {
      return {
        failure: {
          _tag: "NotRelayable",
          item,
          message: `this key may not relay \`${item}\``,
        },
        ok: false,
      };
    }
    const bindings = this.db
      .select({ name: table.secretName.name, origin: table.secretName.origin })
      .from(table.secretName)
      .all();
    const headers: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      const literal = v.safeParse(v.string(), value);
      if (literal.success) {
        headers[header] = literal.output;
        continue;
      }
      const name = v.parse(SecretReferenceSchema, value).secret;
      const resolved = resolveSecret(this.env, bindings, name, server.url);
      if (resolved === undefined) {
        unresolved.push(name);
      } else {
        headers[header] = resolved;
      }
    }
    if (unresolved.length > 0) {
      return {
        failure: {
          _tag: "SecretUnavailable",
          message: `the secrets ${unresolved.join(", ")} are not released to ${secretOrigin(server.url) ?? server.url}`,
          secrets: unresolved,
        },
        ok: false,
      };
    }
    return {
      ok: true,
      value: {
        headers,
        item,
        tools: server.tools ?? [],
        transport: server.transport ?? "streamable-http",
        url: server.url,
      },
    };
  }

  // --- Share links ---------------------------------------------------------------------------------------------------

  async createShareLink(
    session: Session,
    shelf: string,
    profile: string
  ): Promise<{
    readonly link: ShareLinkRecord;
    readonly token: string;
  } | null> {
    const granted = this.granted(session);
    if (
      granted === null ||
      this.shelfId() !== shelf ||
      !mayEditProfile(granted, profile)
    ) {
      return null;
    }
    if (
      this.db
        .select()
        .from(table.profile)
        .where(eq(table.profile.id, profile))
        .get() === undefined
    ) {
      return null;
    }
    const token = newShareToken(shelf);
    const link: ShareLinkRecord = {
      createdAt: now(),
      id: crypto.randomUUID(),
      profile,
      revokedAt: null,
    };
    this.db
      .insert(table.shareLink)
      .values({
        createdAt: link.createdAt,
        id: link.id,
        keyId: granted.keyId,
        profileId: profile,
        revokedAt: null,
        tokenHash: await secretHash(token),
      })
      .run();
    return { link, token };
  }

  /**
   * The share links `session` may see: every one for a member, else those of the profiles it may edit, since whoever
   * may create a profile's link may list and revoke it.
   */
  shareLinks(session: Session, shelf: string): ShareLinkRecord[] | null {
    const granted = this.granted(session);
    if (granted === null || this.shelfId() !== shelf) {
      return null;
    }
    return this.db
      .select()
      .from(table.shareLink)
      .orderBy(desc(table.shareLink.createdAt))
      .all()
      .filter((row) => granted.member || mayEditProfile(granted, row.profileId))
      .map((row) => ({
        createdAt: row.createdAt,
        id: row.id,
        profile: row.profileId,
        revokedAt: row.revokedAt,
      }));
  }

  /** Revoke a share link: allowed to whoever may create a link for its profile. */
  revokeShareLink(session: Session, shelf: string, id: string): boolean {
    const granted = this.granted(session);
    const link = this.db
      .select({ profileId: table.shareLink.profileId })
      .from(table.shareLink)
      .where(eq(table.shareLink.id, id))
      .get();
    if (
      granted === null ||
      this.shelfId() !== shelf ||
      link === undefined ||
      !mayEditProfile(granted, link.profileId)
    ) {
      return false;
    }
    return (
      this.db
        .update(table.shareLink)
        .set({ revokedAt: now() })
        .where(
          and(eq(table.shareLink.id, id), isNull(table.shareLink.revokedAt))
        )
        .returning({ id: table.shareLink.id })
        .all().length > 0
    );
  }

  /** The profile a share token names, read-only, with no key. */
  async sharedProfile(tokenHash: string): Promise<SharedProfile | null> {
    const link = this.db
      .select()
      .from(table.shareLink)
      .where(
        and(
          eq(table.shareLink.tokenHash, tokenHash),
          isNull(table.shareLink.revokedAt)
        )
      )
      .get();
    const shelf = this.shelfId();
    if (link === undefined || shelf === null) {
      return null;
    }
    const row = this.db
      .select()
      .from(table.profile)
      .where(eq(table.profile.id, link.profileId))
      .get();
    if (row === undefined) {
      return null;
    }
    const ids = new Set(row.resolution.items.map((entry) => entry.id));
    const items = this.db
      .select()
      .from(table.item)
      .all()
      .filter((entry) => ids.has(entry.id))
      .map(summaryOf);
    const planned = await this.planCompile(
      { job: "share", kind: "system" },
      shelf,
      row.id
    );
    return {
      errors:
        planned.ok || planned.failure._tag !== "CompileFailed"
          ? []
          : planned.failure.errors,
      items,
      plan: planned.ok ? planned.value : null,
      profile: row.document,
      resolution: row.resolution,
      shelf,
    };
  }

  // --- Imports, upstream drift, and scans: the seam issue #8 writes through ----------------------------------------

  /**
   * Record a queued import of a source. BOUNDARY: GraphQL's JSON scalar hands over an unparsed source; `ImportSourceSchema`
   * parses it here.
   */
  createImportJob(
    session: Session,
    shelf: string,
    source: unknown
  ): ImportJobRecord | null {
    const granted = this.granted(session);
    const parsed = v.safeParse(ImportSourceSchema, source);
    if (
      granted?.write !== true ||
      this.shelfId() !== shelf ||
      !parsed.success
    ) {
      return null;
    }
    const stamp = now();
    const id = crypto.randomUUID();
    this.db
      .insert(table.importJob)
      .values({
        candidates: [],
        createdAt: stamp,
        id,
        imported: [],
        keyId: granted.keyId,
        picks: [],
        source: parsed.output,
        status: "queued",
        updatedAt: stamp,
        warnings: [],
      })
      .run();
    this.broadcast({ at: stamp, id, kind: "import" });
    return this.importJobRecord(id);
  }

  importJobs(
    session: Session,
    shelf: string,
    id?: string
  ): ImportJobRecord[] | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted || !granted.member) {
      return null;
    }
    const rows = this.db
      .select({ id: table.importJob.id })
      .from(table.importJob)
      .where(id === undefined ? undefined : eq(table.importJob.id, id))
      .orderBy(desc(table.importJob.createdAt))
      .limit(100)
      .all();
    return rows.flatMap((row) => {
      const found = this.importJobRecord(row.id);
      return found === null ? [] : [found];
    });
  }

  private importJobRecord(id: string): ImportJobRecord | null {
    const row = this.db
      .select()
      .from(table.importJob)
      .where(eq(table.importJob.id, id))
      .get();
    if (row === undefined) {
      return null;
    }
    return {
      candidates: row.candidates ?? [],
      createdAt: row.createdAt,
      error: row.error,
      id: row.id,
      imported: row.imported ?? [],
      picks: row.picks ?? [],
      source: row.source,
      status: v.parse(IMPORT_STATUS, row.status),
      updatedAt: row.updatedAt,
      warnings: row.warnings ?? [],
    };
  }

  /** Record what discovery found, or why it failed. Called by the import job. */
  discovered(
    session: Session,
    shelf: string,
    id: string,
    result:
      | {
          readonly candidates: readonly unknown[];
          readonly warnings: readonly string[];
        }
      | { readonly error: string }
  ): boolean {
    if (session.kind !== "system" || this.shelfId() !== shelf) {
      return false;
    }
    const stamp = now();
    if ("error" in result) {
      this.db
        .update(table.importJob)
        .set({ error: result.error, status: "failed", updatedAt: stamp })
        .where(eq(table.importJob.id, id))
        .run();
    } else {
      const candidates = v.parse(v.array(CandidateSchema), result.candidates);
      this.db
        .update(table.importJob)
        .set({
          candidates,
          status: "ready",
          updatedAt: stamp,
          warnings: [...result.warnings],
        })
        .where(eq(table.importJob.id, id))
        .run();
    }
    this.broadcast({ at: stamp, id, kind: "import" });
    return true;
  }

  /**
   * Choose candidates to import. The Worker then queues `import.apply`.
   *
   * BOUNDARY: GraphQL's JSON scalar hands over unparsed picks; `PickSchema` parses them here.
   */
  pickImport(
    session: Session,
    shelf: string,
    id: string,
    picks: unknown
  ): ImportJobRecord | null {
    const granted = this.granted(session);
    const parsed = v.safeParse(v.array(PickSchema), picks);
    const job = this.importJobRecord(id);
    if (
      granted?.write !== true ||
      this.shelfId() !== shelf ||
      !parsed.success ||
      job?.status !== "ready"
    ) {
      return null;
    }
    const keys = new Set(job.candidates.map((candidate) => candidate.key));
    if (parsed.output.some((pick) => !keys.has(pick.candidate))) {
      return null;
    }
    this.db
      .update(table.importJob)
      .set({ picks: parsed.output, status: "importing", updatedAt: now() })
      .where(eq(table.importJob.id, id))
      .run();
    this.broadcast({ at: now(), id, kind: "import" });
    return this.importJobRecord(id);
  }

  /**
   * Write imported items into the shelf as one snapshot. Each item's `source` carries its provenance and pin; the
   * engine validates the whole shelf before anything is kept.
   */
  async applyImport(
    session: Session,
    shelf: string,
    id: string,
    result:
      | {
          readonly items: readonly unknown[];
          readonly warnings: readonly string[];
        }
      | { readonly error: string }
  ): Promise<Committed | null> {
    if (session.kind !== "system" || this.shelfId() !== shelf) {
      return null;
    }
    const stamp = now();
    if ("error" in result) {
      this.db
        .update(table.importJob)
        .set({ error: result.error, status: "failed", updatedAt: stamp })
        .where(eq(table.importJob.id, id))
        .run();
      this.broadcast({ at: stamp, id, kind: "import" });
      return null;
    }
    const items: ImportedItem[] = v.parse(
      v.array(ImportedItemSchema),
      result.items
    );
    const changes = new Map<string, Uint8Array | null>();
    for (const imported of items) {
      const { item } = imported;
      const existing = this.db
        .select()
        .from(table.item)
        .where(eq(table.item.id, item.id))
        .get();
      const directory =
        existing?.path ?? `items/${KIND_DIRECTORIES[item.kind]}/${item.id}`;
      for (const file of existing?.files ?? []) {
        changes.set(`${directory}/${file}`, null);
      }
      changes.set(
        `${directory}/item.json`,
        encoder.encode(`${JSON.stringify(item, null, 2)}\n`)
      );
      for (const file of imported.files) {
        if (file.path !== "item.json") {
          changes.set(
            `${directory}/${file.path}`,
            decoded(file.contents, file.encoding)
          );
        }
      }
    }
    const committed = await this.edit(
      session,
      shelf,
      changes,
      `import ${id}`,
      "import"
    );
    const warnings = [
      ...result.warnings,
      ...items.flatMap((imported) => imported.warnings),
    ];
    this.db
      .update(table.importJob)
      .set(
        committed.ok
          ? {
              imported: items.map((imported) => imported.item.id),
              status: "done",
              updatedAt: now(),
              warnings,
            }
          : {
              error: committed.errors
                .map((error) => `${error.path}: ${error.message}`)
                .join("\n"),
              status: "failed",
              updatedAt: now(),
              warnings,
            }
      )
      .where(eq(table.importJob.id, id))
      .run();
    this.broadcast({ at: now(), id, kind: "import" });
    return committed;
  }

  /**
   * The imported items (those with a `source`), for the upstream check, each with the kind of its source: the kind of
   * the `shelf.json` source its `source.id` names, else the kind its own `source` shows (`sourceKindOf`).
   */
  importedItems(
    session: Session,
    shelf: string
  ): {
    readonly id: string;
    readonly revision: string;
    readonly item: Item;
    readonly sourceKind: SourceKind | null;
    readonly declared: ShelfSource | null;
  }[] {
    if (session.kind !== "system" || this.shelfId() !== shelf) {
      return [];
    }
    const sources = this.manifest()?.sources ?? [];
    return this.db
      .select()
      .from(table.item)
      .all()
      .flatMap((row) => {
        const { source } = row.document;
        if (source === undefined) {
          return [];
        }
        const declared =
          sources.find((entry) => entry.id === source.id) ?? null;
        const sourceKind = declared?.kind ?? sourceKindOf(source);
        return [
          {
            declared,
            id: row.id,
            item: row.document,
            revision: row.revision,
            sourceKind,
          },
        ];
      });
  }

  /** Record what an imported item's upstream looks like now. */
  recordUpstream(
    session: Session,
    shelf: string,
    itemId: string,
    state: UpstreamState
  ): boolean {
    if (session.kind !== "system" || this.shelfId() !== shelf) {
      return false;
    }
    const parsed = v.parse(UpstreamStateSchema, state);
    const known = this.db
      .select()
      .from(table.upstream)
      .where(eq(table.upstream.itemId, itemId))
      .get();
    // A check that failed says nothing about upstream: it keeps the last status and pin it learned, beside the error.
    const kept =
      parsed.status === "error" &&
      known !== undefined &&
      known.status !== "error";
    const row = {
      checkedAt: now(),
      error: parsed.error ?? null,
      latest: kept ? known.latest : (parsed.latest ?? null),
      status: kept ? known.status : parsed.status,
    };
    this.db
      .insert(table.upstream)
      .values({ ...row, itemId })
      .onConflictDoUpdate({ set: row, target: table.upstream.itemId })
      .run();
    this.broadcast({ at: row.checkedAt, id: itemId, kind: "upstream" });
    return true;
  }

  /** Record a scanner's verdict against the revision it scanned: the hash ShelfKit computed. */
  recordScan(
    session: Session,
    shelf: string,
    itemId: string,
    revision: string,
    verdict: ScanVerdict
  ): boolean {
    if (session.kind !== "system" || this.shelfId() !== shelf) {
      return false;
    }
    const parsed = v.parse(ScanVerdictSchema, verdict);
    const known = this.db
      .select()
      .from(table.revision)
      .where(
        and(
          eq(table.revision.itemId, itemId),
          eq(table.revision.revision, revision)
        )
      )
      .get();
    if (known === undefined) {
      return false;
    }
    const recordedAt = now();
    this.db
      .insert(table.scan)
      .values({
        detailsUrl: parsed.detailsUrl ?? null,
        id: crypto.randomUUID(),
        itemId,
        observed: parsed.observed ?? null,
        recordedAt,
        revision,
        scanner: parsed.scanner,
        summary: parsed.summary ?? null,
        verdict: parsed.verdict,
      })
      .run();
    this.broadcast({ at: recordedAt, id: itemId, kind: "scan" });
    return true;
  }

  // --- Live updates ------------------------------------------------------------------------------------------------

  /**
   * A stream of the shelf's changes, as server-sent events, for GraphQL subscriptions. The object fans each change
   * out to every open stream; a stream that cannot be written is dropped.
   */
  events(session: Session, shelf: string): ReadableStream<Uint8Array> | null {
    const granted = this.reader(session, shelf);
    if ("ok" in granted) {
      return null;
    }
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    this.subscribers.set(writer, { delivered: Promise.resolve(), session });
    void this.send(writer, encoder.encode(": connected\n\n"));
    void this.forget(writer);
    return readable;
  }

  /** Write to one subscriber, dropping it when its stream cannot be written. */
  private async send(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    bytes: Uint8Array
  ): Promise<void> {
    try {
      await writer.write(bytes);
    } catch {
      this.subscribers.delete(writer);
    }
  }

  /** Drop a subscriber once its stream closes, however it closes. */
  private async forget(
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): Promise<void> {
    try {
      await writer.closed;
    } finally {
      this.subscribers.delete(writer);
    }
  }

  /**
   * Send an event to every open stream whose session may still read it. Access is checked again for each event, not
   * once at subscription: a stream whose key was revoked, or whose shelf stopped being public, is closed, and `keys`
   * events reach only the owner, while `settings`, `activity`, and `import` events reach only members.
   */
  private broadcast(event: ShelfEvent): void {
    const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const [writer, subscriber] of this.subscribers) {
      subscriber.delivered = this.after(
        subscriber.delivered,
        writer,
        subscriber.session,
        event,
        bytes
      );
    }
  }

  /** Deliver an event once the stream's earlier events have gone. */
  private async after(
    earlier: Promise<void>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    session: Session,
    event: ShelfEvent,
    bytes: Uint8Array
  ): Promise<void> {
    await earlier;
    await this.deliver(writer, session, event, bytes);
  }

  /**
   * Send one event to one stream, or close the stream when its session may no longer read the shelf. An invited
   * person's account is asked first: once the owner removes them, every stream they hold closes at its next event,
   * on every shelf, whatever grant it still names here.
   */
  private async deliver(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    session: Session,
    event: ShelfEvent,
    bytes: Uint8Array
  ): Promise<void> {
    if (!this.subscribers.has(writer)) {
      return;
    }
    const removed =
      session.kind === "person" &&
      session.person.id.startsWith("person:") &&
      (await accountStub(this.env, session.person.id).person()) === null;
    const granted = removed ? null : this.stillGranted(session);
    if (granted === null || !granted.read) {
      this.subscribers.delete(writer);
      await closeQuietly(writer);
      return;
    }
    if (mayReceive(granted, event)) {
      await this.send(writer, bytes);
    }
  }

  /** What a subscriber's session may do now: `null` once its key has been revoked. */
  private stillGranted(session: Session): ShelfAccess | null {
    if (session.kind === "key") {
      const key = this.db
        .select({ revokedAt: table.apiKey.revokedAt })
        .from(table.apiKey)
        .where(eq(table.apiKey.id, session.keyId))
        .get();
      if (key === undefined || key.revokedAt !== null) {
        return null;
      }
    }
    return this.granted(session);
  }
}

/** A GitHub account's grant on the shelf. */
/** The errors in a set of scopes for a shelf, or none. */
function scopeErrors(shelf: string, scopes: readonly string[]): string[] {
  const errors = scopes.flatMap((scope) => {
    const parsed = parseScope(shelf, scope);
    return "error" in parsed ? [parsed.error] : [];
  });
  if (scopes.length === 0) {
    errors.push("a grant needs at least one scope");
  }
  return errors;
}

/** A person's grant on the shelf. */
export interface GrantRecord {
  readonly principal: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
}

function grantRecord(row: typeof table.accessGrant.$inferSelect): GrantRecord {
  return {
    createdAt: row.createdAt,
    name: row.name,
    principal: row.principal,
    scopes: row.scopes,
  };
}

/** An invite as the owner sees it: never its token. */
export interface InviteRecord {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly usedBy: string | null;
  readonly revokedAt: string | null;
}

function inviteRecord(row: typeof table.invite.$inferSelect): InviteRecord {
  return {
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    id: row.id,
    name: row.name,
    revokedAt: row.revokedAt,
    scopes: row.scopes,
    usedAt: row.usedAt,
    usedBy: row.usedBy,
  };
}

/** What an invite offers, as its page shows it before it is accepted. */
export interface InvitePreview {
  readonly shelf: string;
  readonly shelfName: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

/** A header's `{ "secret": "NAME" }`, as against a literal value. */
const SecretReferenceSchema = v.strictObject({ secret: v.string() });

/** End an event stream; one the client already closed needs nothing. */
async function closeQuietly(
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<void> {
  try {
    await writer.close();
  } catch {
    // Already closed by the client.
  }
}

/** Whether a subscriber with `granted` may see `event`. */
function mayReceive(granted: ShelfAccess, event: ShelfEvent): boolean {
  if (event.kind === "keys") {
    return granted.owner;
  }
  if (
    event.kind === "settings" ||
    event.kind === "activity" ||
    event.kind === "import"
  ) {
    return granted.member;
  }
  return granted.read;
}

const IMPORT_STATUS = v.picklist([
  "queued",
  "discovering",
  "ready",
  "importing",
  "done",
  "failed",
]);

/** The directory under `items/` each kind lives in (`docs/PRD.md` section 5). */
const KIND_DIRECTORIES: Readonly<Record<Item["kind"], string>> = {
  agent: "agents",
  hook: "hooks",
  instructions: "instructions",
  library: "libraries",
  lsp: "lsp",
  mcp: "mcp",
  plugin: "plugins",
  prompt: "prompts",
  skill: "skills",
  stack: "stacks",
};

function forbidden(): Committed {
  return {
    errors: [
      {
        message: "this key cannot make that change to this shelf",
        path: "<shelf>",
      },
    ],
    ok: false,
    reason: "forbidden",
  };
}

/** Who a commit the Worker makes names as its author: the person, the key's name, or the owner. */
function authorOf(session: Session) {
  const id = keyIdOf(session) ?? "shelfkit";
  const email = `${id.replaceAll(":", "-")}@shelfkit.invalid`;
  if (session.kind === "person") {
    return { email, name: session.person.name };
  }
  if (session.kind === "owner") {
    return { email, name: session.person?.name ?? "owner" };
  }
  if (session.kind === "key") {
    return { email, name: session.name };
  }
  return { email, name: "shelfkit" };
}

/** A promise that settles when `work` does, and never rejects: the next queued write runs whatever this one did. */
async function settled(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    // The write's own caller gets its error.
  }
}

function keyIdOf(session: Session): string | null {
  if (session.kind === "owner" || session.kind === "key") {
    return session.keyId;
  }
  if (session.kind === "person") {
    return session.person.id;
  }
  return session.kind === "system" ? "system" : null;
}

function summaryOf(row: typeof table.item.$inferSelect): ItemSummary {
  return {
    description: row.description,
    id: row.id,
    kind: v.parse(ItemKindSchema, row.kind),
    revision: row.revision,
    tags: row.tags,
    title: row.title,
  };
}

function profileSummaryOf(row: typeof table.profile.$inferSelect) {
  return {
    description: row.document.description ?? "",
    id: row.id,
    revision: row.revision,
    title: row.title,
  };
}

function snapshotRecord(
  row: typeof table.snapshot.$inferSelect
): SnapshotRecord {
  return {
    commit: row.commit,
    createdAt: row.createdAt,
    digest: row.digest,
    fileCount: row.fileCount,
    keyId: row.keyId,
    message: row.message,
    origin: v.parse(
      v.picklist(["push", "forge", "edit", "import", "git"]),
      row.origin
    ),
    parent: row.parent,
    totalBytes: row.totalBytes,
  };
}

function scanRecord(row: typeof table.scan.$inferSelect): ScanRecord {
  return {
    detailsUrl: row.detailsUrl,
    id: row.id,
    observed: row.observed,
    recordedAt: row.recordedAt,
    revision: row.revision,
    scanner: row.scanner,
    summary: row.summary,
    verdict: v.parse(ScanVerdictSchema.entries.verdict, row.verdict),
  };
}

/** Whether the Worker has a value for a secret name. */
function secretConfigured(env: Env, name: string): boolean {
  return Object.hasOwn(env, `SHELFKIT_SECRET_${name}`);
}

const PackageJsonSchema = v.looseObject({
  dependencies: v.optional(v.record(v.string(), v.unknown())),
  devDependencies: v.optional(v.record(v.string(), v.unknown())),
  optionalDependencies: v.optional(v.record(v.string(), v.unknown())),
  packageManager: v.optional(v.string()),
  peerDependencies: v.optional(v.record(v.string(), v.unknown())),
});

/** A repository's markers from a sample `package.json`, as `shelfkit recommend` reads them. */
export function markersOf(
  packageJson: string,
  files: readonly string[]
): Markers | { readonly error: string } {
  let parsed: v.InferOutput<typeof PackageJsonSchema>;
  try {
    parsed = v.parse(PackageJsonSchema, JSON.parse(packageJson));
  } catch (error) {
    return { error: `not a package.json: ${String(error)}` };
  }
  const dependencies = [
    ...new Set(
      [
        parsed.dependencies,
        parsed.devDependencies,
        parsed.peerDependencies,
        parsed.optionalDependencies,
      ].flatMap((entries) => Object.keys(entries ?? {}))
    ),
  ].toSorted(compare);
  const markers: Markers = {
    dependencies,
    files: ["package.json", ...files.filter((file) => file !== "package.json")],
  };
  return parsed.packageManager === undefined
    ? markers
    : { ...markers, packageManager: parsed.packageManager };
}
