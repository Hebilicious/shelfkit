/**
 * `acid-cat conform` passes against `/mcp` as the Worker composes it: AcidCat's MCP binding with the relay beside it
 * (`src/mcp/compose.ts`), imported through `src/mcp/index.ts`, the module the Worker routes `/mcp` to. AcidCat's
 * conformance fixture stands in for ShelfKit's tools, and the relay is one that relays nothing, which is what most
 * keys get; the relay's own behaviour is tested in workerd (`relay.test.ts`).
 */
import { conform, serve } from "@acid-cat/cli";
import { toCatalogJsonSchema } from "@shelfkit/schema/json-schema";
import { expect, it } from "vitest";

import { NO_RELAY } from "../../src/mcp/compose.ts";
import { serveMcp } from "../../src/mcp/index.ts";
import { createHolds, fixture, Switch } from "./fixture.ts";

it("acid-cat conform passes against the /mcp composition", async () => {
  // One switch and one set of held calls across requests, as one deployment keeps them; a context per request.
  const shared = { holds: createHolds(), switch: new Switch() };
  const served = await serve({
    "/mcp": serveMcp(fixture, {
      allowedOrigins: [],
      createContext: () => ({ ...shared }),
      name: "fixture",
      relay: () => NO_RELAY,
      toJsonSchema: toCatalogJsonSchema,
      version: "0.0.0",
    }),
  });
  try {
    const results = await conform({ mcp: `${served.url}/mcp` });
    const failed = results.filter((result) => !result.passed);
    expect(
      failed.map(
        (result) => `${result.binding}: ${result.name}: ${result.detail ?? ""}`
      )
    ).toStrictEqual([]);
    // The binding's checks, and the properties: concurrent calls and cancellation through the composition.
    expect(
      results.filter((result) => result.binding === "mcp").length
    ).toBeGreaterThan(10);
    expect(results.some((result) => result.binding === "mcp properties")).toBe(
      true
    );
  } finally {
    await served.close();
  }
});
