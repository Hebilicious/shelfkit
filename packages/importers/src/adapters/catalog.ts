import { sourceOf } from "../imported.ts";
/**
 * The `catalog` source kind: one adapter per kind, so this one dispatches on the catalog's URL. ClawHub
 * (`clawhub.ai`) and MCP registries (the official one, or any serving its `/v0.1` API) are read; any other catalog is
 * refused by name rather than guessed at.
 */
import type {
  AdapterContext,
  ImportSource,
  Item,
  SourceAdapter,
  UpstreamState,
} from "../seam.ts";
import {
  checkClawHub,
  discoverClawHub,
  fetchClawHub,
  isClawHub,
} from "./clawhub.ts";
import {
  checkMcpRegistry,
  discoverMcpRegistry,
  fetchMcpRegistry,
  isMcpRegistry,
} from "./mcp-registry.ts";

type Catalog = "clawhub" | "mcp-registry";

/** Which catalog a URL is, or `undefined` for one ShelfKit does not read. */
export function catalogOf(url: string | undefined): Catalog | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    if (isClawHub(url)) {
      return "clawhub";
    }
    return isMcpRegistry(url) ? "mcp-registry" : undefined;
  } catch {
    return undefined;
  }
}

function which(source: ImportSource): Catalog {
  const found = catalogOf(source.url);
  if (found === undefined) {
    throw new Error(
      `\`${source.url ?? "(no url)"}\` is not a catalog ShelfKit reads: ClawHub (https://clawhub.ai) or an MCP registry (https://registry.modelcontextprotocol.io)`
    );
  }
  return found;
}

async function checkUpstream(
  item: Item,
  context: AdapterContext
): Promise<UpstreamState> {
  const catalog = catalogOf(sourceOf(item).url);
  if (catalog === "clawhub") {
    return await checkClawHub(item, context);
  }
  if (catalog === "mcp-registry") {
    return await checkMcpRegistry(item, context);
  }
  return {
    error: "the item's source URL is not a catalog ShelfKit reads",
    status: "error",
  };
}

export const catalogAdapter: SourceAdapter = {
  checkUpstream,
  discover: async (source, context) =>
    which(source) === "clawhub"
      ? await discoverClawHub(source, context)
      : await discoverMcpRegistry(source, context),
  fetch: async (source, candidate, pick, context) =>
    which(source) === "clawhub"
      ? await fetchClawHub(source, candidate, pick, context)
      : await fetchMcpRegistry(source, candidate, pick, context),
  kind: "catalog",
};
