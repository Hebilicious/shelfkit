#!/usr/bin/env tsx
/**
 * Write the Worker's local configurations from `wrangler.jsonc`, beside it so its relative paths still hold. Both are
 * generated, and ignored by Git.
 *
 * - `wrangler.local.json`, for `moon run worker:dev` and the browser tests: without the bindings that have no local
 *   simulator (Artifacts), so it runs on Miniflare with no Cloudflare account, as a deployment without repositories
 *   does (`src/repository/index.ts`).
 * - `wrangler.test.json`, for the Worker tests: the same, and with no queue consumer either. A test runs the jobs it
 *   means to run with `runJob`; a live consumer would run the rest in the background, whenever it got to them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";

import { stripJsonc } from "./jsonc.ts";

const worker = path.resolve(import.meta.dirname, "..");

/** The bindings a local run leaves out: Wrangler will never simulate them. */
const REMOTE_ONLY = new Set(["artifacts"]);

/** `wrangler.jsonc` without its remote-only bindings. */
function localConfig(): Record<string, unknown> {
  // BOUNDARY: wrangler.jsonc is Wrangler's to validate; this only drops keys from it.
  const parsed = v.parse(
    v.record(v.string(), v.unknown()),
    JSON.parse(
      stripJsonc(readFileSync(path.join(worker, "wrangler.jsonc"), "utf-8"))
    )
  );
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !REMOTE_ONLY.has(key))
  );
}

function write(name: string, config: Record<string, unknown>): string {
  const target = path.join(worker, name);
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
}

/** Write `wrangler.local.json` and return its path. */
export function writeLocalConfig(): string {
  return write("wrangler.local.json", localConfig());
}

/** Write `wrangler.test.json`, whose queue has producers and no consumer, and return its path. */
export function writeTestConfig(): string {
  const config = localConfig();
  const queues = v.parse(
    v.object({ producers: v.array(v.unknown()) }),
    config.queues
  );
  return write("wrangler.test.json", {
    ...config,
    queues: { producers: queues.producers },
  });
}

if (process.argv[1] === import.meta.filename) {
  writeLocalConfig();
}
