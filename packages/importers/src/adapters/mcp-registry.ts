/**
 * The official MCP Registry (and any registry serving its API): server definitions, pinned to a version.
 *
 * What is imported is the server's metadata, never a package: an `mcp` item whose `name` is the registry name, so APM
 * resolves the server from the registry, plus the first remote endpoint when the server has one. The official
 * registry's data is CC0 (`../terms.ts`); another registry's terms are unknown, so its items carry no description and
 * a warning, though their definitions (names and URLs) are kept, since a definition is the link.
 *
 * Drift reads the server's latest version: a different version is `moved`, a `deleted` status or a missing server is
 * `gone`.
 */
import * as v from "valibot";

import { canonicalJson, getJson, sha256Hex } from "../http.ts";
import { kebab, uniqueIds } from "../ids.ts";
import {
  importedItem,
  linkOnlyWarning,
  provenance,
  sourceOf,
} from "../imported.ts";
import { licenceFields, NO_LICENCE } from "../licence.ts";
import type { Licence } from "../licence.ts";
import type {
  AdapterContext,
  Candidate,
  Discovery,
  ImportedItem,
  ImportSource,
  Item,
  Pick,
  UpstreamState,
} from "../seam.ts";
import { MCP_REGISTRY_TERMS } from "../terms.ts";

export const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io";

const HeaderSchema = v.object({
  isRequired: v.optional(v.boolean()),
  isSecret: v.optional(v.boolean()),
  name: v.string(),
  value: v.optional(v.string()),
});

const ServerSchema = v.object({
  description: v.optional(v.string()),
  name: v.string(),
  remotes: v.optional(
    v.array(
      v.object({
        headers: v.optional(v.array(HeaderSchema)),
        type: v.string(),
        url: v.string(),
      })
    )
  ),
  repository: v.optional(v.object({ url: v.optional(v.string()) })),
  title: v.optional(v.string()),
  version: v.string(),
});

const EntrySchema = v.object({
  _meta: v.optional(
    v.object({
      "io.modelcontextprotocol.registry/official": v.optional(
        v.object({ status: v.optional(v.string()) })
      ),
    })
  ),
  server: v.looseObject(ServerSchema.entries),
});

const ListSchema = v.object({ servers: v.array(EntrySchema) });

type Entry = v.InferOutput<typeof EntrySchema>;
type Server = v.InferOutput<typeof ServerSchema>;

/** Whether a URL is this kind of catalog: the official registry, or a path under `/v0.1`. */
export function isMcpRegistry(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.origin === OFFICIAL_REGISTRY || parsed.pathname.startsWith("/v0")
  );
}

function origin(url: string): string {
  return new URL(url).origin;
}

/** The registry's terms: CC0 for the official registry, unknown for any other. */
function licenceOf(url: string): Licence {
  if (
    origin(url) === OFFICIAL_REGISTRY &&
    MCP_REGISTRY_TERMS.licence !== "per-artifact"
  ) {
    return MCP_REGISTRY_TERMS.licence;
  }
  return NO_LICENCE;
}

