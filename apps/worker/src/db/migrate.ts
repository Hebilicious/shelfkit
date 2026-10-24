/**
 * Bring the shelf object's database up to date. Runs in the object's constructor, behind `blockConcurrencyWhile`,
 * because there is no CLI path to a Durable Object's SQLite.
 *
 * `PRAGMA user_version` is unsupported there, so the schema version is explicit: Drizzle records each migration it
 * applies in `__drizzle_migrations`, and `meta.schema_version` records how many this code's migrations are. An object
 * whose database is newer than the code running it (a rollback after a migration) refuses to start rather than read a
 * schema it does not know.
 */
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import bundle from "../../drizzle/migrations.js";
import { relations } from "./relations.ts";

export type ShelfDatabase = DrizzleSqliteDODatabase<typeof relations>;

/** How many migrations this code knows: the schema version it writes. */
export const SCHEMA_VERSION = Object.keys(bundle.migrations).length;

export function openDatabase(storage: DurableObjectStorage): ShelfDatabase {
  return drizzle(storage, { relations });
}

/**
 * Whether no migration has ever run here: an object that has never held a shelf. Drizzle's own table and `meta` are
 * the first things a migration makes. Reading `sqlite_master` writes nothing, so asking does not make the object's
 * storage exist.
 */
export function isUnmigrated(storage: DurableObjectStorage): boolean {
  return (
    storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', '__drizzle_migrations')"
      )
      .toArray().length === 0
  );
}

/** The schema version the database records; 0 for a new object. */
export function recordedVersion(storage: DurableObjectStorage): number {
  const tables = storage.sql
    .exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
    )
    .toArray();
  if (tables.length === 0) {
    return 0;
  }
  const [row] = storage.sql
    .exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    )
    .toArray();
  return row === undefined ? 0 : Number(row.value);
}

export function migrateDatabase(storage: DurableObjectStorage): void {
  const recorded = recordedVersion(storage);
  if (recorded > SCHEMA_VERSION) {
    throw new Error(
      `the shelf's database is at schema version ${recorded}, and this Worker knows ${SCHEMA_VERSION}: deploy a Worker at least as new as the one that migrated it`
    );
  }
  // Up to date: nothing to run and nothing to write, which is every wake but the first after a deploy that migrates.
  if (recorded === SCHEMA_VERSION) {
    return;
  }
  const failed = migrate(openDatabase(storage), bundle);
  if (failed !== undefined) {
    throw new Error(`the shelf's migrations did not run: ${failed.exitCode}`);
  }
  storage.sql.exec(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    String(SCHEMA_VERSION)
  );
}
