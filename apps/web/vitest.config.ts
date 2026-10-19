import { defineConfig } from "vitest/config";

/** Unit tests for the SPA's pure modules. The Playwright specs in `test/e2e` run separately (`web:e2e`). */
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
