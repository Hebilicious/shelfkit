#!/usr/bin/env tsx
/**
 * Write the Worker's local configurations from `wrangler.jsonc`, beside it so its relative paths still hold. Both are
 * generated, and ignored by Git.
 *
 * - `wrangler.local.json`, for `moon run worker:dev` and the browser tests: every Artifacts binding with
 *   `"remote": false`, so it runs on Miniflare's local Artifacts simulator with no Cloudflare account. The simulator
 *   serves each repository with `git http-backend`, so Git 2.32 or newer must be on PATH. Wrangler wires the simulator
 *   in only with the patches in `patches/` (see `pnpm-workspace.yaml`).
 * - `wrangler.test.json`, for the Worker tests: the same, and with no queue consumer either. A test runs the jobs it
 *   means to run with `runJob`; a live consumer would run the rest in the background, whenever it got to them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";

import { stripJsonc } from "./jsonc.ts";

const worker = path.resolve(import.meta.dirname, "..");

/** Wrangler's configuration, as far as this script reads it: its top-level keys. Wrangler validates the rest. */
const WranglerConfigSchema = v.record(v.string(), v.unknown());
type WranglerConfig = v.InferOutput<typeof WranglerConfigSchema>;

/** The Artifacts bindings, as far as this script reads them. */
const ArtifactsSchema = v.array(v.looseObject({ binding: v.string() }));

/** `wrangler.jsonc` with its Artifacts bindings on the local simulator. */
function localConfig(): WranglerConfig {
  // BOUNDARY: wrangler.jsonc is Wrangler's to validate; this only changes one key of it.
  const parsed = v.parse(
    WranglerConfigSchema,
    JSON.parse(
      stripJsonc(readFileSync(path.join(worker, "wrangler.jsonc"), "utf-8"))
    )
  );
  const artifacts = v.parse(ArtifactsSchema, parsed.artifacts ?? []);
  return {
    ...parsed,
    artifacts: artifacts.map((binding) => ({ ...binding, remote: false })),
  };
}

function write(name: string, config: WranglerConfig): string {
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
