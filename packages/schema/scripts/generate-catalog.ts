/**
 * Write `acidcat.catalog.json` from the capability descriptors, in canonical form. With `--check`, write nothing and
 * fail when the committed catalog differs from what the descriptors render.
 *
 * Usage: node scripts/generate-catalog.ts <file> [--check]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderShelfCatalog } from "../src/catalog.ts";

const [output, flag] = process.argv.slice(2);
if (output === undefined) {
  throw new Error("Usage: generate-catalog.ts <file> [--check]");
}
const file = path.resolve(output);
const text = renderShelfCatalog();

if (flag === "--check") {
  const committed = await readFile(file, "utf-8").catch(() => null);
  if (committed === text) {
    process.stdout.write(`${file} matches the capability descriptors\n`);
  } else {
    process.stderr.write(
      `${file} is stale: run \`moon run schema:catalog\` and commit it\n`
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(file, text, "utf-8");
  process.stdout.write(`${file}: written from the capability descriptors\n`);
}
