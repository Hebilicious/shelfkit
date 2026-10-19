import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

/**
 * Ultracite's formatter settings. vize formats the Vue files, cargo formats the crates, and generated output stays as
 * its generator wrote it (the AcidCat catalog in AcidCat's canonical form), so oxfmt leaves them alone, as it leaves
 * moon's configuration and the task worktrees. The shelf is content an agent reads and a revision hashes, not code, so
 * it stays byte-for-byte as written.
 */
export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/moon.yml",
    ".moon/**/*.yml",
    ".worktrees/**",
    "**/.vize/**",
    "**/.wrangler/**",
    "**/dist/**",
    "**/dist-worker/**",
    "**/node_modules/**",
    "crates/**",
    "apps/web/src/**/*.vue",
    "apps/worker/worker-configuration.d.ts",
    "packages/schema/acidcat.catalog.json",
    "packages/tokens/.cssforge/**",
    "pnpm-lock.yaml",
    "shelf/**",
  ],
});
