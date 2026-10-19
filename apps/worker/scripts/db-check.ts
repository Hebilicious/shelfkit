#!/usr/bin/env tsx
/**
 * Fail when `src/db/schema.ts` has changed without a migration: Drizzle Kit's dry run (`generate --explain --output
 * json`) must report no changes. `moon run worker:db-generate` writes the migration.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const worker = path.resolve(import.meta.dirname, "..");
const ran = spawnSync(
  path.join(worker, "node_modules/.bin/drizzle-kit"),
  ["generate", "--explain", "--output", "json"],
  { cwd: worker, encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] }
);
const line = ran.stdout.trim().split("\n").at(-1) ?? "";
if (ran.status !== 0 || statusOf(line) !== "no_changes") {
  console.error(
    `src/db/schema.ts has changes no migration covers (drizzle-kit: ${line || `exit ${ran.status}`}); run \`moon run worker:db-generate\` and commit the migration.`
  );
  process.exit(1);
}
console.log("The shelf object's migrations cover src/db/schema.ts.");

/** The `status` of Drizzle Kit's JSON answer, or `""` when the line is not one. */
function statusOf(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return isStatus(parsed) ? parsed.status : "";
  } catch {
    return "";
  }
}

// BOUNDARY: Drizzle Kit's JSON output is unknown until this guard has read its `status`.
function isStatus(value: unknown): value is { readonly status: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "string"
  );
}
