/**
 * The shelf's own database: one SQLite database per Durable Object, one object per shelf.
 *
 * Everything here is metadata. File bytes and snapshot manifests live in R2 under `objects/<sha256>`, published
 * registry archives under `archives/<sha256>`, and a row names them by hash. The full-text index (`item_search`,
 * created by hand in a migration because Drizzle does not model FTS5 tables) is contentless: it holds the index's
 * terms and no text, and snippets are cut from the content in R2.
 *
 * Migrations are generated from this file by `moon run worker:db-generate` and run inside the object, in its
 * constructor, behind `blockConcurrencyWhile` (`src/db/migrate.ts`). Never edit a generated migration.
 */
import type {
  Candidate,
  ImportSource,
  Pick,
  UpstreamPin,
} from "@shelfkit/importers";
import type {
  Bundle,
  Coordinate,
  Item,
  Profile,
  ResolvedProfile,
} from "@shelfkit/schema";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Key-value facts about the shelf: its id, the current snapshot, the schema version, the latest notices. */
export const meta = sqliteTable("meta", {
  key: text().primaryKey(),
  value: text().notNull(),
});

/** Every snapshot the shelf has had. The manifest (path, sha256, size per file) is the R2 object `digest`. */
export const snapshot = sqliteTable("snapshot", {
  createdAt: text("created_at").notNull(),
  /** `sha256:<hex>` of the canonical manifest. */
  digest: text().primaryKey(),
  fileCount: integer("file_count").notNull(),
  /** The key that made it: a key id, or `owner`. */
  keyId: text("key_id"),
  message: text(),
  /** `push`, `forge`, `edit`, or `import`. */
  origin: text().notNull(),
  parent: text(),
  totalBytes: integer("total_bytes").notNull(),
});

/** The current snapshot's files. */
export const file = sqliteTable("file", {
  path: text().primaryKey(),
  /** Lowercase hex; the R2 object is `objects/<sha256>`. */
  sha256: text().notNull(),
  size: integer().notNull(),
});

/** Every R2 object this shelf references or uploaded, so a key reads only its own shelf's objects. */
export const blob = sqliteTable("blob", {
  createdAt: text("created_at").notNull(),
  /**
   * 1 once a committed snapshot, an item revision, or a published version names the object. An upload that no commit
   * names is 0, and `/raw` does not serve it.
   */
  referenced: integer().notNull().default(0),
  sha256: text().primaryKey(),
  size: integer().notNull(),
});

/** The current state of every item. `document` is its item.json. */
export const item = sqliteTable(
  "item",
  {
    coordinate: text({ mode: "json" }).$type<Coordinate>().notNull(),
    createdAt: text("created_at").notNull(),
    description: text().notNull(),
    document: text({ mode: "json" }).$type<Item>().notNull(),
    /** Paths relative to the item directory, sorted. */
    files: text({ mode: "json" }).$type<string[]>().notNull(),
    id: text().primaryKey(),
    kind: text().notNull(),
    path: text().notNull(),
    requires: text({ mode: "json" }).$type<string[]>().notNull(),
    revision: text().notNull(),
    tags: text({ mode: "json" }).$type<string[]>().notNull(),
    title: text().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("item_kind").on(table.kind)]
);

/** Every revision an item has had, with the files that made it. */
export const revision = sqliteTable(
  "revision",
  {
    createdAt: text("created_at").notNull(),
    document: text({ mode: "json" }).$type<Item>().notNull(),
    /** `[{ path, sha256, size }]`, paths relative to the item directory. */
    files: text({ mode: "json" })
      .$type<{ path: string; sha256: string; size: number }[]>()
      .notNull(),
    itemId: text("item_id").notNull(),
    keyId: text("key_id"),
    message: text(),
    revision: text().notNull(),
    snapshot: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.revision] })]
);

/** The current state of every profile, with its resolution. */
export const profile = sqliteTable("profile", {
  createdAt: text("created_at").notNull(),
  document: text({ mode: "json" }).$type<Profile>().notNull(),
  id: text().primaryKey(),
  path: text().notNull(),
  resolution: text({ mode: "json" }).$type<ResolvedProfile>().notNull(),
  revision: text().notNull(),
  title: text().notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Every revision a profile has resolved to. */
export const profileRevision = sqliteTable(
  "profile_revision",
  {
    createdAt: text("created_at").notNull(),
    document: text({ mode: "json" }).$type<Profile>().notNull(),
    profileId: text("profile_id").notNull(),
    revision: text().notNull(),
    snapshot: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.revision] })]
);

export const bundle = sqliteTable("bundle", {
  document: text({ mode: "json" }).$type<Bundle>().notNull(),
  id: text().primaryKey(),
});

/**
 * One published version of a registry package. The archive is `objects/<hex of digest>` in R2. The primary key is what
 * makes a publish insert-if-absent: a second row for the same version cannot exist.
 */
export const packageVersion = sqliteTable(
  "package_version",
  {
    digest: text().notNull(),
    keyId: text("key_id"),
    /** The package's identity, lowercase: `{owner}/{repo}`. */
    package: text().notNull(),
    publishedAt: text("published_at").notNull(),
    /** Publish order within the package. */
    sequence: integer().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    version: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.package, table.version] })]
);

