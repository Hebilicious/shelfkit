/**
 * `acid-cat conform` against `/mcp`'s composition, in Node: `conform()` serves the handler on a local port and drives
 * it with the official MCP client, which the workerd pool cannot host. `moon run worker:mcp-conform`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/mcp/conform.node.ts"],
    // conform runs dozens of checks, each with its own deadline.
    testTimeout: 180_000,
  },
});
