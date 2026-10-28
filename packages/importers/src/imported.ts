/**
 * Turning what an adapter found into an `ImportedItem`: the item's `source` (provenance, pin, licence, attribution)
 * and the one rule every adapter shares, that a link-only import carries no content.
 */
import { SourceSchema } from "@shelfkit/schema";
import type { Source } from "@shelfkit/schema";
import * as v from "valibot";

import { docPathIn } from "./docs.ts";
import { byCodePoint } from "./http.ts";
import type {
  AdapterContext,
  Candidate,
  ImportedFile,
  ImportedItem,
  ImportSource,
  Item,
  Pick,
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

/** A `source` with every unset or empty field left out, so item.json holds only what is known. */
export function provenance(fields: Source): Source {
  return v.parse(
    SourceSchema,
    Object.fromEntries(
      Object.entries(fields).filter(
        ([, value]) => value !== undefined && value !== ""
      )
    )
  );
}

/** The warning a link-only import carries: what was withheld, why, and where the content stays. */
export function linkOnlyWarning(
  id: string,
  reason: string,
  where: string | undefined
): string {
  const target = where === undefined ? "" : ` to ${where}`;
  return `${id}: ${reason}, so it was imported as a link${target}, without its content`;
}

/** What an adapter assembled, before it is checked. */
export interface ImportedDraft {
  /** BOUNDARY: the item.json an adapter built from upstream data; `importedItem` parses it. */
  readonly item: object;
  readonly files: readonly ImportedFile[];
  readonly linkOnly: boolean;
  readonly warnings: readonly string[];
}

/** The fields an item may carry from upstream text, which a link-only import leaves out. */
const LinkOnlySchema = v.pipe(
  v.looseObject({ description: v.optional(v.unknown()) }),
  v.transform(({ description: _withheld, ...rest }) => rest)
);

/**
 * Assemble an imported item and check it against the schemas the Worker parses it with, so an adapter bug fails
 * here, naming the item, rather than as a rejected snapshot. A link-only item drops its files and its description
 * (text copied from the work), whatever the adapter passed. Unset fields are left out, as item.json leaves them.
 */
export function importedItem(draft: ImportedDraft): ImportedItem {
  // BOUNDARY: a JSON round trip drops unset fields, as writing item.json does.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the round trip is the point: it drops `undefined`.
  const plain: unknown = JSON.parse(JSON.stringify(draft.item));
  const item = draft.linkOnly ? v.parse(LinkOnlySchema, plain) : plain;
  const parsed = v.safeParse(ImportedItemSchema, {
    files: draft.linkOnly ? [] : [...draft.files],
    item,
    warnings: [...draft.warnings],
  });
  if (!parsed.success) {
    const id = v.safeParse(v.object({ id: v.string() }), plain);
    throw new Error(
      `${id.success ? id.output.id : "an imported item"}: the importer built an invalid item: ${parsed.issues
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

/** One picked candidate, and the item its adapter fetched for it. */
export interface Fetched {
  readonly candidate: Candidate;
  readonly pick: Pick;
  readonly imported: ImportedItem;
}

/** A doc already on the shelf, by the `path` it installs at: an imported item that links to that path requires it. */
export interface ShelfDoc {
  readonly id: string;
  readonly path: string;
}

/** What an import's links can reach besides the items picked with it. */
export interface LinkTargets {
  /** Every candidate the discovery offered, picked or not. */
  readonly candidates: readonly Candidate[];
  /** The docs already on the shelf. */
  readonly docs: readonly ShelfDoc[];
  /** The tree the import read: its source's `path`, which a doc's `path` is relative to (`docPathIn`). */
  readonly tree: string | undefined;
}

/** An import's links reach only what was picked with it. */
const NOTHING_ELSE: LinkTargets = { candidates: [], docs: [], tree: undefined };

/**
 * The items of one import, each requiring the others it links to (`Candidate.requires`): an AGENTS.md imported with
 * the docs it links to requires them, so a profile that selects it installs them too, and its links resolve. A linked
 * candidate picked in the same import is required under the id it was picked as. One left out is required as the doc
 * already on the shelf at the `path` it would get, since that is the doc the compiler points the link at; with no such
 * doc, or more than one, the link stays a link, and the item says so.
 */
export function requireLinked(
  fetched: readonly Fetched[],
  targets: LinkTargets = NOTHING_ELSE
): ImportedItem[] {
  const picked = new Map(
    fetched.map(({ candidate, imported }) => [candidate.key, imported.item.id])
  );
  const offered = new Map(
    targets.candidates.map((candidate) => [candidate.key, candidate])
  );
  return fetched.map(({ candidate, imported }) => {
    const linked: string[] = [];
    const warnings: string[] = [];
    for (const key of candidate.requires ?? []) {
      const id =
        picked.get(key) ?? onShelf(offered.get(key), targets, warnings);
      if (id !== undefined && id !== imported.item.id) {
        linked.push(id);
      }
    }
    if (linked.length === 0 && warnings.length === 0) {
      return imported;
    }
    const requires = [
      ...new Set([...(imported.item.requires ?? []), ...linked]),
    ].toSorted(byCodePoint);
    return {
      ...imported,
      item:
        requires.length === 0 ? imported.item : { ...imported.item, requires },
      warnings: [
        ...imported.warnings,
        ...warnings.map((warning) => `${imported.item.id}: ${warning}`),
      ],
    };
  });
}

/** The id of the doc on the shelf a linked candidate that was not picked would be, or `undefined`, noting why. */
function onShelf(
  linked: Candidate | undefined,
  targets: LinkTargets,
  warnings: string[]
): string | undefined {
  if (linked?.kind !== "doc" || linked.path === undefined) {
    return undefined;
  }
  const path = docPathIn(targets.tree, linked.path);
  const docs = targets.docs.filter((doc) => doc.path === path);
  const [only] = docs;
  if (docs.length > 1) {
    warnings.push(
      `links to ${path}, which ${docs.length} docs on the shelf have (${docs.map((doc) => doc.id).join(", ")}), so it requires none of them; add the one it means to its requires`
    );
    return undefined;
  }
  return only?.id;
}
