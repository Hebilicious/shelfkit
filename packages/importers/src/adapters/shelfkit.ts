/**
 * Another ShelfKit instance (`docs/PRD.md` section 7.2): its public profiles and items, re-exported with provenance
 * pointing at it. A source's `url` is the instance and its `path` the shelf (its registry namespace).
 *
 * - A **profile** imports as a reference to the package the instance publishes, `{shelf}/{profile}` on
 *   `{url}/apm`, pinned to a version and its digest. Nothing is copied, so it needs no licence; compiling it needs
 *   the instance declared in `shelf.json` as a `shelfkit` source, which the item's `source.id` names.
 * - An **item** keeps its own upstream when it has one (its repository, path, commit, licence, and credit travel
 *   with it), and its content when that licence permits copies. An item authored on the instance states no licence,
 *   so it imports as a link: provenance and a record URL, no content.
 *
 * Drift: a profile has `moved` when the instance publishes a newer version; an item when its revision there changed.
 */
import { ItemKindSchema, SourceSchema } from "@shelfkit/schema";
import type { Source } from "@shelfkit/schema";
import * as v from "valibot";

import { byCodePoint, getJson, graphql } from "../http.ts";
import { kebab, uniqueIds } from "../ids.ts";
import {
  importedItem,
  linkOnlyWarning,
  provenance,
  sourceOf,
} from "../imported.ts";
import { fromSpdx, NO_LICENCE } from "../licence.ts";
import type {
  AdapterContext,
  Candidate,
  Discovery,
  ImportedFile,
  ImportedItem,
  ImportSource,
  Item,
  Pick,
  SourceAdapter,
  UpstreamState,
} from "../seam.ts";

/** A profile reference copies nothing, and the instance states no licence for it. */
const PROFILE_LICENCE =
  "none stated; a reference to the instance's registry package, nothing is copied";

const VersionsSchema = v.object({
  versions: v.array(
    v.object({
      digest: v.string(),
      published_at: v.optional(v.string()),
      version: v.string(),
    })
  ),
});

type Published = v.InferOutput<typeof VersionsSchema>["versions"][number];

/** An item.json as the instance serves it: the fields this adapter reads, and the rest kept as they are. */
const DocumentSchema = v.looseObject({
  id: v.string(),
  kind: ItemKindSchema,
  source: v.optional(SourceSchema),
  title: v.string(),
});

type Document = v.InferOutput<typeof DocumentSchema>;

const ShelfSchema = v.object({
  shelf: v.nullable(
    v.object({
      items: v.object({
        nodes: v.array(
          v.object({
            item: v.object({ document: DocumentSchema, revision: v.string() }),
          })
        ),
      }),
      profiles: v.array(
        v.object({ description: v.string(), id: v.string(), title: v.string() })
      ),
    })
  ),
});

const ItemSchema = v.object({
  shelf: v.nullable(
    v.object({
      item: v.nullable(
        v.object({
          document: DocumentSchema,
          files: v.array(
            v.object({
              contents: v.string(),
              encoding: v.picklist(["utf-8", "base64"]),
              path: v.string(),
            })
          ),
          revision: v.string(),
        })
      ),
    })
  ),
});

const RevisionSchema = v.object({
  shelf: v.nullable(
    v.object({ item: v.nullable(v.object({ revision: v.string() })) })
  ),
});

const SHELF_QUERY = `query Shelf($shelf: ID!) {
  shelf(id: $shelf) {
    profiles { id title description }
    items(limit: 500) { nodes { item { revision document } } }
  }
}`;

const ITEM_QUERY = `query Item($shelf: ID!, $item: ID!) {
  shelf(id: $shelf) { item(id: $item) { revision document files { path contents encoding } } }
}`;

/** The query `shelfkit doctor` sends too, byte for byte (`crates/compiler/src/cli/doctor.rs`). */
const ITEM_REVISION_QUERY = `query ItemRevision($shelf: ID!, $item: ID!) {
  shelf(id: $shelf) { item(id: $item) { revision } }
}`;

