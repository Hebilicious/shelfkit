/**
 * The Worker's Durable Object classes: the model `wrangler.jsonc`'s `durable_objects.bindings` and `migrations` are
 * generated from (`scripts/durable-objects.ts`, `moon run worker:do-migrations`). Wrangler applies migrations by tag,
 * in order, so the generator only appends: a class added here gets a `new_sqlite_classes` entry, and a class removed
 * gets a `deleted_classes` entry. The gate (`moon run worker:do-migrations-check`) fails when the two disagree, or
 * when `src/index.ts` does not export a class.
 */
export interface DurableObjectClass {
  /** The binding the Worker reaches it by. */
  readonly binding: string;
  /** The exported class. */
  readonly className: string;
}

export const DURABLE_OBJECTS: readonly DurableObjectClass[] = [
  { binding: "SHELF", className: "ShelfIndex" },
];
