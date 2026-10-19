/**
 * Turning what an adapter found into an `ImportedItem`: the item's `source` (provenance, pin, licence, attribution)
 * and the one rule every adapter shares, that a link-only import carries no content.
 */
import type { Source } from "@shelfkit/schema";
import * as v from "valibot";

import type {
  AdapterContext,
  ImportedFile,
  ImportedItem,
  ImportSource,
  Item,
} from "./seam.ts";
import { ImportedItemSchema } from "./seam.ts";

/** The secret a source names, released only by the secret rule; `undefined` when it names none. */
export function sourceSecret(
  source: ImportSource,
  context: AdapterContext
): string | undefined {
  return source.secret === undefined
    ? undefined
    : context.secret(source.secret);
}

/** A `source` with every unset field left out, so item.json holds only what is known. */
export function provenance(fields: Source): Source {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) => value !== undefined && value !== ""
    )
  ) as Source;
}

/** The warning a link-only import carries: what was withheld, why, and where the content stays. */
export function linkOnlyWarning(
  id: string,
  reason: string,
  where: string | undefined
): string {
  return `${id}: ${reason}, so it was imported as a link${where === undefined ? "" : ` to ${where}`}, without its content`;
}

/**
 * Assemble an imported item and check it against the schemas the Worker parses it with, so an adapter bug fails
 * here, naming the item, rather than as a rejected snapshot. A link-only item drops its files and its description
 * (text copied from the work), whatever the caller passed.
 */
export function importedItem(input: {
  readonly item: Record<string, unknown>;
  readonly files: readonly ImportedFile[];
  readonly linkOnly: boolean;
  readonly warnings: readonly string[];
}): ImportedItem {
  const item: Record<string, unknown> = { ...input.item };
  if (input.linkOnly) {
    delete item.description;
  }
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) {
      delete item[key];
    }
  }
  const parsed = v.safeParse(ImportedItemSchema, {
    files: input.linkOnly ? [] : [...input.files],
    item,
    warnings: [...input.warnings],
  });
  if (!parsed.success) {
    const where = String(item.id ?? "an imported item");
    throw new Error(
      `${where}: the importer built an invalid item: ${parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.output;
}

/** An item's `source`, or an empty one for an authored item. */
export function sourceOf(item: Item): Source {
  return item.source ?? {};
}