function base(url: string | undefined): string {
  if (url === undefined) {
    throw new Error("a shelfkit source needs `url`, the instance");
  }
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

function shelfOf(source: ImportSource): string {
  const shelf = source.path?.trim().replaceAll(/^\/+|\/+$/gu, "") ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(shelf)) {
    throw new Error("name the shelf (its registry namespace) in `path`");
  }
  return shelf;
}

export function packageVersionsUrl(
  instance: string,
  shelf: string,
  profile: string
): string {
  return `${instance}/apm/v1/packages/${shelf}/${profile}/versions`;
}

/** Where a person reads an item on the instance. */
function itemRecordUrl(instance: string, shelf: string, id: string): string {
  return `${instance}/item?shelf=${encodeURIComponent(shelf)}&id=${encodeURIComponent(id)}`;
}

/** The newest published version: the latest `published_at`, else the last listed. */
function newest(versions: readonly Published[]): Published | undefined {
  return versions
    .toSorted((a, b) => byCodePoint(a.published_at ?? "", b.published_at ?? ""))
    .at(-1);
}

/** `sha256-<hex>` (a revision) as `sha256:<hex>` (a digest). */
function revisionDigest(revision: string): string {
  return revision.replace(/^sha256-/u, "sha256:");
}

/** The licence an item on the instance carries in its own `source`. */
interface Carried {
  readonly statement: string;
  readonly id: string | undefined;
  readonly permitsCopy: boolean;
}

function carriedLicence(document: Document): Carried {
  const id = document.source?.licenseId;
  const known = id === undefined ? undefined : fromSpdx(id);
  const statement =
    document.source?.license ?? known?.statement ?? NO_LICENCE.statement;
  return { id: known?.id ?? id, permitsCopy: known !== undefined, statement };
}

/** The newest published version of a profile, or `undefined` when it is not published. */
async function published(
  context: AdapterContext,
  instance: string,
  shelf: string,
  profile: string
) {
  const found = await getJson(
    context.fetch,
    packageVersionsUrl(instance, shelf, profile),
    VersionsSchema
  );
  return found === null ? undefined : newest(found.versions);
}

/** Candidates for the published profiles, without ids yet. */
async function profileCandidates(
  context: AdapterContext,
  instance: string,
  shelf: string,
  profiles: readonly { id: string; title: string; description: string }[]
): Promise<{ candidates: Omit<Candidate, "id">[]; warnings: string[] }> {
  const versions = await Promise.all(
    profiles.map(
      async (profile) => await published(context, instance, shelf, profile.id)
    )
  );
  const candidates: Omit<Candidate, "id">[] = [];
  const warnings: string[] = [];
  for (const [index, profile] of profiles.entries()) {
    const latest = versions[index];
    if (latest === undefined) {
      warnings.push(
        `${shelf}/${profile.id} is not published on ${instance}/apm, so it cannot be referenced`
      );
      continue;
    }
    const candidate: Omit<Candidate, "id"> = {
      key: `profile:${profile.id}`,
      kind: "instructions",
      license: PROFILE_LICENCE,
      linkOnly: true,
      path: `${shelf}/${profile.id}`,
      title: `${profile.title} (${shelf}/${profile.id})`,
      upstream: {
        digest: latest.digest,
        url: instance,
        version: latest.version,
      },
    };
    if (profile.description !== "") {
      candidate.description = profile.description;
    }
    candidates.push(candidate);
  }
  return { candidates, warnings };
}

/** A candidate for one item on the instance, without its id yet. */
function itemCandidate(
  instance: string,
  shelf: string,
  document: Document,
  revision: string
): Omit<Candidate, "id"> {
  const licence = carriedLicence(document);
  const candidate: Omit<Candidate, "id"> = {
    key: `item:${document.id}`,
    kind: document.kind,
    license: licence.statement,
    linkOnly: !licence.permitsCopy && document.kind !== "mcp",
    path: `${shelf}/${document.id}`,
    title: document.title,
    upstream: { digest: revisionDigest(revision), url: instance },
  };
  if (licence.id !== undefined) {
    candidate.licenseId = licence.id;
  }
  return candidate;
}

