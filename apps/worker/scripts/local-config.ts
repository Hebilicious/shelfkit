#!/usr/bin/env tsx
/**
 * Write `wrangler.local.json`: `wrangler.jsonc` without the bindings that have no local simulator (Artifacts), for
 * `moon run worker:dev` and the tests, which run on Miniflare with no Cloudflare account. The Worker runs there as a
 * deployment without repositories does (`src/repository/index.ts`). Generated, and ignored by Git.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";

import { stripJsonc } from "./jsonc.ts";

const worker = path.resolve(import.meta.dirname, "..");

/** The bindings a local run leaves out: Wrangler will never simulate them. */
const REMOTE_ONLY = new Set(["artifacts"]);

/** Write the local configuration beside `wrangler.jsonc`, so its relative paths still hold, and return its path. */
export function writeLocalConfig(): string {
  // BOUNDARY: wrangler.jsonc is Wrangler's to validate; this only drops top-level keys from it.
  const parsed = v.parse(
    v.record(v.string(), v.unknown()),
    JSON.parse(
      stripJsonc(readFileSync(path.join(worker, "wrangler.jsonc"), "utf-8"))
    )
  );
  const local = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !REMOTE_ONLY.has(key))
  );
  const target = path.join(worker, "wrangler.local.json");
  writeFileSync(target, `${JSON.stringify(local, null, 2)}\n`);
  return target;
}

if (process.argv[1] === import.meta.filename) {
  writeLocalConfig();
}
