import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { stripJsonc } from "./scripts/jsonc.ts";
import { writeTestConfig } from "./scripts/local-config.ts";
import {
  FAKE_ACCOUNTS,
  FAKE_CLIENT,
  TEST_GITHUB,
  TEST_SESSION_SECRET,
} from "./test/fake-github.ts";
import { TEST_OWNER_KEY } from "./test/owner-key.ts";

const repository = path.resolve(import.meta.dirname, "../..");

/**
 * `wrangler.jsonc` with Artifacts on Miniflare's local simulator (`"remote": false`), and with no queue consumer: a test
 * runs the jobs it means to with `runJob`, and nothing runs the rest behind its back.
 */
const configPath = writeTestConfig();

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

/** `wrangler.jsonc` as JSON, for the tests that hold the Worker's code in step with its configuration. */
const wranglerConfig = JSON.stringify(
  JSON.parse(
    stripJsonc(
      readFileSync(path.join(import.meta.dirname, "wrangler.jsonc"), "utf-8")
    )
  )
);

const provide = {
  allKindsShelf: shelfFiles(
    path.join(repository, "crates/core/tests/fixtures/all-kinds")
  ),
  cargoVersion,
  conformance: { archives, cases },
  ownShelf: shelfFiles(path.join(repository, "shelf")),
  wranglerConfig,
};

/**
 * The first request of each test file loads the Worker's modules into workerd, about 5 s on its own and more while the
 * rest of the gate runs beside it; Vitest's default 5 s (10 s for a hook) leaves no room for that.
 */
const timeouts = { hookTimeout: 60_000, testTimeout: 60_000 };

/**
 * How many test files run at once. Each runs in a Miniflare of its own, with its own Artifacts simulator and the Git
 * processes it starts, and every read of a repository is one of those processes. Vitest's default, one file per core
 * but one, ran 19 at once on a 22-core machine, and a test that takes five seconds alone took more than thirty; eight
 * at a time ran the default project in about two minutes.
 */
const maxWorkers = Math.max(1, Math.min(8, availableParallelism() - 1));

/** The tests that need GitHub sign-in enabled; every other test runs as a default deployment, without it. */
const GITHUB_TESTS = ["test/github.test.ts"];

/**
 * The Worker runs in workerd with its real bindings, simulated by Miniflare: the shelf object, R2, the queue, and
 * Artifacts, whose simulator serves each repository with `git http-backend` (Git 2.32 or newer on PATH) and gives each
 * test file storage of its own. `remoteBindings: false` keeps every binding local: the pool bundles its own copy of
 * Wrangler's remote-binding selection, which the patch in `patches/` does not reach, and would otherwise open a remote
 * session for Artifacts. Files the tests need from the repository are read here, in Node, and provided to them. Two
 * projects: the default deployment (passkeys and links, no GitHub), and one with GitHub sign-in enabled for the GitHub
 * tests.
 */
export default defineConfig({
  test: {
    maxWorkers,
    projects: [
      {
        plugins: [
          cloudflareTest({
            miniflare: { bindings: secrets },
            remoteBindings: false,
            wrangler: { configPath },
          }),
        ],
        test: {
          exclude: [...GITHUB_TESTS, "test/mcp/conform.*", "node_modules/**"],
          include: ["test/**/*.test.ts"],
          name: "default",
          provide,
          setupFiles: ["./test/webauthn.setup.ts"],
          ...timeouts,
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: { bindings: { ...secrets, ...github } },
            remoteBindings: false,
            wrangler: { configPath },
          }),
        ],
        test: {
          include: GITHUB_TESTS,
          name: "github",
          provide,
          ...timeouts,
        },
      },
    ],
  },
});
