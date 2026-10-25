import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import {
  FAKE_ACCOUNTS,
  FAKE_CLIENT,
  TEST_GITHUB,
  TEST_SESSION_SECRET,
} from "./test/fake-github.ts";
import { TEST_OWNER_KEY } from "./test/owner-key.ts";

const repository = path.resolve(import.meta.dirname, "../..");

/** Every file of a shelf directory the format reads, base64, by path from its root. */
function shelfFiles(root: string) {
  const files = new Map([
    [
      "shelf.json",
      readFileSync(path.join(root, "shelf.json")).toString("base64"),
    ],
  ]);
  for (const directory of ["items", "bundles", "profiles"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(path.join(root, directory), {
        encoding: "utf-8",
        recursive: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = path.join(directory, entry);
      try {
        files.set(
          relative.split(path.sep).join("/"),
          readFileSync(path.join(root, relative)).toString("base64")
        );
      } catch {
        // A directory.
      }
    }
  }
  return Object.fromEntries(files);
}

const conformance = path.join(repository, "crates/registry/conformance");
const cases = readFileSync(path.join(conformance, "cases.json"), "utf-8");
const archives = Object.fromEntries(
  readdirSync(path.join(conformance, "archives")).map((file) => [
    `archives/${file}`,
    readFileSync(path.join(conformance, "archives", file)).toString("base64"),
  ])
);

/** The Worker's secrets in every test: an owner key, a session secret, and the secret rule's test values. */
const secrets = {
  OWNER_KEY_HASH: createHash("sha256").update(TEST_OWNER_KEY).digest("hex"),
  SESSION_SECRET: TEST_SESSION_SECRET,
  // Test values for the secret rule: each is released only to the origin its name is bound to.
  SHELFKIT_SECRET_GITHUB_TOKEN: "test-github-token",
  SHELFKIT_SECRET_LINEAR_API_KEY: "test-linear-token",
};

/** GitHub sign-in, enabled, against a stand-in the tests answer the Worker's `fetch` with. */
const github = {
  GITHUB_API_URL: TEST_GITHUB.api,
  GITHUB_CLIENT_ID: FAKE_CLIENT.id,
  GITHUB_CLIENT_SECRET: FAKE_CLIENT.secret,
  GITHUB_URL: TEST_GITHUB.web,
  OWNER_GITHUB_ID: String(FAKE_ACCOUNTS.owner.id),
};

/** The workspace version in Cargo.toml: the CLI's, which the Worker's `SHELFKIT_VERSION` must equal. */
const cargoVersion =
  /^\[workspace\.package\]\nversion = "(?<version>[^"]+)"/mu.exec(
    readFileSync(path.join(repository, "Cargo.toml"), "utf-8")
  )?.groups?.version ?? "";

const provide = {
  allKindsShelf: shelfFiles(
    path.join(repository, "crates/core/tests/fixtures/all-kinds")
  ),
  cargoVersion,
  conformance: { archives, cases },
  ownShelf: shelfFiles(path.join(repository, "shelf")),
};

/**
 * The first request of each test file loads the Worker's modules into workerd, about 5 s on its own and more while the
 * rest of the gate runs beside it; Vitest's default 5 s (10 s for a hook) leaves no room for that.
 */
const timeouts = { hookTimeout: 60_000, testTimeout: 60_000 };

/** The tests that need GitHub sign-in enabled; every other test runs as a default deployment, without it. */
const GITHUB_TESTS = ["test/github.test.ts"];

/**
 * The Worker runs in workerd with its real bindings, simulated by Miniflare: the shelf object, R2, and the queue.
 * Files the tests need from the repository are read here, in Node, and provided to them. Two projects: the default
 * deployment (passkeys and links, no GitHub), and one with GitHub sign-in enabled for the GitHub tests.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: { bindings: secrets },
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          exclude: [...GITHUB_TESTS, "test/mcp/conform.*", "node_modules/**"],
          include: ["test/**/*.test.ts"],
          name: "default",
          provide,
          ...timeouts,
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: { bindings: { ...secrets, ...github } },
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: { include: GITHUB_TESTS, name: "github", provide, ...timeouts },
      },
    ],
  },
});
