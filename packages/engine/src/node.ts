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

/**
 * Every file of the shelf at `root`, as the native loader (`DirSource`) reads it: text as strings, with a byte-order mark
 * kept, anything that is not UTF-8 as bytes, and each symbolic link under `items/`, `bundles/`, or `profiles/` passed on
 * as a link, which the loader then refuses, naming it.
 */
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
  const entries = listings.flat();
  const relative = (entry: (typeof entries)[number]) =>
    path
      .relative(root, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
  const links: ShelfFile[] = entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => ({ path: relative(entry), symlink: true }));
  const paths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(entry));
  const files = await Promise.all(
    ["shelf.json", ...paths].map(
      async (file) => await readShelfFile(root, file)
    )
  );
  return [...files, ...links].toSorted((a, b) =>
    a.path < b.path ? -1 : Number(a.path > b.path)
  );
}

async function readShelfFile(
  root: string,
  relative: string
): Promise<ShelfFile> {
  const bytes = new Uint8Array(await readFile(path.join(root, relative)));
  try {
    // `ignoreBOM` keeps a byte-order mark in the text, as the native loader keeps it in the bytes.
    return {
      contents: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
      path: relative,
    };
  } catch {
    return { contents: bytes, path: relative };
  }
}