/** A scoped API key. Only the SHA-256 of the key is kept; the plaintext is shown once, when it is created. */
export const apiKey = sqliteTable(
  "api_key",
  {
    createdAt: text("created_at").notNull(),
    /** Lowercase hex SHA-256 of the whole key. */
    hash: text().notNull(),
    id: text().primaryKey(),
    lastUsedAt: text("last_used_at"),
    name: text().notNull(),
    /** The first characters of the key, for recognising it in a list. Never enough to use it. */
    prefix: text().notNull(),
    revokedAt: text("revoked_at"),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
  },
  (table) => [uniqueIndex("api_key_hash").on(table.hash)]
);

/** Favourite items, per key. The owner key's id is `owner`. */
export const favourite = sqliteTable(
  "favourite",
  {
    createdAt: text("created_at").notNull(),
    itemId: text("item_id").notNull(),
    keyId: text("key_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.keyId, table.itemId] })]
);

/** Recently used items, per key: a copy, a view, a compile. */
export const recent = sqliteTable(
  "recent",
  {
    itemId: text("item_id").notNull(),
    keyId: text("key_id").notNull(),
    usedAt: text("used_at").notNull(),
    uses: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.keyId, table.itemId] })]
);

/** A compile applied to a repository, as `shelf.report` records it. */
export const activity = sqliteTable(
  "activity",
  {
    apmYmlDigest: text("apm_yml_digest").notNull(),
    commit: text(),
    id: text().primaryKey(),
    keyId: text("key_id"),
    message: text(),
    outcome: text().notNull(),
    profileId: text("profile_id").notNull(),
    profileRevision: text("profile_revision").notNull(),
    recordedAt: text("recorded_at").notNull(),
    repository: text().notNull(),
  },
  (table) => [
    index("activity_profile").on(table.profileId),
    index("activity_recorded").on(table.recordedAt),
  ]
);

/**
 * A scanner's verdict on one item revision. The revision is the hash ShelfKit computed, never a provider timestamp,
 * so a new revision starts unscanned and every verdict on a revision is kept, disagreeing ones included.
 */
export const scan = sqliteTable(
  "scan",
  {
    detailsUrl: text("details_url"),
    id: text().primaryKey(),
    itemId: text("item_id").notNull(),
    /** What the scanner reports it looked at, when it says (a commit, a version, its own digest). */
    observed: text(),
    recordedAt: text("recorded_at").notNull(),
    revision: text().notNull(),
    scanner: text().notNull(),
    summary: text(),
    /** `clean`, `suspicious`, `malicious`, or `error`. Absence of any row is `unscanned`. */
    verdict: text().notNull(),
  },
  (table) => [index("scan_item_revision").on(table.itemId, table.revision)]
);

/** What an imported item's upstream looked like when last checked, for drift. */
export const upstream = sqliteTable("upstream", {
  checkedAt: text("checked_at").notNull(),
  error: text(),
  itemId: text("item_id").primaryKey(),
  /** The upstream's state now: `{ resolvedCommit?, version?, digest?, url? }`. */
  latest: text({ mode: "json" }).$type<UpstreamPin>(),
  /** `current`, `moved`, `gone`, or `error`. */
  status: text().notNull(),
});

/** An import: a source, what it offers, what was picked, and how it went. */
export const importJob = sqliteTable("import_job", {
  candidates: text({ mode: "json" }).$type<Candidate[]>(),
  createdAt: text("created_at").notNull(),
  error: text(),
  id: text().primaryKey(),
  /** The item ids the import wrote. */
  imported: text({ mode: "json" }).$type<string[]>(),
  keyId: text("key_id"),
  picks: text({ mode: "json" }).$type<Pick[]>(),
  source: text({ mode: "json" }).$type<ImportSource>().notNull(),
  /** `queued`, `discovering`, `ready`, `importing`, `done`, or `failed`. */
  status: text().notNull(),
  updatedAt: text("updated_at").notNull(),
  warnings: text({ mode: "json" }).$type<string[]>(),
});

/**
 * The names of secrets the shelf's items may reference (`{ "secret": "NAME" }`). Values are never here: each is the
 * Worker secret `SHELFKIT_SECRET_<NAME>`, set with Wrangler.
 */
export const secretName = sqliteTable("secret_name", {
  createdAt: text("created_at").notNull(),
  description: text(),
  name: text().primaryKey(),
  /**
   * The one origin (`https://host[:port]`) the value may be sent to. A row from before origins were bound has none, and
   * its secret is released nowhere until the owner binds one.
   */
  origin: text(),
});

/**
 * The full-text index's rowids, one per item. The index itself (`item_search`, a contentless FTS5 table created by
 * hand in a migration) keeps no text, so it answers rowids and this maps them back to items.
 */
export const itemSearchRow = sqliteTable("item_search_row", {
  itemId: text("item_id").notNull().unique(),
  rowid: integer().primaryKey({ autoIncrement: true }),
});

/** A read-only link to one profile. Only the SHA-256 of the token is kept. */
export const shareLink = sqliteTable(
  "share_link",
  {
    createdAt: text("created_at").notNull(),
    id: text().primaryKey(),
    keyId: text("key_id"),
    profileId: text("profile_id").notNull(),
    revokedAt: text("revoked_at"),
    tokenHash: text("token_hash").notNull(),
  },
  (table) => [uniqueIndex("share_link_token").on(table.tokenHash)]
);
