/**
 * The engine in Node: the module read from disk, and a shelf read from a directory. Not for the Worker or the browser,
 * which have no filesystem; they pass a compiled module to `createEngine`.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createEngine } from "./index.ts";
import type { Engine, ShelfFile } from "./index.ts";

/** Where `moon run engine:build` places the module. */
export const WASM_PATH = path.resolve(
  import.meta.dirname,
  "../wasm/shelfkit.wasm"
);

/** Instantiate the engine from a module file, by default the one this package builds. */
export async function loadEngine(
  wasmPath: string = WASM_PATH
): Promise<Engine> {
  return await createEngine(await readFile(wasmPath));
}

/** The directories a shelf keeps its files in, besides shelf.json. */
const SHELF_DIRECTORIES = ["items", "bundles", "profiles"];

/** Every file of the shelf at `root`: text as strings, anything that is not UTF-8 as bytes. Symbolic links are left out. */
export async function readShelf(root: string): Promise<ShelfFile[]> {
  const listings = await Promise.all(
    SHELF_DIRECTORIES.map(async (directory) => {
      try {
        return await readdir(path.join(root, directory), {
          recursive: true,
          withFileTypes: true,
        });
      } catch {
        // A shelf may have no bundles/ or items/ yet.
        return [];
      }
    })
  );
  const paths = listings
    .flat()
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/")
    );
  const files = await Promise.all(
    ["shelf.json", ...paths].map(
      async (relative) => await readShelfFile(root, relative)
    )
  );
  return files.toSorted((a, b) =>
    a.path < b.path ? -1 : Number(a.path > b.path)
  );
}

async function readShelfFile(
  root: string,
  relative: string
): Promise<ShelfFile> {
  const bytes = new Uint8Array(await readFile(path.join(root, relative)));
  try {
    return {
      contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      path: relative,
    };
  } catch {
    return { contents: bytes, path: relative };
  }
}
