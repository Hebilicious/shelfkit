import { vize } from "@vizejs/vite-plugin";
import { defineConfig } from "vite";

/** The Worker `vite dev` forwards the API to: `wrangler dev`, on 8787 unless SHELFKIT_WORKER_PORT says otherwise. */
const worker = `http://127.0.0.1:${process.env.SHELFKIT_WORKER_PORT ?? "8787"}`;

/**
 * Vize compiles SFCs natively, as a drop-in for @vitejs/plugin-vue.
 *
 * Vize is not production-ready by its own documentation, so this integration
 * is confined to the build config: swapping in @vitejs/plugin-vue is a
 * one-line change, and both paths stay green in CI. See docs/PRD.md 10.4.
 */
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    target: "es2023",
  },
  plugins: [vize()],
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
