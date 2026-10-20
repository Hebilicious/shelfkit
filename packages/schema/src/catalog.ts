/**
 * The AcidCat application the capabilities make, for rendering `acidcat.catalog.json`. The catalog is a build-time
 * file: rendering needs the descriptors but not their implementations, so each `run` here refuses to be called. Issue
 * #6 builds the served application from the same descriptors with real `run` functions.
 */
import { defineApp, renderCatalog } from "@acid-cat/core-ts";

import { capabilities, catalog } from "./capabilities.ts";
import { toCatalogJsonSchema } from "./json-schema.ts";

function notServedHere(): never {
  throw new Error(
    "this application only renders the catalog; the MCP endpoint serves the capabilities"
  );
}

export const catalogApp = defineApp({
  ...catalog,
  capabilities: capabilities.map((capability) => ({
    ...capability,
    run: notServedHere,
  })),
});

/** The catalog, in AcidCat's canonical form. */
export function renderShelfCatalog(): string {
  return renderCatalog(catalogApp, { toJsonSchema: toCatalogJsonSchema });
}
