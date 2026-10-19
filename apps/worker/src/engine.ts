/**
 * The shelf engine in the Worker and in the shelf's Durable Object: the WASM module wrangler bundles as a compiled
 * `WebAssembly.Module`, instantiated once per isolate on first use rather than at startup.
 */
import { createEngine } from "@shelfkit/engine";
import type { Engine } from "@shelfkit/engine";
import wasm from "@shelfkit/engine/shelfkit.wasm";

import { once } from "./runtime/once.ts";

export const engine: () => Promise<Engine> = once(
  async () => await createEngine(wasm)
);