async function discover(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const instance = base(source.url);
  const shelf = shelfOf(source);
  const data = await graphql(
    context.fetch,
    `${instance}/graphql`,
    SHELF_QUERY,
    { shelf },
    ShelfSchema
  );
  if (data.shelf === null) {
    throw new Error(`${instance} has no public shelf \`${shelf}\``);
  }
  const profiles = data.shelf.profiles.filter(
    (profile) => source.profile === undefined || profile.id === source.profile
  );
  const found = await profileCandidates(context, instance, shelf, profiles);
  const items =
    source.profile === undefined
      ? data.shelf.items.nodes.map(({ item }) =>
          itemCandidate(instance, shelf, item.document, item.revision)
        )
      : [];
  const pending = [...found.candidates, ...items];
  const ids = uniqueIds(
    pending.map((candidate) => ({
      name: candidate.key.startsWith("profile:")
        ? `${shelf}-${candidate.key.slice(8)}`
        : candidate.key.slice(5),
      qualifier: candidate.key.startsWith("profile:")
        ? "profile"
        : kebab(shelf),
    }))
  );
  const candidates = pending.map((candidate, index) => ({
    ...candidate,
    id: ids[index] ?? "item",
  }));
  const warnings = [...found.warnings];
  const links = items.filter((candidate) => candidate.linkOnly).length;
  if (links > 0) {
    warnings.push(
      `${links} items on ${instance}/${shelf} state no licence; they import as links to the instance, without content`
    );
  }
  return { candidates, warnings };
}

/** A profile, as a pinned reference to the instance's registry package. */
async function fetchProfile(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  const instance = base(source.url);
  const shelf = shelfOf(source);
  const profile = candidate.key.slice("profile:".length);
  const url = packageVersionsUrl(instance, shelf, profile);
  const found = await getJson(context.fetch, url, VersionsSchema);
  const versions = found?.versions ?? [];
  const wanted = pick.pin?.version ?? candidate.upstream.version;
  const pinned =
    wanted === undefined
      ? newest(versions)
      : versions.find((version) => version.version === wanted);
  if (pinned === undefined) {
    throw new Error(`${url}: no published version ${wanted ?? ""}`);
  }
  const id = pick.id ?? candidate.id;
  const warnings =
    source.sourceId === undefined
      ? [
          `${id}: declare ${instance} as a \`shelfkit\` source in shelf.json and name it in the item's source.id to compile this reference`,
        ]
      : [];
  return importedItem({
    files: [],
    item: {
      description: candidate.description,
      id,
      kind: "instructions",
      source: provenance({
        digest: pinned.digest,
        id: source.sourceId,
        license: PROFILE_LICENCE,
        linkTarget: instance,
        path: `${shelf}/${profile}`,
        recordUrl: url,
        url: instance,
        version: pinned.version,
      }),
      title: candidate.title,
    },
    linkOnly: false,
    warnings,
  });
}

/** The provenance of a re-exported item: its own upstream when it has one, else the instance. */
function reexported(
  document: Document,
  revision: string,
  instance: string,
  shelf: string,
  sourceId?: string
): Source {
  const upstream = document.source ?? {};
  const fromInstance =
    upstream.repo === undefined && upstream.url === undefined;
  return provenance({
    ...upstream,
    digest: fromInstance ? revisionDigest(revision) : upstream.digest,
    id: sourceId,
    license: carriedLicence(document).statement,
    linkTarget: upstream.linkTarget ?? instance,
    path: fromInstance ? `${shelf}/${document.id}` : upstream.path,
    recordUrl: itemRecordUrl(instance, shelf, document.id),
    url: fromInstance ? instance : upstream.url,
  });
}

