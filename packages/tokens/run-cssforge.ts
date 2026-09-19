#!/usr/bin/env tsx
/**
 * Runs the CSSForge CLI.
 *
 * CSSForge is published to JSR, which npm-format registries expose as the
 * `@jsr/...` package. JSR packages carry no `bin` entry, so the CLI is invoked
 * through its exported `./cli` subpath rather than a `cssforge` binary.
 * See docs/PRD.md section 9.3.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const cli = require.resolve("@hebilicious/cssforge/cli");
const passthrough = process.argv.slice(2);

const result = spawnSync(
  process.execPath,
  [cli, "--config", "./cssforge.config.ts", "--mode", "all", ...passthrough],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
