import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";
import vue from "ultracite/oxlint/vue";

/**
 * Ultracite's core, Vue and Vitest presets, with the vendored anti-slop rules on top. A rule that is off says why
 * beside it. Three Ultracite rules are adjusted, each kept to its intent:
 *
 * - `func-style` asks for one style; this code declares named functions and keeps arrows for callbacks.
 * - `no-use-before-define` still reports a read before definition in the same scope, which throws; a hoisted function,
 *   or a constant read inside a function declared above it, may sit below its caller, so a module reads top-down.
 * - `func-names` leaves generators alone.
 */
export default defineConfig({
  extends: [core, vue, vitest],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".worktrees/**",
    "**/.vize/**",
    "**/.wrangler/**",
    "**/dist/**",
    "**/dist-worker/**",
    "crates/**",
    "apps/worker/worker-configuration.d.ts",
    "apps/worker/drizzle/**",
    "packages/tokens/.cssforge/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    {
      name: "anti-slop",
      specifier: "./tools/oxlint/anti-slop/index.ts",
    },
  ],
  overrides: [
    {
      files: [
        "apps/web/**",
        "tools/**",
        "scripts/**",
        "**/*.config.ts",
        "**/*.test.ts",
      ],
      // Browser presentation, tooling, configuration and tests are not shared by the requests an isolate serves.
      rules: { "anti-slop/no-module-level-mutable-state": "off" },
    },
    {
      files: ["packages/tokens/cssforge.config.ts"],
      // Key order is emission order: CSSForge writes tokens as declared, and the dark theme's media query has to
      // follow the light defaults to win the cascade.
      rules: { "sort-keys": "off" },
    },
  ],
  rules: {
    // It rewrites readable `filter`/`map` chains for an allocation cost no measurement has shown.
    "anti-slop/no-array-filter-map": "off",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": [
      "error",
      {
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-module-level-mutable-state": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": [
      "error",
      {
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": [
      "error",
      {
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-runtime-typeof": [
      "error",
      {
        allowInTypeGuards: true,
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unbounded-wait": "error",
    "anti-slop/no-unknown-parameters": [
      "error",
      {
        allowInTypeGuards: true,
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-unknown-returns": [
      "error",
      {
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": [
      "error",
      {
        allowWithBoundaryComment: true,
      },
    ],
    "anti-slop/no-wall-clock-budget": "error",
    "anti-slop/no-widen-then-assert": "error",
    // Its blank-line policy is a style choice; oxfmt owns layout here.
    "anti-slop/require-readable-spacing": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "func-names": ["error", "as-needed", { generators: "never" }],
    "func-style": ["error", "declaration", { allowArrowFunctions: true }],
    "no-use-before-define": [
      "error",
      { classes: true, functions: false, variables: false },
    ],
  },
});
