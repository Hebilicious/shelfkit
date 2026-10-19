/**
 * Source adapters and scanners: the seam between the hosted service's import jobs and the places items come from.
 *
 * The Worker owns the plumbing. A GraphQL `startImport` creates an import job in the shelf's Durable Object and queues
 * `import.discover`; the queue consumer finds the adapter for the source's kind with `adapterFor` and calls
 * `discover`, and the object stores the candidates. `pickImport` queues `import.apply`, which calls `fetch` for each
 * pick and hands the items to the object, which writes them into the shelf as a new snapshot after the engine has
 * validated the whole shelf. The hourly cron queues `upstream.check` for every shelf, which calls `checkUpstream` for
 * each imported item and records drift. `scan.item` runs every scanner on one item revision and records each verdict
 * against that revision, the hash ShelfKit computed (`docs/PRD.md` section 11).
 *
 * Every value an adapter returns is parsed with the schemas below before the object stores it, because it describes
 * third-party data. This package has no adapter yet: issue #8 adds them to `adapters` and `scanners`, and changes
 * nothing outside this package.
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
  /** Compare an imported item's pin with its upstream now. */
  readonly checkUpstream: (
    item: Item,
    context: AdapterContext
  ) => Promise<UpstreamState>;
}

/** The files of one item revision, as a scanner reads them. */
export interface ScanSubject {
  readonly item: Item;
  /** `sha256-<hex>`: the hash a verdict is recorded against. */
  readonly revision: string;
  readonly files: readonly ImportedFile[];
}

/** A scanner: deterministic and non-AI first (`docs/PRD.md` section 11). */
export interface Scanner {
  readonly id: string;
  readonly scan: (
    subject: ScanSubject,
    context: AdapterContext
  ) => Promise<ScanVerdict>;
}

/** Every source adapter, one per kind at most. None yet: issue #8. */
export const adapters: readonly SourceAdapter[] = [];

/** Every scanner. None yet: issue #8. */
export const scanners: readonly Scanner[] = [];

/** The adapter for a kind of source, or `undefined` when there is none yet. */
export function adapterFor(
  kind: SourceKind,
  from: readonly SourceAdapter[] = adapters
): SourceAdapter | undefined {
  return from.find((adapter) => adapter.kind === kind);
}
