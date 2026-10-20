import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { BASE_URL, OWNER_KEY, PORT } from "./test/e2e/support.ts";

/**
 * The specs drive the built SPA served by the real Worker under `wrangler dev`, with Miniflare's Durable Object, R2 and
 * queue, so every screen goes through the same GraphQL API the CLI uses. Each run starts from empty storage, and the
 * specs seed their shelves with `shelfkit push`.
 */
const here = import.meta.dirname;
mkdirSync(path.join(here, ".e2e"), { recursive: true });
const state = mkdtempSync(path.join(here, ".e2e", "state-"));
const ownerKeyHash = createHash("sha256").update(OWNER_KEY).digest("hex");
const wrangler = path.join(here, "../worker/node_modules/.bin/wrangler");

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { height: 1000, width: 1440 },
      },
    },
  ],
  reporter: [["list"]],
  retries: 0,
  testDir: "test/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: [
      wrangler,
      "dev",
      "--config ../worker/wrangler.jsonc",
      `--port ${PORT}`,
      "--ip localhost",
      `--var OWNER_KEY_HASH:${ownerKeyHash}`,
      `--persist-to ${state}`,
      "--show-interactive-dev-session=false",
    ].join(" "),
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "ignore",
    timeout: 120_000,
    url: `${BASE_URL}/health`,
  },
  workers: 1,
});
