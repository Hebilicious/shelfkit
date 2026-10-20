/**
 * The shelf engine in the browser: the same Rust compiler, as WebAssembly, that `shelfkit compile --dry-run` runs
 * natively and the Worker runs for `previewProfile` (`docs/PRD.md` section 10.2). The composer runs it on the shelf's
 * files plus the unsaved profile, so its `apm.yml` preview is the CLI's output byte for byte.
 *
 * The shelf's files are its current snapshot, downloaded once each from `/raw/{shelf}/objects/{sha256}` with the
 * browser's cookie. An object's name is its content's hash, so a download is cached for the page's lifetime.
 */
import { createEngine } from "@shelfkit/engine";
import type { Engine, ShelfFile } from "@shelfkit/engine";
import wasmUrl from "@shelfkit/engine/shelfkit.wasm?url";

let engine: Promise<Engine> | null = null;

async function compileModule(): Promise<WebAssembly.Module> {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(
      `the engine could not be downloaded: ${response.status} ${response.statusText}`
    );
  }
  // compileStreaming needs `application/wasm`; a host that labels it otherwise still gets the bytes compiled.
  if (
    (response.headers.get("content-type") ?? "").includes("application/wasm")
  ) {
    return await WebAssembly.compileStreaming(response);
  }
  return await WebAssembly.compile(await response.arrayBuffer());
}

async function instantiate(): Promise<Engine> {
  return await createEngine(await compileModule());
}

/** The engine, instantiated once per page on first use. A failed load is tried again on the next call. */
export async function loadEngine(): Promise<Engine> {
  engine ??= instantiate();
  try {
    return await engine;
  } catch (error) {
    engine = null;
    throw error;
  }
}

const objects = new Map<string, Promise<Uint8Array>>();

async function download(shelf: string, sha256: string): Promise<Uint8Array> {
  const response = await fetch(
    `/raw/${encodeURIComponent(shelf)}/objects/${sha256}`,
    { credentials: "same-origin" }
  );
  if (!response.ok) {
    throw new Error(
      `the shelf's file ${sha256.slice(0, 12)}… could not be read: ${response.status}`
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function object(shelf: string, sha256: string): Promise<Uint8Array> {
  let loading = objects.get(sha256);
  if (loading === undefined) {
    loading = download(shelf, sha256);
    objects.set(sha256, loading);
  }
  try {
    return await loading;
  } catch (error) {
    objects.delete(sha256);
    throw error;
  }
}

// `ignoreBOM`: a leading byte-order mark is part of the file, as the CLI, the Node host and the Worker read it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A file as the engine reads it: text when it is UTF-8, bytes otherwise, exactly as the CLI reads a directory. */
function asShelfFile(path: string, bytes: Uint8Array): ShelfFile {
  try {
    return { contents: utf8.decode(bytes), path };
  } catch {
    return { contents: bytes, path };
  }
}

/** One file of a snapshot, as `Shelf.files` lists it. */
export interface SnapshotEntry {
  readonly path: string;
  readonly sha256: string;
}

/** Every file of the shelf's snapshot, ready for the engine. */
export async function shelfFiles(
  shelf: string,
  entries: readonly SnapshotEntry[]
): Promise<ShelfFile[]> {
  return await Promise.all(
    entries.map(async (entry) =>
      asShelfFile(entry.path, await object(shelf, entry.sha256))
    )
  );
}
