/**
 * A local repository opened with the File System Access API: what the Compile screen reads from it, and how it writes a
 * compile into it.
 *
 * The decisions are the engine's (`Engine.output`, the code `shelfkit compile --repo` runs): this module only describes
 * the repository as a `RepositorySnapshot` and carries out the `RepositoryOutput` it gets back, in the CLI's order:
 * write, then remove, then prune empty directories. It never decides what to merge, keep, or delete.
 */
import type {
  RepositoryOutput,
  RepositorySnapshot,
  VendorEntry,
} from "@shelfkit/engine";

/** The marker a package ShelfKit vendored carries in its `apm.yml`; only such packages need their files listed. */
const OWNER_MARKER = "x-shelfkit-vendored-for";

/** What the screen learns from a repository. */
export interface OpenedRepository {
  readonly name: string;
  readonly snapshot: RepositorySnapshot;
  /** Why the browser cannot describe the repository to the engine, when it cannot; nothing is written then. */
  readonly refusal: string | null;
  /** The root `package.json`, for the stack-marker match. */
  readonly packageJson: string | null;
  /** The names at the repository's root. */
  readonly rootNames: readonly string[];
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A file's text, or `null` when it is not UTF-8. */
async function readText(handle: FileSystemFileHandle): Promise<string | null> {
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

type Entry = FileSystemDirectoryHandle | FileSystemFileHandle;

async function entriesOf(
  directory: FileSystemDirectoryHandle
): Promise<Entry[]> {
  const found: Entry[] = [];
  for await (const entry of directory.values()) {
    if (
      entry instanceof FileSystemDirectoryHandle ||
      entry instanceof FileSystemFileHandle
    ) {
      found.push(entry);
    }
  }
  return found.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Every file under a directory, by path relative to it. */
async function filesUnder(
  directory: FileSystemDirectoryHandle,
  prefix = ""
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await entriesOf(directory)) {
    const path = `${prefix}${entry.name}`;
    if (entry.kind === "directory") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a directory at a time keeps the listing in order.
      const nested = await filesUnder(entry, `${path}/`);
      files.push(...nested);
    } else {
      files.push(path);
    }
  }
  return files;
}

async function vendorEntry(
  entry: Entry,
  undecodable: string[]
): Promise<VendorEntry> {
  if (entry.kind === "file") {
    return { files: [], name: entry.name };
  }
  const children = await entriesOf(entry);
  const manifest = children.find((child) => child.name === "apm.yml");
  if (manifest === undefined || manifest.kind === "directory") {
    return { files: [], name: entry.name };
  }
  const text = await readText(manifest);
  if (text === null) {
    undecodable.push(`vendor/${entry.name}/apm.yml`);
    return { files: [], name: entry.name };
  }
  const listed = text.includes(OWNER_MARKER) ? await filesUnder(entry) : [];
  const files = listed.filter((file) => file !== "apm.yml");
  return { apmYml: text, files, name: entry.name };
}

/** Describe a repository as the engine reads one. */
export async function readRepository(
  root: FileSystemDirectoryHandle
): Promise<OpenedRepository> {
  const top = await entriesOf(root);
  const byName = new Map(top.map((entry) => [entry.name, entry]));
  const undecodable: string[] = [];
  let refusal: string | null = null;
  let apmYml: string | undefined;

  const manifest = byName.get("apm.yml");
  if (manifest?.kind === "directory") {
    refusal =
      "apm.yml is a directory, so it cannot be a manifest; move it, or compile into another repository.";
  } else if (manifest !== undefined) {
    const text = await readText(manifest);
    if (text === null) {
      undecodable.push("apm.yml");
    } else {
      apmYml = text;
    }
  }

  const vendor: VendorEntry[] = [];
  const vendorDir = byName.get("vendor");
  if (vendorDir?.kind === "file") {
    refusal ??=
      "vendor is a file, so no package can be vendored into it; move it, or compile into another repository.";
  } else if (vendorDir !== undefined) {
    for (const entry of await entriesOf(vendorDir)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one package at a time; each reads only its own apm.yml.
      vendor.push(await vendorEntry(entry, undecodable));
    }
  }

  const packageFile = byName.get("package.json");
  const packageJson =
    packageFile?.kind === "file" ? await readText(packageFile) : null;

  const snapshot: RepositorySnapshot =
    apmYml === undefined
      ? { undecodable, vendor }
      : { apmYml, undecodable, vendor };
  return {
    name: root.name,
    packageJson,
    refusal,
    rootNames: top.map((entry) => entry.name),
    snapshot,
  };
}

/** The directory a repository-relative path lives in, created on the way when `create`. */
async function parentOf(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  let directory = root;
  for (const part of parts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each directory is opened inside the one before it.
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return { directory, name };
}

function bytesOf(
  contents: string,
  encoding: "utf-8" | "base64"
): Uint8Array<ArrayBuffer> {
  if (encoding === "utf-8") {
    return new TextEncoder().encode(contents);
  }
  const binary = atob(contents);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}

/** BOUNDARY: a `catch` hands over whatever was thrown; this recognises the browser's "directory not empty". */
function isNotEmptyError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "InvalidModificationError"
  );
}

/** Carry out a compile the engine planned: write, then remove stale files, then prune directories left empty. */
export async function applyOutput(
  root: FileSystemDirectoryHandle,
  output: RepositoryOutput
): Promise<void> {
  if (output.refused.length > 0) {
    throw new Error(output.refused.join("\n"));
  }
  for (const file of output.write) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- files are written in the engine's order, one at a time.
    const { directory, name } = await parentOf(root, file.path, true);
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    const handle = await directory.getFileHandle(name, { create: true });
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    const writable = await handle.createWritable();
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    await writable.write(bytesOf(file.contents, file.encoding));
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    await writable.close();
  }
  for (const path of output.remove) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- removals run in order, as the CLI's do.
    const { directory, name } = await parentOf(root, path, false);
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    await directory.removeEntry(name);
  }
  for (const path of output.prune) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- deepest first, so each parent sees its child gone.
      const { directory, name } = await parentOf(root, path, false);
      // A non-recursive removal: a directory that still holds something stays, as the CLI leaves it.
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
      await directory.removeEntry(name);
    } catch (error) {
      if (!isNotEmptyError(error)) {
        throw error;
      }
    }
  }
}

/** `sha256:<hex>` of a text's UTF-8 bytes: the digest `shelf.report` records for the `apm.yml` written. */
export async function textDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Whether this browser can open a directory for writing. */
export function canOpenDirectories(): boolean {
  return "showDirectoryPicker" in window;
}

/** Ask the person for a repository directory, with write access. */
export async function pickRepository(): Promise<FileSystemDirectoryHandle> {
  return await window.showDirectoryPicker({
    id: "shelfkit-repository",
    mode: "readwrite",
  });
}
