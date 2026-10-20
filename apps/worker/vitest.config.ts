import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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

/**
 * The Worker runs in workerd with its real bindings, simulated by Miniflare: the shelf object, R2, and the queue.
 * Files the tests need from the repository are read here, in Node, and provided to them.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          OWNER_KEY_HASH: createHash("sha256")
            .update(TEST_OWNER_KEY)
            .digest("hex"),
          // Test values for the secret rule: each is released only to the origin its name is bound to.
          SHELFKIT_SECRET_GITHUB_TOKEN: "test-github-token",
          SHELFKIT_SECRET_LINEAR_API_KEY: "test-linear-token",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    provide: {
      allKindsShelf: shelfFiles(
        path.join(repository, "crates/core/tests/fixtures/all-kinds")
      ),
      conformance: { archives, cases },
      ownShelf: shelfFiles(path.join(repository, "shelf")),
    },
  },
});
