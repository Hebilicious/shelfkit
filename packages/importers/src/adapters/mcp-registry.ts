/**
 * The official MCP Registry (and any registry serving its API): server definitions, pinned to a version.
 *
 * What is imported is the server's metadata, never a package: an `mcp` item whose `name` is the registry name, so APM
 * resolves the server from the registry, plus the first remote endpoint when the server has one. The official
 * registry's data is CC0 (`../terms.ts`); another registry's terms are unknown, so its items carry no description and
 * a warning, though their definitions (names and URLs) are kept, since a definition is the link.
 *
 * Drift reads the server's latest version: a different version, or the same version whose document changed, is
 * `moved`; a `deleted` status or a missing server is `gone`.
 */
import * as v from "valibot";

import { canonicalJson, getJson, JsonSchema, sha256OfText } from "../http.ts";
import type { Json } from "../http.ts";
import { kebab, uniqueIds } from "../ids.ts";
import type { Wanted } from "../ids.ts";
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
  title: v.optional(v.string()),
  version: v.string(),
});

/** One version of a server as the registry serves it; `document` is the `server` object exactly as served. */
const EntrySchema = v.object({
  _meta: v.optional(
    v.object({
      "io.modelcontextprotocol.registry/official": v.optional(
        v.object({ status: v.optional(v.string()) })
      ),
    })
  ),
  server: JsonSchema,
});

const ListSchema = v.object({ servers: v.array(EntrySchema) });

type Entry = v.InferOutput<typeof EntrySchema>;
type Server = v.InferOutput<typeof ServerSchema>;

/** Whether a URL is this kind of catalog: the official registry, or a path under `/v0`. */
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
  const terms = MCP_REGISTRY_TERMS.licence;
  return origin(url) === OFFICIAL_REGISTRY && terms !== "per-artifact"
    ? terms
    : NO_LICENCE;
}

function versionUrl(url: string, name: string, version: string): string {
  return `${origin(url)}/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

function statusOf(entry: Entry): string | undefined {
  return entry._meta?.["io.modelcontextprotocol.registry/official"]?.status;
}

function serverOf(entry: Entry): Server {
  return v.parse(ServerSchema, entry.server);
}

/** `sha256:` over the canonical JSON of a version's `server` document, as the registry served it. */
async function serverDigest(document: Json): Promise<string> {
  return `sha256:${await sha256OfText(canonicalJson(document))}`;
}

/** A secret name for a header: `GITHUB_MCP_SERVER_AUTHORIZATION`. */
function secretName(id: string, header: string): string {
  return `${id}-${header}`
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
}

/** The item fields a server definition becomes. */
function definition(id: string, server: Server) {
  const [remote] = server.remotes ?? [];
  if (remote === undefined) {
    return { flavour: "remote", name: server.name };
  }
  const headers = new Map<string, string | { secret: string }>();
  for (const header of remote.headers ?? []) {
    if (header.isSecret === true || header.value === undefined) {
      if (header.isSecret === true || header.isRequired === true) {
        headers.set(header.name, { secret: secretName(id, header.name) });
      }
    } else {
      headers.set(header.name, header.value);
    }
  }
  return {
    flavour: "remote",
    headers: headers.size === 0 ? undefined : Object.fromEntries(headers),
    name: server.name,
    transport:
      remote.type === "sse" || remote.type === "http"
        ? remote.type
        : "streamable-http",
    url: remote.url,
  };
}

/** The last segment of a registry name (`github-mcp-server`), and its namespace. */
function nameParts(name: string): Wanted {
  const [namespace = ""] = name.split("/");
  return { name: name.split("/").at(-1) ?? name, qualifier: kebab(namespace) };
}

export async function discoverMcpRegistry(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  if (source.url === undefined) {
    throw new Error("an MCP registry source needs `url`");
  }
  const query = source.path?.trim() ?? "";
  if (query === "") {
    throw new Error(
      "name a server, or a search term, in `path`: the registry holds thousands of servers, and an import lists at most 30"
    );
  }
  const url = `${origin(source.url)}/v0.1/servers?search=${encodeURIComponent(query)}&version=latest&limit=30`;
  const list = await getJson(context.fetch, url, ListSchema);
  const entries = (list?.servers ?? []).filter(
    (entry) => statusOf(entry) !== "deleted"
  );
  const servers = entries.map((entry) => serverOf(entry));
  const licence = licenceOf(source.url);
  const ids = uniqueIds(servers.map((server) => nameParts(server.name)));
  const registry = source.url;
  const candidates = servers.map((server, index) => {
    const candidate: Candidate = {
      id: ids[index] ?? "server",
      key: server.name,
      kind: "mcp",
      license: licence.statement,
      linkOnly: !licence.permitsCopy,
      title: server.title ?? server.name,
      upstream: {
        url: versionUrl(registry, server.name, server.version),
        version: server.version,
      },
    };
    if (licence.permitsCopy && server.description !== undefined) {
      candidate.description = server.description;
    }
    if (licence.id !== undefined) {
      candidate.licenseId = licence.id;
    }
    return candidate;
  });
  const warnings =
    licence.permitsCopy || candidates.length === 0
      ? []
      : [
          `${origin(source.url)} states no licence for its data; its servers import as definitions only, without descriptions`,
        ];
  return { candidates, warnings };
}

/** The credit and link a registry asks for. */
interface Attribution {
  creditText?: string;
  linkTarget: string;
}

/** The credit and link a registry asks for: the official registry's wording, or a link to any other. */
function attribution(url: string): Attribution {
  if (origin(url) !== OFFICIAL_REGISTRY) {
    return { linkTarget: origin(url) };
  }
  return {
    creditText: MCP_REGISTRY_TERMS.creditText,
    linkTarget: MCP_REGISTRY_TERMS.linkTarget ?? OFFICIAL_REGISTRY,
  };
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
  const entry = await getJson(context.fetch, url, EntrySchema);
  if (entry === null) {
    throw new Error(`${url}: the registry has no such server version`);
  }
  const server = serverOf(entry);
  const id = pick.id ?? candidate.id;
  const licence = licenceOf(source.url);
  const pinnedUrl = versionUrl(source.url, server.name, server.version);
  const item = {
    ...definition(id, server),
    description: server.description,
    id,
    kind: "mcp",
    source: provenance({
      ...licenceFields(licence),
      ...attribution(source.url),
      digest: await serverDigest(entry.server),
      id: source.sourceId,
      recordUrl: pinnedUrl,
      url: pinnedUrl,
      version: server.version,
    }),
    title: server.title ?? server.name,
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
  const name =
    item.kind === "mcp" && item.flavour !== "hosted" ? item.name : undefined;
  if (source.url === undefined || name === undefined) {
    return { error: "the item names no registry server", status: "error" };
  }
  const entry = await getJson(
    context.fetch,
    versionUrl(source.url, name, "latest"),
    EntrySchema
  );
  if (entry === null) {
    return { status: "gone" };
  }
  const server = serverOf(entry);
  const latest = {
    url: versionUrl(source.url, server.name, server.version),
    version: server.version,
  };
  if (statusOf(entry) === "deleted") {
    return {
      error: "the registry marks the server deleted",
      latest,
      status: "gone",
    };
  }
  if (server.version !== source.version) {
    return { latest, status: "moved" };
  }
  const digest = await serverDigest(entry.server);
  const unchanged = source.digest === undefined || source.digest === digest;
  return {
    latest: { ...latest, digest },
    status: unchanged ? "current" : "moved",
  };
}
