import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { writeLocalConfig } from "../worker/scripts/local-config.ts";
import {
  FAKE_GITHUB_WEB,
  GITHUB_VARS,
  SESSION_VARS,
} from "./test/e2e/github.ts";
import { GITHUB_BASE_URL, GITHUB_WORKER_PORT } from "./test/e2e/ports.ts";
import { BASE_URL, OWNER_KEY, PORT } from "./test/e2e/support.ts";

/**
 * The specs drive the built SPA served by the real Worker under `wrangler dev`, with Miniflare's Durable Object, R2 and
 * queue, so every screen goes through the same GraphQL API the CLI uses. It runs the local configuration
 * (`apps/worker/scripts/local-config.ts`), without Artifacts, which Miniflare cannot run, so the Worker keeps each shelf's
 * repository in R2 and serves Git itself. Each run starts from empty storage, and the specs seed their shelves with
 * `git push` to each shelf's repository. The browser signs in as people do by default: one-time links and passkeys,
 * made by Chromium's virtual authenticator. A second Worker has GitHub sign-in enabled, through a stand-in
 * GitHub (`test/e2e/fake-github-server.ts`) that only this configuration points it at; the `github` project's specs
 * run against it.
 */
const here = import.meta.dirname;
mkdirSync(path.join(here, ".e2e"), { recursive: true });
const state = mkdtempSync(path.join(here, ".e2e", "state-"));
const githubState = mkdtempSync(path.join(here, ".e2e", "github-state-"));
const ownerKeyHash = createHash("sha256").update(OWNER_KEY).digest("hex");
const wrangler = path.join(here, "../worker/node_modules/.bin/wrangler");
const workerConfig = writeLocalConfig();
const tsx = path.join(here, "../../node_modules/.bin/tsx");

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [
    {
      name: "chromium",
      testIgnore: "**/github.e2e.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { height: 1000, width: 1440 },
      },
    },
    {
      name: "github",
      testMatch: "**/github.e2e.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: GITHUB_BASE_URL,
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
  webServer: [
    {
      command: `${tsx} test/e2e/fake-github-server.ts`,
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 30_000,
      url: `${FAKE_GITHUB_WEB}/_ready`,
    },
    {
      command: [
        wrangler,
        "dev",
        `--config ${workerConfig}`,
        `--port ${PORT}`,
        "--ip localhost",
        `--var OWNER_KEY_HASH:${ownerKeyHash}`,
        ...SESSION_VARS.map((variable) => `--var ${variable}`),
        `--persist-to ${state}`,
        "--show-interactive-dev-session=false",
      ].join(" "),
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 120_000,
      url: `${BASE_URL}/health`,
    },
    {
      command: [
        wrangler,
        "dev",
        `--config ${workerConfig}`,
        `--port ${GITHUB_WORKER_PORT}`,
        "--ip localhost",
        `--var OWNER_KEY_HASH:${ownerKeyHash}`,
        ...SESSION_VARS.map((variable) => `--var ${variable}`),
        ...GITHUB_VARS.map((variable) => `--var ${variable}`),
        `--persist-to ${githubState}`,
        "--show-interactive-dev-session=false",
      ].join(" "),
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "ignore",
      timeout: 120_000,
      url: `${GITHUB_BASE_URL}/health`,
    },
  ],
  workers: 1,
});
