/**
 * The messages on the `shelfkit-jobs` queue: work that outlives a request. Each names its shelf, and the consumer
 * (`src/jobs/consumer.ts`) runs it with a `system` session against that shelf's object.
 *
 * - `import.discover`: ask the import job's source what it offers (`SourceAdapter.discover`).
 * - `import.apply`: fetch the picked candidates and write them into the shelf (`SourceAdapter.fetch`).
 * - `upstream.check`: compare every imported item with its upstream (`SourceAdapter.checkUpstream`); the hourly cron
 *   queues one per shelf.
 * - `scan.item`: run every scanner on one item revision and record each verdict against that revision.
 * - `index.forge`: read a shelf from a Git forge, snapshot it into R2, and commit it (`src/forge/`).
 * - `repository.sync`: index the head of the shelf's repository (`ShelfIndex.syncRepository`), queued by the Git route
 *   once a push through it is done, which then indexes it at once too; the job retries an index that failed.
 */
import { ItemIdSchema, RevisionSchema, ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

export const JobMessageSchema = v.variant("type", [
  v.strictObject({
    job: v.string(),
    shelf: ShelfIdSchema,
    type: v.literal("import.discover"),
  }),
  v.strictObject({
    job: v.string(),
    shelf: ShelfIdSchema,
    type: v.literal("import.apply"),
  }),
  v.strictObject({ shelf: ShelfIdSchema, type: v.literal("upstream.check") }),
  v.strictObject({
    item: ItemIdSchema,
    /** The revision to scan; the item's current one when absent. */
    revision: v.optional(RevisionSchema),
    shelf: ShelfIdSchema,
    type: v.literal("scan.item"),
  }),
  v.strictObject({
    /** A branch, tag, or commit; the default branch when absent. */
    ref: v.optional(v.string()),
    /** `owner/repo` on GitHub, or the HTTPS URL of a public Git repository anywhere else. */
    repository: v.union([
      v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/u, "must be owner/repo")),
      v.pipe(v.string(), v.url(), v.startsWith("https://")),
    ]),
    /** A directory in the repository that holds the shelf; the root when absent. */
    root: v.optional(v.string()),
    shelf: ShelfIdSchema,
    type: v.literal("index.forge"),
  }),
  v.strictObject({ shelf: ShelfIdSchema, type: v.literal("repository.sync") }),
]);

export type JobMessage = v.InferOutput<typeof JobMessageSchema>;
