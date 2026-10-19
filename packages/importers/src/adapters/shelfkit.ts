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
import * as v from "valibot";

import { getJson, graphql } from "../http.ts";
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

const VersionsSchema = v.object({
  versions: v.array(
    v.object({
      digest: v.string(),
      published_at: v.optional(v.string()),
      version: v.string(),
    })
  ),
});

const ItemDocumentSchema = v.looseObject({
  id: v.string(),
  kind: v.string(),
  source: v.optional(v.record(v.string(), v.unknown())),
  title: v.string(),
});

const ShelfSchema = v.object({
  shelf: v.nullable(
    v.object({
      items: v.object({
        nodes: v.array(
          v.object({
            item: v.object({
              document: ItemDocumentSchema,
              revision: v.string(),
            }),
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
          document: ItemDocumentSchema,
          files: v.array(
            v.object({
              contents: v.string(),
              encoding: v.string(),
              path: v.string(),
            })
          ),
          revision: v.string(),
        })
      ),
    })
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

function shelfOf(source: { path?: string | undefined }): string {
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
function newest(
  versions: v.InferOutput<typeof VersionsSchema>["versions"]
): (typeof versions)[number] | undefined {
  return versions
    .toSorted((a, b) =>
      (a.published_at ?? "").localeCompare(b.published_at ?? "")
    )
    .at(-1);
}

/** `sha256-<hex>` (a revision) as `sha256:<hex>` (a digest). */
function revisionDigest(revision: string): string {
  return revision.replace(/^sha256-/u, "sha256:");
}

/** The licence an item on the instance carries in its own `source`, if it permits copies. */
function carriedLicence(document: {
  source?: Record<string, unknown> | undefined;
}): {
  statement: string;
  id: string | undefined;
  permitsCopy: boolean;
} {
  const id = document.source?.licenseId;
  const statement = document.source?.license;
  const known = typeof id === "string" ? fromSpdx(id) : undefined;
  return known === undefined
    ? {
        id: typeof id === "string" ? id : undefined,
        permitsCopy: false,
        statement:
          typeof statement === "string" ? statement : NO_LICENCE.statement,
      }
    : {
        id: known.id,
        permitsCopy: true,
        statement: typeof statement === "string" ? statement : known.statement,
      };
}

async function discover(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const instance = base(source.url);
  const shelf = shelfOf(source);
  const data = v.parse(
    ShelfSchema,
    await graphql(context.fetch, `${instance}/graphql`, SHELF_QUERY, { shelf })
  );
  if (data.shelf === null) {
    throw new Error(`${instance} has no public shelf \`${shelf}\``);
  }
  const profiles = data.shelf.profiles.filter(
    (profile) => source.profile === undefined || profile.id === source.profile
  );
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  const wanted: { name: string; qualifier: string }[] = [];
  const pending: Omit<Candidate, "id">[] = [];
  for (const profile of profiles) {
    const url = packageVersionsUrl(instance, shelf, profile.id);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one small listing per profile.
    const found = await getJson(context.fetch, url);
    const latest =
      found === null
        ? undefined
        : newest(v.parse(VersionsSchema, found).versions);
    if (latest === undefined) {
      warnings.push(
        `${shelf}/${profile.id} is not published on ${instance}/apm, so it cannot be referenced`
      );
      continue;
    }
    wanted.push({ name: `${shelf}-${profile.id}`, qualifier: "profile" });
    pending.push({
      ...(profile.description === ""
        ? {}
        : { description: profile.description }),
      key: `profile:${profile.id}`,
      kind: "instructions",
      license:
        "a reference to the instance's registry package; nothing is copied",
      linkOnly: true,
      path: `${shelf}/${profile.id}`,
      title: `${profile.title} (${shelf}/${profile.id})`,
      upstream: {
        digest: latest.digest,
        url: instance,
        version: latest.version,
      },
    });
  }
  if (source.profile === undefined) {
    for (const { item } of data.shelf.items.nodes) {
      const licence = carriedLicence(item.document);
      const remote = item.document.kind === "mcp";
      wanted.push({ name: item.document.id, qualifier: kebab(shelf) });
      pending.push({
        key: `item:${item.document.id}`,
        kind: v.parse(ItemKindPick, item.document.kind),
        license: licence.statement,
        ...(licence.id === undefined ? {} : { licenseId: licence.id }),
        linkOnly: !licence.permitsCopy && !remote,
        path: `${shelf}/${item.document.id}`,
        title: item.document.title,
        upstream: { digest: revisionDigest(item.revision), url: instance },
      });
    }
  }
  const ids = uniqueIds(wanted);
  for (const [index, candidate] of pending.entries()) {
    candidates.push({ ...candidate, id: ids[index] ?? "item" });
  }
  const linkOnly = candidates.filter(
    (candidate) => candidate.linkOnly && candidate.key.startsWith("item:")
  ).length;
  if (linkOnly > 0) {
    warnings.push(
      `${linkOnly} items on ${instance}/${shelf} state no licence; they import as links to the instance, without content`
    );
  }
  return { candidates, warnings };
}

const ItemKindPick = v.picklist([
  "skill",
  "prompt",
  "instructions",
  "agent",
  "hook",
  "plugin",
  "mcp",
  "lsp",
  "library",
  "stack",
]);

async function fetchItem(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  const instance = base(source.url);
  const shelf = shelfOf(source);
  const id = pick.id ?? candidate.id;

  if (candidate.key.startsWith("profile:")) {
    const profile = candidate.key.slice("profile:".length);
    const url = packageVersionsUrl(instance, shelf, profile);
    const found = await getJson(context.fetch, url);
    const versions =
      found === null ? [] : v.parse(VersionsSchema, found).versions;
    const wanted = pick.pin?.version ?? candidate.upstream.version;
    const published =
      versions.find((version) => version.version === wanted) ??
      (wanted === undefined ? newest(versions) : undefined);
    if (published === undefined) {
      throw new Error(`${url}: no published version ${wanted ?? ""}`);
    }
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
          digest: published.digest,
          id: source.sourceId,
          linkTarget: instance,
          path: `${shelf}/${profile}`,
          recordUrl: url,
          url: instance,
          version: published.version,
        }),
        title: candidate.title,
      },
      linkOnly: false,
      warnings,
    });
  }

  const itemId = candidate.key.slice("item:".length);
  const data = v.parse(
    ItemSchema,
    await graphql(context.fetch, `${instance}/graphql`, ITEM_QUERY, {
      item: itemId,
      shelf,
    })
  );
  const found = data.shelf?.item;
  if (found === undefined || found === null) {
    throw new Error(`${instance} has no public item \`${shelf}/${itemId}\``);
  }
  const record = itemRecordUrl(instance, shelf, itemId);
  const licence = carriedLicence(found.document);
  const upstream = found.document.source ?? {};
  const linkOnly = !licence.permitsCopy && found.document.kind !== "mcp";
  const files: ImportedFile[] = found.files
    .filter((file) => file.path !== "item.json")
    .map((file) => ({
      contents: file.contents,
      encoding: file.encoding === "base64" ? "base64" : "utf-8",
      path: file.path,
    }));
  // A link carries only what identifies the item; a copy keeps the whole document.
  const { source: _source, id: _id, ...document } = found.document;
  const kept: Record<string, unknown> = linkOnly
    ? { kind: found.document.kind, title: found.document.title }
    : document;
  const item = {
    ...kept,
    id,
    source: provenance({
      ...(upstream as Record<string, string | boolean | undefined>),
      ...(typeof upstream.repo === "string" || typeof upstream.url === "string"
        ? {}
        : {
            digest: revisionDigest(found.revision),
            path: `${shelf}/${itemId}`,
            url: instance,
          }),
      id: source.sourceId,
      linkTarget:
        typeof upstream.linkTarget === "string"
          ? upstream.linkTarget
          : instance,
      recordUrl: record,
    }),
  };
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

/** Whether an item was imported from a ShelfKit instance, and from which shelf. */
export function shelfkitRef(
  item: Item
):
  | { instance: string; shelf: string; name: string; profile: boolean }
  | undefined {
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
    const found = await getJson(
      context.fetch,
      packageVersionsUrl(ref.instance, ref.shelf, ref.name)
    );
    const latest =
      found === null
        ? undefined
        : newest(v.parse(VersionsSchema, found).versions);
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
  const data = v.parse(
    v.object({
      shelf: v.nullable(
        v.object({ item: v.nullable(v.object({ revision: v.string() })) })
      ),
    }),
    await graphql(
      context.fetch,
      `${ref.instance}/graphql`,
      ITEM_REVISION_QUERY,
      { item: ref.name, shelf: ref.shelf }
    )
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
  fetch: fetchItem,
  kind: "shelfkit",
};
