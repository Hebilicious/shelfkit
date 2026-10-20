/**
 * The engine in Node: the module read from disk, and a shelf read from a directory. Not for the Worker or the browser,
 * which have no filesystem; they pass a compiled module to `createEngine`.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { SuiteSchema } from "./conformance.ts";
import type { Suite } from "./conformance.ts";
import { createEngine } from "./index.ts";
import type {
  Engine,
  RepositorySnapshot,
  ShelfFile,
  VendorEntry,
} from "./index.ts";

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

/** What is at `target`, without following a link; `undefined` when nothing is. */
async function kindAt(
  target: string
): Promise<"file" | "directory" | "link" | "other" | undefined> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      return "link";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
    return stats.isFile() ? "file" : "other";
  } catch {
    return undefined;
  }
}

/** The marker a package ShelfKit vendored carries in its `apm.yml`. */
const OWNER_KEY = "x-shelfkit-vendored-for";

/** A file's text, a byte-order mark kept as the CLI keeps it, or `undefined` when it is not UTF-8. */
async function readText(file: string): Promise<string | undefined> {
  const bytes = await readFile(file);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    return undefined;
  }
}

/** What reading a repository found besides text: its links, and the `apm.yml` files that are not UTF-8. */
interface Found {
  readonly links: string[];
  readonly undecodable: string[];
}

/** The text of the regular file at `relative`, noting it in `found` when it is a link or not UTF-8. */
async function readManifest(
  root: string,
  relative: string,
  found: Found
): Promise<string | undefined> {
  const kind = await kindAt(path.join(root, relative));
  if (kind === "link") {
    found.links.push(relative);
  }
  if (kind !== "file") {
    return undefined;
  }
  const text = await readText(path.join(root, relative));
  if (text === undefined) {
    found.undecodable.push(relative);
  }
  return text;
}

/**
 * The repository at `root` as `Engine.output` reads it: its `apm.yml`, every entry of `vendor/`, every symbolic link
 * there that the CLI would see, and every `apm.yml` that is not UTF-8. Unlike a browser, Node sees links, so this
 * reports each one. A package's files are listed only when its `apm.yml` mentions the ownership marker, since the
 * engine reads no others.
 */
export async function readRepository(
  root: string
): Promise<RepositorySnapshot> {
  const found: Found = { links: [], undecodable: [] };
  const apmYml = await readManifest(root, "apm.yml", found);
  const vendor: VendorEntry[] = [];
  const vendorKind = await kindAt(path.join(root, "vendor"));
  if (vendorKind === "link") {
    found.links.push("vendor");
  } else if (vendorKind === "directory") {
    const entries = await readdir(path.join(root, "vendor"), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        found.links.push(`vendor/${entry.name}`);
      } else if (!entry.isDirectory()) {
        vendor.push({ files: [], name: entry.name });
      }
    }
    const packages = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => await readPackage(root, entry.name, found))
    );
    vendor.push(...packages);
  }
  const snapshot = {
    links: found.links.toSorted(),
    undecodable: found.undecodable.toSorted(),
    vendor: vendor.toSorted((a, b) =>
      a.name < b.name ? -1 : Number(a.name > b.name)
    ),
  };
  return apmYml === undefined ? snapshot : { ...snapshot, apmYml };
}

/**
 * One directory of `vendor/`. Every link inside it goes into `found`, whoever owns it: the CLI refuses to write
 * through one wherever the plan reaches.
 */
async function readPackage(
  root: string,
  name: string,
  found: Found
): Promise<VendorEntry> {
  const directory = path.join(root, "vendor", name);
  const apmYml = await readManifest(root, `vendor/${name}/apm.yml`, found);
  const owned = apmYml?.includes(OWNER_KEY) === true;
  const files: string[] = [];
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    const relative = path
      .relative(directory, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    if (entry.isSymbolicLink()) {
      // The package's own apm.yml was noted by readManifest.
      if (relative !== "apm.yml") {
        found.links.push(`vendor/${name}/${relative}`);
      }
    } else if (owned && !entry.isDirectory()) {
      files.push(relative);
    }
  }
  const entry = { files: files.toSorted(), name };
  return apmYml === undefined ? entry : { ...entry, apmYml };
}

/** The registry conformance suite in this repository. */
export const CONFORMANCE_DIR = path.resolve(
  import.meta.dirname,
  "../../../crates/registry/conformance"
);

/** Read the conformance suite and its archives, checking each archive against its recorded digest. */
export async function loadConformanceSuite(
  directory: string = CONFORMANCE_DIR
): Promise<{
  readonly suite: Suite;
  readonly archives: ReadonlyMap<string, Uint8Array>;
}> {
  const suite = v.parse(
    SuiteSchema,
    JSON.parse(await readFile(path.join(directory, "cases.json"), "utf-8"))
  );
  const entries = await Promise.all(
    Object.entries(suite.archives).map(async ([name, entry]) => {
      const bytes = new Uint8Array(
        await readFile(path.join(directory, entry.file))
      );
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const digest = `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (digest !== entry.digest) {
        throw new Error(`${entry.file}: digest ${digest}, not ${entry.digest}`);
      }
      return [name, bytes] as const;
    })
  );
  const archives = new Map<string, Uint8Array>(entries);
  return { archives, suite };
}