/** An item, re-exported: its content when its own licence permits copies, else a link. */
async function fetchItem(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  const instance = base(source.url);
  const shelf = shelfOf(source);
  const itemId = candidate.key.slice("item:".length);
  const data = await graphql(
    context.fetch,
    `${instance}/graphql`,
    ITEM_QUERY,
    { item: itemId, shelf },
    ItemSchema
  );
  const found = data.shelf?.item ?? null;
  if (found === null) {
    throw new Error(`${instance} has no public item \`${shelf}/${itemId}\``);
  }
  const { document } = found;
  const id = pick.id ?? candidate.id;
  const linkOnly =
    !carriedLicence(document).permitsCopy && document.kind !== "mcp";
  const files: ImportedFile[] = found.files.filter(
    (file) => file.path !== "item.json"
  );
  const provenanceOf = reexported(
    document,
    found.revision,
    instance,
    shelf,
    source.sourceId
  );
  // A link carries only what identifies the item; a copy keeps the whole document.
  const item = linkOnly
    ? { id, kind: document.kind, source: provenanceOf, title: document.title }
    : { ...document, id, source: provenanceOf };
  const record = itemRecordUrl(instance, shelf, itemId);
  return importedItem({
    files,
    item,
    linkOnly,
    warnings: linkOnly
      ? [
          linkOnlyWarning(
            id,
            `${instance}/${shelf} states no licence for it`,
            record
          ),
        ]
      : [],
  });
}

/** An item imported from a ShelfKit instance: the instance, the shelf, and the profile or item it names. */
export interface ShelfkitRef {
  readonly instance: string;
  readonly shelf: string;
  readonly name: string;
  readonly profile: boolean;
}

/** Whether an item was imported from a ShelfKit instance, and from which shelf. */
export function shelfkitRef(item: Item): ShelfkitRef | undefined {
  const source = sourceOf(item);
  if (source.url === undefined || source.path === undefined) {
    return undefined;
  }
  const [shelf, name] = source.path.split("/");
  if (shelf === undefined || name === undefined) {
    return undefined;
  }
  return {
    instance: base(source.url),
    name,
    profile: source.version !== undefined,
    shelf,
  };
}

async function checkProfile(
  ref: ShelfkitRef,
  source: Source,
  context: AdapterContext
): Promise<UpstreamState> {
  const latest = await published(context, ref.instance, ref.shelf, ref.name);
  if (latest === undefined) {
    return { status: "gone" };
  }
  return {
    latest: {
      digest: latest.digest,
      url: ref.instance,
      version: latest.version,
    },
    status: latest.version === source.version ? "current" : "moved",
  };
}

async function checkUpstream(
  item: Item,
  context: AdapterContext
): Promise<UpstreamState> {
  const ref = shelfkitRef(item);
  const source = sourceOf(item);
  if (ref === undefined) {
    return { error: "the item names no ShelfKit shelf", status: "error" };
  }
  if (ref.profile) {
    return await checkProfile(ref, source, context);
  }
  const data = await graphql(
    context.fetch,
    `${ref.instance}/graphql`,
    ITEM_REVISION_QUERY,
    { item: ref.name, shelf: ref.shelf },
    RevisionSchema
  );
  const revision = data.shelf?.item?.revision;
  if (revision === undefined) {
    return { status: "gone" };
  }
  const digest = revisionDigest(revision);
  return {
    latest: { digest, url: ref.instance },
    status: digest === source.digest ? "current" : "moved",
  };
}

export const shelfkitAdapter: SourceAdapter = {
  checkUpstream,
  discover,
  fetch: async (source, candidate, pick, context) =>
    candidate.key.startsWith("profile:")
      ? await fetchProfile(source, candidate, pick, context)
      : await fetchItem(source, candidate, pick, context),
  kind: "shelfkit",
};
