/**
 * What the Playwright specs share: the deployment they run against, the owner key it trusts, the CLI built from this
 * repository, and seeding a shelf through `shelfkit push`, the way a person would.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const PORT = 8792;
export const BASE_URL = `http://localhost:${PORT}`;

/** A test value only: the Worker under test is given its hash, as `moon run worker:setup` does for a deployment. */
export const OWNER_KEY = "sko_e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee";

export const REPOSITORY = path.resolve(import.meta.dirname, "../../../..");
const BINARY = path.join(
  REPOSITORY,
  "target/debug",
  process.platform === "win32" ? "shelfkit.exe" : "shelfkit"
);

export const FIXTURES = {
  allKinds: path.join(REPOSITORY, "crates/core/tests/fixtures/all-kinds"),
  own: path.join(REPOSITORY, "shelf"),
} as const;

/** A fresh temporary directory. */
export function temporary(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `shelfkit-e2e-${prefix}-`));
}

/** Run the CLI against the deployment under test, with the owner key, and return its standard output. */
export function shelfkit(args: readonly string[]): string {
  return execFileSync(BINARY, args, {
    encoding: "utf-8",
    env: { ...process.env, SHELFKIT_KEY: OWNER_KEY, SHELFKIT_URL: BASE_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Copy a fixture shelf, name it `namespace` on the registry, and push it. Returns the local copy. */
export function seedShelf(fixture: string, namespace: string): string {
  const root = temporary(namespace);
  cpSync(fixture, root, { recursive: true });
  const manifestPath = path.join(root, "shelf.json");
  const manifest = readFileSync(manifestPath, "utf-8").replace(
    /"namespace":\s*"[^"]*"/u,
    `"namespace": "${namespace}"`
  );
  writeFileSync(manifestPath, manifest);
  // `--force`: a spec's shelf may hold edits from an earlier attempt of the same run.
  shelfkit(["--shelf", root, "push", "--force", "-m", "seed"]);
  return root;
}

/** `shelfkit compile --dry-run --json`: the plan exactly as the CLI prints it. */
export function dryRun(shelfRoot: string, profile: string): string {
  return shelfkit([
    "--shelf",
    shelfRoot,
    "compile",
    "--dry-run",
    "--json",
    profile,
  ]);
}

/** Download a hosted shelf's snapshot, as `shelfkit fetch` does. */
export function fetchShelf(id: string): string {
  const root = temporary(`fetch-${id}`);
  shelfkit(["fetch", "--id", id, "--out", root]);
  return root;
}

/** File contents by path relative to a repository's root. */
export type FileTree = Record<string, string>;

/** Every file under a directory, by path relative to it, as text, sorted by path. */
export function readTree(root: string, prefix = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(path.join(root, prefix)).toSorted()) {
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(path.join(root, relative)).isDirectory()) {
      for (const [file, contents] of readTree(root, relative)) {
        files.set(file, contents);
      }
    } else {
      files.set(relative, readFileSync(path.join(root, relative), "utf-8"));
    }
  }
  return files;
}

/** Sign in through the sign-in screen with the owner key; the browser keeps it in the HttpOnly cookie. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Key").fill(OWNER_KEY);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("viewer")).toHaveText("Owner");
}

/** The clipboard's text. */
export async function clipboard(page: Page): Promise<string> {
  return await page.evaluate(async () => await navigator.clipboard.readText());
}
