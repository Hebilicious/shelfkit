/**
 * One Durable Object per shelf, holding its own SQLite database.
 *
 * Items, profiles, revisions, and scan records live here. Content lives in R2
 * keyed by `sha256`, so no database ever holds a blob. There is deliberately
 * no D1 database and no cross-shelf query. See docs/PRD.md section 10.1.
 */
import { DurableObject } from "cloudflare:workers";

export class ShelfIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // There is no CLI path to a Durable Object's SQLite, so schema setup runs
    // here behind blockConcurrencyWhile. `PRAGMA user_version` is unsupported,
    // so the schema version lives in a table.
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS item (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          revision TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }
}
