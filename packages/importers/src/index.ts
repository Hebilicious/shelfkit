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
 * The adapters, in the order issue #8 wires them:
 * - `git`: a GitHub repository, by APM's package layouts, licence per artifact (`./adapters/git.ts`). This is also how
 *   `github/awesome-copilot` is read.
 * - `catalog`: the official MCP Registry and ClawHub (`./adapters/catalog.ts`).
 * - `shelfkit`: another ShelfKit instance's public profiles and items (`./adapters/shelfkit.ts`).
 *
 * The scanners: ShelfKit's own deterministic scanner, ClawHub's per-version verdict (taken only when the files match
 * byte for byte), and one scanner per skills.sh audit partner. Each source's terms, with citations, are in
 * `./terms.ts`.
 */
import type { Source } from "@shelfkit/schema";

import { catalogAdapter, catalogOf } from "./adapters/catalog.ts";
import { gitAdapter } from "./adapters/git.ts";
import { shelfkitAdapter } from "./adapters/shelfkit.ts";
import { clawHubScanner } from "./scanners/clawhub.ts";
import { skillsShScanners } from "./scanners/skills-sh.ts";
import { staticScanner } from "./scanners/static.ts";
import type { Scanner, SourceAdapter, SourceKind } from "./seam.ts";

export * from "./seam.ts";
export { ALL_TERMS } from "./terms.ts";
export type { SourceTerms } from "./terms.ts";

/** Every source adapter, one per kind at most. */
export const adapters: readonly SourceAdapter[] = [
  gitAdapter,
  catalogAdapter,
  shelfkitAdapter,
];

/** Every scanner: ShelfKit's own first, then the third-party verdicts, each of which covers only its own items. */
export const scanners: readonly Scanner[] = [
  staticScanner,
  clawHubScanner,
  ...skillsShScanners,
];

/** The adapter for a kind of source, or `undefined` when there is none yet. */
export function adapterFor(
  kind: SourceKind,
  from: readonly SourceAdapter[] = adapters
): SourceAdapter | undefined {
  return from.find((adapter) => adapter.kind === kind);
}

/**
 * The kind of source an imported item came from, read from its own `source`, for an item whose `source.id` names no
 * `shelf.json` source (it was imported from a pasted URL): `git` for a repository, `catalog` for a catalog ShelfKit
 * reads, `shelfkit` for any other URL with a `shelf/name` path (another instance), else `null`.
 */
export function sourceKindOf(source: Source): SourceKind | null {
  if (source.repo !== undefined) {
    return "git";
  }
  if (source.url === undefined) {
    return null;
  }
  if (catalogOf(source.url) !== undefined) {
    return "catalog";
  }
  return source.path?.includes("/") === true ? "shelfkit" : null;
}
