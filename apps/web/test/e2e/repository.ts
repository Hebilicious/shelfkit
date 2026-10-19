/**
 * A repository in the browser, for the specs that compile into one. Playwright cannot click through the native folder
 * picker, so `showDirectoryPicker` is given a directory of the origin's private file system (OPFS) instead. Everything
 * after the picker (reading the repository, `Engine.output`, writing) is the code a person's browser runs. The same
 * files are written to a directory on disk, so `shelfkit compile --repo` can compile into an identical repository.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import type { FileTree } from "./support.ts";

/** Make the folder picker answer with the OPFS directory `name`. Call before the page loads. */
export async function stubDirectoryPicker(
  page: Page,
  name: string
): Promise<void> {
  await page.addInitScript((directory) => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return await root.getDirectoryHandle(directory, { create: true });
    };
  }, name);
}

/** Write files into the OPFS repository `name`, creating directories on the way; `fresh` empties it first. */
export async function writeBrowserRepository(
  page: Page,
  name: string,
  files: FileTree,
  fresh = false
): Promise<void> {
  await page.evaluate(
    async ({ directory, entries, empty }) => {
      const root = await navigator.storage.getDirectory();
      if (empty) {
        await root
          .removeEntry(directory, { recursive: true })
          .catch(() => null);
      }
      const repo = await root.getDirectoryHandle(directory, { create: true });
      // One file at a time, each directory created inside the one before it.
      for (const [file, contents] of entries) {
        const parts = file.split("/");
        const leaf = parts.pop() ?? "";
        let parent = repo;
        for (const part of parts) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- a directory is opened inside its parent.
          parent = await parent.getDirectoryHandle(part, { create: true });
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        const handle = await parent.getFileHandle(leaf, { create: true });
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        const writable = await handle.createWritable();
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        await writable.write(contents);
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        await writable.close();
      }
    },
    { directory: name, empty: fresh, entries: Object.entries(files) }
  );
}

/** Every file of the OPFS repository `name`, sorted by path. */
export async function browserRepository(
  page: Page,
  name: string
): Promise<[string, string][]> {
  const files = await page.evaluate(async (directory) => {
    const found: [string, string][] = [];
    async function walk(
      handle: FileSystemDirectoryHandle,
      prefix: string
    ): Promise<void> {
      for await (const entry of handle.values()) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry instanceof FileSystemDirectoryHandle) {
          await walk(entry, relative);
        } else if (entry instanceof FileSystemFileHandle) {
          const file = await entry.getFile();
          found.push([relative, await file.text()]);
        }
      }
    }
    const root = await navigator.storage.getDirectory();
    await walk(await root.getDirectoryHandle(directory), "");
    return found;
  }, name);
  return files.toSorted(([a], [b]) => a.localeCompare(b));
}

/** Whether a directory exists in the OPFS repository `name`. */
export async function browserDirectoryExists(
  page: Page,
  name: string,
  directory: string
): Promise<boolean> {
  return await page.evaluate(
    async ({ repository, parts }) => {
      const root = await navigator.storage.getDirectory();
      let handle = await root.getDirectoryHandle(repository);
      try {
        for (const part of parts) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- a directory is opened inside its parent.
          handle = await handle.getDirectoryHandle(part);
        }
        return true;
      } catch {
        return false;
      }
    },
    { parts: directory.split("/"), repository: name }
  );
}

/** Write files into a directory on disk; `fresh` empties it first. */
export function writeDiskRepository(
  root: string,
  files: FileTree,
  fresh = false
): void {
  if (fresh) {
    rmSync(root, { force: true, recursive: true });
  }
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), contents);
  }
}
