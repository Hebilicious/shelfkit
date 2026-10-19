/**
 * The importer seam's types and schemas: what the Worker's jobs and the adapters agree on. `index.ts` re-exports all
 * of it beside the adapters and scanners; it lives in its own module so the adapters can import it without a cycle.
 *
 * Every value an adapter returns is parsed with these schemas before the object stores it, because it describes
 * third-party data.
 */
import {
  SecretNameSchema,
  ItemIdSchema,
  ItemKindSchema,
  ItemSchema,
  SourceKindSchema,
} from "@shelfkit/schema";
import * as v from "valibot";

/** Where an import reads from: an entry of `shelf.json`'s `sources`, or a URL pasted into the Import screen. */
export const ImportSourceSchema = v.strictObject({
  kind: SourceKindSchema,
  /** A path inside the repository or package. */
  path: v.optional(v.string()),
  /** For a `shelfkit` source: the profile to import. */
  profile: v.optional(v.string()),
  /** A tag, branch, or commit to read; the default branch when absent. */
  ref: v.optional(v.string()),
  /** A Git repository. */
  repo: v.optional(v.string()),
  /**
   * The secret name of a credential the source needs (a token for a private repository or catalog). The adapter reads
   * it with `context.secret(name)`, which releases it only to the origin the owner bound the name to.
   */
  secret: v.optional(SecretNameSchema),
  /** The `id` of the `shelf.json` source this import reads, when it is one. */
  sourceId: v.optional(v.string()),
  /** The URL of a registry, catalog, marketplace, or another ShelfKit instance. */
  url: v.optional(v.string()),
});

/** What an import is pinned to upstream: the fields of an item's `source` that change when upstream moves. */
export const UpstreamPinSchema = v.strictObject({
  digest: v.optional(v.string()),
  ref: v.optional(v.string()),
  resolvedCommit: v.optional(v.string()),
  url: v.optional(v.string()),
  version: v.optional(v.string()),
});

/** One thing a source offers. */
export const CandidateSchema = v.strictObject({
  description: v.optional(v.string()),
  /** The item id it would get; the user may rename it when picking. */
  id: ItemIdSchema,
  /** The adapter's own handle for it, unique within the discovery. */
  key: v.pipe(v.string(), v.minLength(1)),
  kind: ItemKindSchema,
  /** The licence as the source states it, and its SPDX id. */
  license: v.optional(v.string()),
  licenseId: v.optional(v.string()),
  /** The source has no licence or forbids copying: importing it yields a link, never content. */
  linkOnly: v.boolean(),
  /** Where it is inside the source. */
  path: v.optional(v.string()),
  title: v.string(),
  /** What it is pinned to now. */
  upstream: UpstreamPinSchema,
});

export const DiscoverySchema = v.strictObject({
  candidates: v.array(CandidateSchema),
  warnings: v.array(v.string()),
});

/** What the user chose: a candidate, optionally renamed, optionally pinned to another ref or version. */
export const PickSchema = v.strictObject({
  candidate: v.string(),
  id: v.optional(ItemIdSchema),
  pin: v.optional(UpstreamPinSchema),
});

/** A file of an imported item, relative to the item directory. `item.json` is written from `item`, never from here. */
export const ImportedFileSchema = v.strictObject({
  contents: v.string(),
  encoding: v.picklist(["utf-8", "base64"]),
  path: v.pipe(v.string(), v.minLength(1)),
});

/**
 * An item ready to write into the shelf: its `item.json`, with `source` carrying the provenance, pin, licence, and
 * attribution, and its files. A link-only item has no content files.
 */
export const ImportedItemSchema = v.strictObject({
  files: v.array(ImportedFileSchema),
  item: ItemSchema,
  warnings: v.array(v.string()),
});

/** An imported item's upstream now, against what the item is pinned to. */
export const UpstreamStateSchema = v.strictObject({
  error: v.optional(v.string()),
  latest: v.optional(UpstreamPinSchema),
  status: v.picklist(["current", "moved", "gone", "error"]),
});

/** One scanner's verdict on one item revision. */
export const ScanVerdictSchema = v.strictObject({
  detailsUrl: v.optional(v.string()),
  /** What the scanner says it looked at (a commit, a version, its own digest), recorded beside our hash. */
  observed: v.optional(v.string()),
  scanner: v.pipe(v.string(), v.minLength(1)),
  summary: v.optional(v.string()),
  verdict: v.picklist(["clean", "suspicious", "malicious", "error"]),
});

export type ImportSource = v.InferOutput<typeof ImportSourceSchema>;
export type UpstreamPin = v.InferOutput<typeof UpstreamPinSchema>;
export type Candidate = v.InferOutput<typeof CandidateSchema>;
export type Discovery = v.InferOutput<typeof DiscoverySchema>;
export type Pick = v.InferOutput<typeof PickSchema>;
export type ImportedFile = v.InferOutput<typeof ImportedFileSchema>;
export type ImportedItem = v.InferOutput<typeof ImportedItemSchema>;
export type UpstreamState = v.InferOutput<typeof UpstreamStateSchema>;
export type ScanVerdict = v.InferOutput<typeof ScanVerdictSchema>;
export type SourceKind = v.InferOutput<typeof SourceKindSchema>;
export type Item = v.InferOutput<typeof ItemSchema>;

/** What an adapter may reach. There is no filesystem and no process: a Worker has neither. */
export interface AdapterContext {
  readonly fetch: typeof fetch;
  /**
   * The value of one of the shelf's secret names, for a source that needs a token (name it in the source's `secret`).
   * It is released only when the owner bound the name to the origin of this source's URL (or of its `https://` Git
   * repository); otherwise, or when the value is unset, `undefined`. A scanner gets no secret.
   */
  readonly secret: (name: string) => string | undefined;
  /** The time, RFC 3339 UTC. */
  readonly now: () => string;
}

/** One kind of source. */
export interface SourceAdapter {
  readonly kind: SourceKind;
  /** List what the source offers, pinned to what it resolves to now. */
  readonly discover: (
    source: ImportSource,
    context: AdapterContext
  ) => Promise<Discovery>;
  /** Fetch one picked candidate as an item, with provenance in `item.source`. */
  readonly fetch: (
    source: ImportSource,
    candidate: Candidate,
    pick: Pick,
    context: AdapterContext
  ) => Promise<ImportedItem>;
  /**
   * Compare an imported item's pin with its upstream now. `source` is the `shelf.json` source the item's `source.id`
   * names, when it names one: it carries the secret name a private upstream needs.
   */
  readonly checkUpstream: (
    item: Item,
    context: AdapterContext,
    source?: ImportSource
  ) => Promise<UpstreamState>;
}

/** The files of one item revision, as a scanner reads them. */
export interface ScanSubject {
  readonly item: Item;
  /** `sha256-<hex>`: the hash a verdict is recorded against. */
  readonly revision: string;
  readonly files: readonly ImportedFile[];
}

/**
 * A scanner: deterministic and non-AI first (`docs/PRD.md` section 11). A third-party scanner covers only the items
 * its provider has seen, and answers `null` for any other: no verdict is recorded, so the revision stays `unscanned`
 * rather than being marked with an error it did not earn.
 */
export interface Scanner {
  readonly id: string;
  readonly scan: (
    subject: ScanSubject,
    context: AdapterContext
  ) => Promise<ScanVerdict | null>;
}