function versionUrl(url: string, name: string, version: string): string {
  return `${origin(url)}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

/** `sha256:` over the canonical JSON of a version's `server` document, as the registry served it. */
async function serverDigest(found: unknown): Promise<string> {
  const server = (found as { server?: unknown }).server;
  return `sha256:${await sha256Hex(canonicalJson(server))}`;
}

function statusOf(entry: Entry): string | undefined {
  return entry._meta?.["io.modelcontextprotocol.registry/official"]?.status;
}

/** A secret name for a header: `GITHUB_MCP_SERVER_AUTHORIZATION`. */
function secretName(id: string, header: string): string {
  return `${id}-${header}`
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+/u, "")
    .replace(/_+$/u, "");
}

/** The item fields a server definition becomes. */
function definition(id: string, server: Server): Record<string, unknown> {
  const remote = server.remotes?.[0];
  if (remote === undefined) {
    return { flavour: "remote", name: server.name };
  }
  const headers = Object.fromEntries(
    (remote.headers ?? [])
      .filter(
        (header) =>
          header.isSecret === true ||
          header.isRequired === true ||
          header.value !== undefined
      )
      .map((header) => [
        header.name,
        header.isSecret === true || header.value === undefined
          ? { secret: secretName(id, header.name) }
          : header.value,
      ])
  );
  const transport =
    remote.type === "sse" || remote.type === "http"
      ? remote.type
      : "streamable-http";
  return {
    flavour: "remote",
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    name: server.name,
    transport,
    url: remote.url,
  };
}

export async function discoverMcpRegistry(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  if (source.url === undefined) {
    throw new Error("an MCP registry source needs `url`");
  }
  const query = source.path?.trim();
  if (query === undefined || query === "") {
    throw new Error(
      "name a server, or a search term, in `path`: the registry holds thousands of servers, and an import lists at most 30"
    );
  }
  const url = `${origin(source.url)}/v0.1/servers?search=${encodeURIComponent(query)}&version=latest&limit=30`;
  const list = v.parse(ListSchema, await getJson(context.fetch, url));
  const entries = list.servers.filter((entry) => statusOf(entry) !== "deleted");
  const licence = licenceOf(source.url);
  const ids = uniqueIds(
    entries.map((entry) => ({
      name: entry.server.name.split("/").at(-1) ?? entry.server.name,
      qualifier: kebab(entry.server.name.split("/")[0] ?? ""),
    }))
  );
  const candidates: Candidate[] = entries.map((entry, index) => ({
    ...(licence.permitsCopy && entry.server.description !== undefined
      ? { description: entry.server.description }
      : {}),
    id: ids[index] ?? "server",
    key: entry.server.name,
    kind: "mcp",
    license: licence.statement,
    ...(licence.id === undefined ? {} : { licenseId: licence.id }),
    linkOnly: !licence.permitsCopy,
    title: entry.server.title ?? entry.server.name,
    upstream: {
      url: versionUrl(
        source.url ?? "",
        entry.server.name,
        entry.server.version
      ),
      version: entry.server.version,
    },
  }));
  const warnings =
    licence.permitsCopy || candidates.length === 0
      ? []
      : [
          `${origin(source.url)} states no licence for its data; its servers import as definitions only, without descriptions`,
        ];
  return { candidates, warnings };
}

export async function fetchMcpRegistry(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  if (source.url === undefined) {
    throw new Error("an MCP registry source needs `url`");
  }
  const version = pick.pin?.version ?? candidate.upstream.version ?? "latest";
  const url = versionUrl(source.url, candidate.key, version);
  const found = await getJson(context.fetch, url);
  if (found === null) {
    throw new Error(`${url}: the registry has no such server version`);
  }
  const entry = v.parse(EntrySchema, found);
  const digest = await serverDigest(found);
  const id = pick.id ?? candidate.id;
  const licence = licenceOf(source.url);
  const pinnedUrl = versionUrl(
    source.url,
    entry.server.name,
    entry.server.version
  );
  const official = origin(source.url) === OFFICIAL_REGISTRY;
  const item = {
    ...definition(id, entry.server),
    description: entry.server.description,
    id,
    kind: "mcp",
    source: provenance({
      ...licenceFields(licence),
      ...(official
        ? {
            creditText: MCP_REGISTRY_TERMS.creditText,
            linkTarget: MCP_REGISTRY_TERMS.linkTarget,
          }
        : { linkTarget: origin(source.url) }),
      digest,
      id: source.sourceId,
      recordUrl: pinnedUrl,
      url: pinnedUrl,
      version: entry.server.version,
    }),
    title: entry.server.title ?? entry.server.name,
  };
  const warnings = licence.permitsCopy
    ? []
    : [
        linkOnlyWarning(
          id,
          `${origin(source.url)} states no licence for its data`,
          pinnedUrl
        ),
      ];
  return importedItem({
    files: [],
    item,
    linkOnly: !licence.permitsCopy,
    warnings,
  });
}

export async function checkMcpRegistry(
  item: Item,
  context: AdapterContext
): Promise<UpstreamState> {
  const source = sourceOf(item);
  const name = item.kind === "mcp" && "name" in item ? item.name : undefined;
  if (source.url === undefined || name === undefined) {
    return { error: "the item names no registry server", status: "error" };
  }
  const found = await getJson(
    context.fetch,
    versionUrl(source.url, name, "latest")
  );
  if (found === null) {
    return { status: "gone" };
  }
  const entry = v.parse(EntrySchema, found);
  const latest = {
    url: versionUrl(source.url, entry.server.name, entry.server.version),
    version: entry.server.version,
  };
  if (statusOf(entry) === "deleted") {
    return {
      error: "the registry marks the server deleted",
      latest,
      status: "gone",
    };
  }
  if (entry.server.version !== source.version) {
    return { latest, status: "moved" };
  }
  const digest = await serverDigest(found);
  return {
    latest: { ...latest, digest },
    status:
      source.digest === undefined || source.digest === digest
        ? "current"
        : "moved",
  };
}
