/**
 * A shelf's files as the object holds them: paths from the shelf root, each naming an R2 object by hash. These helpers
 * check a path, build the canonical snapshot manifest, and pick out the text the search index reads.
 */
import type { ShelfFile } from "@shelfkit/engine";

import type { SnapshotFile } from "./api.ts";

/** The files the shelf format reads (`docs/PRD.md` section 5): everything else in a shelf repository stays in Git. */
export function isShelfPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    return false;
  }
  if (path === "shelf.json") {
    return true;
  }
  const [top] = segments;
  return (
    segments.length > 1 &&
    (top === "items" || top === "bundles" || top === "profiles")
  );
}

/** The canonical manifest of a snapshot: files sorted by path, as compact JSON. Its SHA-256 is the snapshot's digest. */
export function manifestText(files: readonly SnapshotFile[]): string {
  const sorted = files
    .map((file) => ({ path: file.path, sha256: file.sha256, size: file.size }))
    .toSorted((a, b) => compare(a.path, b.path));
  return JSON.stringify({ files: sorted });
}

/** Byte order, as the Rust side sorts paths. */
export function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The shelf as the engine reads it. Every file goes as bytes, so nothing is re-encoded on the way. */
export function engineFiles(
  files: ReadonlyMap<string, Uint8Array>
): ShelfFile[] {
  return [...files]
    .map(([path, contents]) => ({ contents, path }))
    .toSorted((a, b) => compare(a.path, b.path));
}

/** The text a file holds, or `null` when it is not UTF-8. */
export function text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A file's contents as an MCP or GraphQL answer carries them. */
export interface EncodedFile {
  readonly contents: string;
  readonly encoding: "utf-8" | "base64";
}

/** A file's contents as an MCP or GraphQL answer carries them: text, or base64 for bytes that are not UTF-8. */
export function encoded(bytes: Uint8Array): EncodedFile {
  const utf8 = text(bytes);
  if (utf8 !== null) {
    return { contents: utf8, encoding: "utf-8" };
  }
  let binary = "";
  const chunk = 0x80_00;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(start, start + chunk));
  }
  return { contents: btoa(binary), encoding: "base64" };
}

/** Decode a file sent as text or base64. */
export function decoded(
  contents: string,
  encoding: "utf-8" | "base64"
): Uint8Array {
  if (encoding === "utf-8") {
    return new TextEncoder().encode(contents);
  }
  return Uint8Array.from(atob(contents), (char) => char.codePointAt(0) ?? 0);
}

/** How much of an item's markdown the search index keeps. */
const BODY_LIMIT = 64 * 1024;

/**
 * The text search reads for an item: its markdown files (`prompt.md`, `SKILL.md`, `agent.md`, `AGENTS.fragment.md`,
 * and any other), in path order, up to a limit.
 */
export function bodyText(
  itemPath: string,
  files: readonly string[],
  contents: ReadonlyMap<string, Uint8Array>
): string {
  const parts: string[] = [];
  let size = 0;
  for (const file of files.toSorted(compare)) {
    if (!file.endsWith(".md")) {
      continue;
    }
    const bytes = contents.get(`${itemPath}/${file}`);
    const found = bytes === undefined ? null : text(bytes);
    if (found === null) {
      continue;
    }
    parts.push(found);
    size += found.length;
    if (size >= BODY_LIMIT) {
      break;
    }
  }
  return parts.join("\n\n").slice(0, BODY_LIMIT);
}

/** The main text of an item: the one markdown file its kind is defined by, when it has one. */
export const PRIMARY_FILE: ReadonlyMap<string, string> = new Map([
  ["agent", "agent.md"],
  ["instructions", "AGENTS.fragment.md"],
  ["prompt", "prompt.md"],
  ["skill", "SKILL.md"],
]);
