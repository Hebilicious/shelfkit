/**
 * M3's exit criterion (`docs/PRD.md` section 12), using only the browser: someone who has never used the CLI finds a
 * prompt, copies it with its variables filled in, then composes a profile and compiles it into a local repository.
 *
 * The repository is a directory the browser opens with the File System Access API. Playwright cannot click through the
 * native folder picker, so the picker is given a directory of the origin's private file system instead; everything
 * after it (reading the repository, `Engine.output`, writing) is the code a person's browser runs. The result is then
 * compared, file by file, with what `shelfkit compile --repo` writes into a copy of the same repository.
 */
import { expect, test } from "@playwright/test";

import {
  browserRepository,
  stubDirectoryPicker,
  writeBrowserRepository,
  writeDiskRepository,
} from "./repository.ts";
import {
  FIXTURES,
  clipboard,
  fetchShelf,
  seedShelf,
  shelfkit,
  signIn,
  sortedTree,
  temporary,
} from "./support.ts";
import type { FileTree } from "./support.ts";

const SHELF = "m3-e2e";
const REPOSITORY_NAME = "my-repo";

/** What the repository holds before the compile: its own manifest, which the compile merges into. */
const EXISTING: FileTree = {
  "apm.yml":
    "name: my-app\nversion: 1.2.3\ndependencies:\n  apm:\n    - acme/house-style\n",
  "package.json":
    '{\n  "name": "my-app",\n  "packageManager": "pnpm@11.8.0",\n  "dependencies": { "vue": "^3.5.0" }\n}\n',
};

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF);
});

test("finds a prompt, copies it filled in, composes a profile and compiles it into a repository", async ({
  page,
}) => {
  await stubDirectoryPicker(page, REPOSITORY_NAME);

  await signIn(page);
  await page.goto(`/shelves/${SHELF}`);
  await writeBrowserRepository(page, REPOSITORY_NAME, EXISTING, true);

  // 1. Find a prompt by what it says, and copy it with its variables filled in.
  await page.locator("body").press("g");
  await page.locator("body").press("l");
  await page.locator("body").press("/");
  await page.keyboard.type("staged diff");
  await page
    .getByTestId("prompt-list")
    .getByText("PR description", { exact: true })
    .click();
  await page.locator('input[name="var-ticket"]').fill("SK-7");
  await page.locator('input[name="var-audience"]').fill("the release manager");
  await page.getByTestId("copy-text").click();
  await expect
    .poll(async () => await clipboard(page))
    .toBe(
      "Write a pull request description for the staged diff.\n\nAudience: the release manager\nTicket: SK-7\n"
    );

  // 2. Compose a profile from the inventory.
  await page.locator("body").press("Escape");
  await page.locator("body").press("g");
  await page.locator("body").press("c");
  await expect(page).toHaveURL((url) =>
    url.pathname.endsWith(`/shelves/${SHELF}/compose`)
  );
  await page.locator('input[name="title"]').fill("My app");
  await page.getByTestId("add-pr-description").click();
  await page.getByTestId("add-vue-sfc-patterns").click();
  await page.getByTestId("add-drizzle").click();
  await expect(page.getByTestId("preview-runner")).toHaveText(
    "compiled in your browser"
  );
  await page.getByTestId("save-profile").click();
  await expect(page).toHaveURL((url) =>
    url.pathname.endsWith(`/compose/my-app`)
  );

  // 3. Compile it into the local repository.
  await page.locator("body").press("g");
  await page.locator("body").press("k");
  await page.getByTestId("compile-profile").selectOption("my-app");
  await expect(page.getByTestId("compile-apm-yml")).toContainText(
    "name: my-app"
  );
  await page.getByTestId("open-repository").click();
  await expect(page.getByTestId("repository-name")).toHaveText(REPOSITORY_NAME);
  await expect(page.getByTestId("repository-stacks")).toBeVisible();
  await page.getByTestId("write-repository").click();
  await expect(page.getByTestId("written")).toBeVisible();

  // What the browser wrote is exactly what the CLI writes into the same repository.
  const cliRepository = temporary("m3-repo");
  writeDiskRepository(cliRepository, EXISTING);
  shelfkit([
    "--shelf",
    fetchShelf(SHELF),
    "compile",
    "my-app",
    "--repo",
    cliRepository,
  ]);
  const written = await browserRepository(page, REPOSITORY_NAME);
  expect(written).toStrictEqual(sortedTree(cliRepository));
  expect(new Map(written).get("apm.yml")).toContain("acme/house-style");

  // 4. Copy the install command.
  await page.getByTestId("copy-install").click();
  await expect
    .poll(async () => await clipboard(page))
    .toBe(await page.getByTestId("install-command").textContent());

  // The compile is on record: which repository compiled which revision.
  await page.locator("body").press("g");
  await page.locator("body").press("a");
  await expect(page.getByTestId("activity")).toContainText(REPOSITORY_NAME);
  await expect(page.getByTestId("activity")).toContainText("my-app");
});
