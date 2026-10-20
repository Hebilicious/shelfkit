#!/usr/bin/env tsx
/**
 * `wrangler check startup`, with a budget: profile the Worker's startup in workerd and fail when the sampled CPU time
 * exceeds `BUDGET_MS`. A heavy module-scope build (a GraphQL schema, an engine) is the documented way to trip the
 * platform's startup limit, so the engine and the schema are built on first use, and this keeps it that way.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Well under the platform's startup limit, and far above what the Worker needs today (~20 ms). */
const BUDGET_MS = 400;

const worker = path.resolve(import.meta.dirname, "..");
const directory = mkdtempSync(path.join(tmpdir(), "shelfkit-startup-"));
const profile = path.join(directory, "startup.cpuprofile");
try {
  const ran = spawnSync(
    path.join(worker, "node_modules/.bin/wrangler"),
    ["check", "startup", "--outfile", profile],
    { cwd: worker, stdio: "inherit" }
  );
  if (ran.status !== 0) {
    console.error(
      "`wrangler check startup` failed: the Worker does not start."
    );
    process.exit(1);
  }
  const parsed: unknown = JSON.parse(readFileSync(profile, "utf-8"));
  if (!isProfile(parsed)) {
    console.error("the startup profile is not a CPU profile");
    process.exit(1);
  }
  const idle = new Set(
    parsed.nodes
      .filter((node) => node.callFrame.functionName === "(idle)")
      .map((node) => node.id)
  );
  let active = 0;
  for (const [index, sample] of parsed.samples.entries()) {
    if (!idle.has(sample)) {
      active += parsed.timeDeltas[index] ?? 0;
    }
  }
  const milliseconds = active / 1000;
  if (milliseconds > BUDGET_MS) {
    console.error(
      `startup took ${milliseconds.toFixed(1)} ms of CPU, over the ${BUDGET_MS} ms budget`
    );
    process.exit(1);
  }
  console.log(
    `startup: ${milliseconds.toFixed(1)} ms of CPU, within the ${BUDGET_MS} ms budget`
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}

interface Profile {
  readonly nodes: readonly {
    readonly id: number;
    readonly callFrame: { readonly functionName: string };
  }[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

// BOUNDARY: a CPU profile read from disk is unknown until this guard has checked the fields the budget reads.
function isProfile(value: unknown): value is Profile {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodes" in value &&
    Array.isArray(value.nodes) &&
    "samples" in value &&
    Array.isArray(value.samples) &&
    "timeDeltas" in value &&
    Array.isArray(value.timeDeltas)
  );
}
