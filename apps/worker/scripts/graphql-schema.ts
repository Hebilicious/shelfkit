#!/usr/bin/env tsx
/**
 * Print the GraphQL schema to `schema.graphql`, the SDL the web UI and other clients build against, or check that the
 * committed file is current with `--check`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { lexicographicSortSchema, printSchema } from "graphql";

import { buildSchema } from "../src/graphql/schema.ts";

const file = path.resolve(import.meta.dirname, "../schema.graphql");
const printed = `${printSchema(lexicographicSortSchema(buildSchema()))}\n`;

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(file, "utf-8");
  } catch {
    // Missing is stale.
  }
  if (committed !== printed) {
    console.error(
      "apps/worker/schema.graphql is stale: run `moon run worker:graphql-schema` and commit it."
    );
    process.exit(1);
  }
  console.log("apps/worker/schema.graphql matches the schema.");
} else {
  writeFileSync(file, printed);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
