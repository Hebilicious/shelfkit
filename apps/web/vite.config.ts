import vue from "@vitejs/plugin-vue";
import { vize } from "@vizejs/vite-plugin";
import { defineConfig } from "vite";

/** The Worker `vite dev` forwards the API to: `wrangler dev`, on 8787 unless SHELFKIT_WORKER_PORT says otherwise. */
const worker = `http://127.0.0.1:${process.env.SHELFKIT_WORKER_PORT ?? "8787"}`;

/**
 * Vize compiles SFCs natively, as a drop-in for @vitejs/plugin-vue.
 *
 * Vize is not production-ready by its own documentation, so @vitejs/plugin-vue is the fallback and both paths stay
 * green: `SHELFKIT_SFC=plugin-vue` builds with it into `dist-plugin-vue/` (`moon run web:build-plugin-vue`, part of
 * `web:check`). See docs/PRD.md 10.4.
 */
const fallback = process.env.SHELFKIT_SFC === "plugin-vue";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: fallback ? "dist-plugin-vue" : "dist",
    target: "es2023",
  },
  plugins: [fallback ? vue() : vize()],
  server: {
    port: 5173,
    proxy: {
      "/apm": worker,
      "/graphql": worker,
      "/mcp": worker,
      "/raw": worker,
    },
  },
});
