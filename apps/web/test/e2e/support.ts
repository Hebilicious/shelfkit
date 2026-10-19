/**
 * What the Playwright specs share: the deployment they run against, the owner key the CLI uses with it, the CLI built
 * from this repository, seeding a shelf through `shelfkit push`, and signing the browser in with GitHub, the way a
 * person would.
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

import { test as base, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import type { Profile } from "@shelfkit/schema";

import { FAKE_ACCOUNTS } from "./github.ts";

/**
 * Every spec's `test`: Playwright's, plus a check that runs on every page the spec opens and fails the test on any
 * Content-Security-Policy violation, so the whole suite runs under the SPA's CSP (`public/_headers`).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      const watch = (page: Page): void => {
        page.on("console", (message) => {
          if (
            message.type() === "error" &&
            message.text().includes("Content Security Policy")
          ) {
            violations.push(message.text());
          }
        });
      };
      for (const page of context.pages()) {
        watch(page);
      }
      context.on("page", watch);
      await use(violations);
      expect(violations).toStrictEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";

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

/**
 * Copy a fixture shelf, let `prepare` change the copy, name it `namespace` on the registry, and push it. Returns the
 * local copy.
 */
export function seedShelf(
  fixture: string,
  namespace: string,
  prepare?: (root: string) => void
): string {
  const root = temporary(namespace);
  cpSync(fixture, root, { recursive: true });
  prepare?.(root);
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

/** A `seedShelf` preparation that makes the shelf private, so only the owner and its grants read it. */
export function makePrivate(root: string): void {
  const manifestPath = path.join(root, "shelf.json");
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, "utf-8").replace(
      /"public":\s*true/u,
      '"public": false'
    )
  );
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

/** Every file under a directory, as `[path, text]` pairs sorted by path, to compare with `browserRepository`. */
export function sortedTree(root: string): [string, string][] {
  return [...readTree(root)].toSorted(([a], [b]) => a.localeCompare(b));
}

/**
 * Sign in through the sign-in screen, as a person does: "Sign in with GitHub", then the stand-in GitHub's authorize
 * page, as the owner's account unless another is given. The browser ends up with the HttpOnly session cookie.
 */
export async function signIn(
  page: Page,
  login: string = FAKE_ACCOUNTS.owner.login
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: `Authorize as @${login}` }).click();
  await expect(page.getByTestId("viewer")).toHaveText(`@${login}`);
}

/** The clipboard's text. */
export async function clipboard(page: Page): Promise<string> {
  return await page.evaluate(async () => await navigator.clipboard.readText());
}

/** Save a profile as another client would: over GraphQL, with the owner key in the `Authorization` header. */
export async function saveProfileAsOwner(
  request: APIRequestContext,
  shelf: string,
  document: Profile
): Promise<void> {
  const response = await request.post(`${BASE_URL}/graphql`, {
    data: {
      query:
        "mutation ($shelf: ID!, $document: JSON!) { saveProfile(shelf: $shelf, document: $document) { ok } }",
      variables: { document, shelf },
    },
    headers: { authorization: `Bearer ${OWNER_KEY}` },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toStrictEqual({
    data: { saveProfile: { ok: true } },
  });
}

/** Create a prompt as another client would: over GraphQL, with the owner key in the `Authorization` header. */
export async function writePromptAsOwner(
  request: APIRequestContext,
  shelf: string,
  prompt: { readonly id: string; readonly title: string; readonly body: string }
): Promise<void> {
  const response = await request.post(`${BASE_URL}/graphql`, {
    data: {
      query:
        "mutation ($shelf: ID!, $document: JSON!, $files: [ItemFileInput!]!) { writeItem(shelf: $shelf, document: $document, files: $files) { ok } }",
      variables: {
        document: { id: prompt.id, kind: "prompt", title: prompt.title },
        files: [{ contents: prompt.body, path: "prompt.md" }],
        shelf,
      },
    },
    headers: { authorization: `Bearer ${OWNER_KEY}` },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toStrictEqual({
    data: { writeItem: { ok: true } },
  });
}
