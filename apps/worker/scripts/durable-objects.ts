#!/usr/bin/env tsx
/**
 * Generate `wrangler.jsonc`'s Durable Object bindings and migration entries from `src/durable-objects.ts`, or check
 * them with `--check`. See that file for the rules. Wrangler owns the migrations; this keeps an operator from writing
 * them by hand (`docs/PRD.md` section 10.5).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DURABLE_OBJECTS } from "../src/durable-objects.ts";

const worker = path.resolve(import.meta.dirname, "..");
const configPath = path.join(worker, "wrangler.jsonc");
const indexPath = path.join(worker, "src/index.ts");

interface Migration {
  readonly tag: string;
  readonly new_sqlite_classes?: readonly string[];
  readonly new_classes?: readonly string[];
  readonly deleted_classes?: readonly string[];
  readonly renamed_classes?: readonly {
    readonly from: string;
    readonly to: string;
  }[];
}

/** A migration entry being generated. */
interface MigrationDraft {
  tag: string;
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
}

/** JSONC to JSON: comments and trailing commas removed, strings left alone. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      out += "\n";
    } else if (char === "/" && next === "*") {
      index = text.indexOf("*/", index + 2) + 1;
    } else {
      out += char;
    }
  }
  return out.replaceAll(/,(?<close>\s*[}\]])/gu, "$<close>");
}

interface Config {
  readonly durable_objects?: {
    readonly bindings?: readonly {
      readonly name: string;
      readonly class_name: string;
    }[];
  };
  readonly migrations?: readonly Migration[];
}

function readConfig(text: string): Config {
  const parsed: unknown = JSON.parse(stripJsonc(text));
  if (!isConfig(parsed)) {
    throw new Error("wrangler.jsonc is not an object");
  }
  return parsed;
}

// BOUNDARY: wrangler.jsonc is Wrangler's to validate; this reads the two fields it generates, as Wrangler's schema has them.
function isConfig(value: unknown): value is Config {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The classes the migrations have created and not deleted, in order. */
function liveClasses(migrations: readonly Migration[]): string[] {
  const live: string[] = [];
  for (const migration of migrations) {
    live.push(
      ...(migration.new_sqlite_classes ?? []),
      ...(migration.new_classes ?? [])
    );
    for (const { from, to } of migration.renamed_classes ?? []) {
      live.splice(live.indexOf(from), 1, to);
    }
    for (const deleted of migration.deleted_classes ?? []) {
      live.splice(live.indexOf(deleted), 1);
    }
  }
  return live;
}

/** The migrations with whatever entry makes them match the model appended. */
function generate(migrations: readonly Migration[]): Migration[] {
  const live = new Set(liveClasses(migrations));
  const wanted = DURABLE_OBJECTS.map((entry) => entry.className);
  const added = wanted.filter((name) => !live.has(name));
  const deleted = [...live].filter((name) => !wanted.includes(name));
  if (added.length === 0 && deleted.length === 0) {
    return [...migrations];
  }
  const entry: MigrationDraft = { tag: `v${migrations.length + 1}` };
  if (added.length > 0) {
    entry.new_sqlite_classes = added;
  }
  if (deleted.length > 0) {
    entry.deleted_classes = deleted;
  }
  return [...migrations, entry];
}

function render(migrations: readonly Migration[]): string {
  const lines = migrations.map((migration) => {
    const fields = Object.entries(migration).map(
      ([key, value]) =>
        `"${key}": ${JSON.stringify(value).replaceAll(",", ", ")}`
    );
    return `    { ${fields.join(", ")} },`;
  });
  return `"migrations": [\n${lines.join("\n")}\n  ],`;
}

function renderBindings(): string {
  const entries = DURABLE_OBJECTS.map(
    (entry) =>
      `{ "name": "${entry.binding}", "class_name": "${entry.className}" }`
  );
  return `"bindings": [${entries.join(", ")}],`;
}

const text = readFileSync(configPath, "utf-8");
const config = readConfig(text);
const migrations = config.migrations ?? [];
const generated = generate(migrations);
const problems: string[] = [];

const exported = readFileSync(indexPath, "utf-8");
for (const entry of DURABLE_OBJECTS) {
  if (
    !new RegExp(`export\\s*\\{[^}]*\\b${entry.className}\\b`, "u").test(
      exported
    )
  ) {
    problems.push(
      `src/index.ts does not export the Durable Object class ${entry.className}`
    );
  }
}
const bindings = (config.durable_objects?.bindings ?? []).map(
  (binding) => `${binding.name}=${binding.class_name}`
);
const wantedBindings = DURABLE_OBJECTS.map(
  (entry) => `${entry.binding}=${entry.className}`
);
if (JSON.stringify(bindings) !== JSON.stringify(wantedBindings)) {
  problems.push(
    `durable_objects.bindings are [${bindings.join(", ")}], the model says [${wantedBindings.join(", ")}]`
  );
}
if (generated.length !== migrations.length) {
  problems.push(`the migrations lack ${JSON.stringify(generated.at(-1))}`);
}

if (process.argv.includes("--check")) {
  if (problems.length > 0) {
    console.error(
      `wrangler.jsonc is out of step with src/durable-objects.ts; run \`moon run worker:do-migrations\`:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`
    );
    process.exit(1);
  }
  console.log(
    `wrangler.jsonc's Durable Object bindings and ${migrations.length} migration(s) match src/durable-objects.ts.`
  );
} else {
  const updated = text
    .replace(/"migrations":\s*\[[\s\S]*?\n {2}\],/u, render(generated))
    .replace(/"bindings":\s*\[[^\]]*\],/u, renderBindings());
  writeFileSync(configPath, updated);
  console.log(
    `wrangler.jsonc: ${generated.length} migration(s); bindings ${wantedBindings.join(", ")}.`
  );
}
