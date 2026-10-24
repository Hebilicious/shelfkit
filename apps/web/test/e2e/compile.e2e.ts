/**
 * Compiling into a local repository from the browser: what the browser writes is what `shelfkit compile --repo` writes,
 * including a recompile that removes stale vendored files and prunes the directories they leave empty, and a repository
 * that changed after it was opened is planned again rather than overwritten.
 */

import {
  browserDirectoryExists,
  browserRepository,
  stubDirectoryPicker,
  writeBrowserRepository,
  writeDiskRepository,
} from "./repository.ts";
import {
  FIXTURES,
  saveProfileAsOwner,
  fetchShelf,
  seedShelf,
  shelfkit,
  signIn,
  sortedTree,
  temporary,
  expect,
  test,
} from "./support.ts";

const SHELF = "compile-e2e";

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF);
});

test("a repository that changed after it was opened is planned again, not overwritten", async ({
  page,
}) => {
  const name = "stale-repo";
  await stubDirectoryPicker(page, name);
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  const opened = {
    "apm.yml":
      "name: app\nversion: 1.0.0\ndependencies:\n  apm:\n    - acme/one\n",
  };
  await writeBrowserRepository(page, name, opened, true);
  await page.getByTestId("open-repository").click();
  await expect(page.getByTestId("output-plan")).toBeVisible();

  // Someone edits the repository between opening it and writing.
  const edited = {
    "apm.yml":
      "name: app\nversion: 1.0.0\ndependencies:\n  apm:\n    - acme/one\n    - acme/added-after-open\n",
  };
  await writeBrowserRepository(page, name, edited);
  await page.getByTestId("write-repository").click();
  await expect(page.getByTestId("output-changed")).toBeVisible();
  await expect(page.getByTestId("written")).toHaveCount(0);
  expect(new Map(await browserRepository(page, name)).get("apm.yml")).toBe(
    edited["apm.yml"]
  );

  // The plan shown now is the repository's as it is; writing it keeps the line added after opening.
  await page.getByTestId("write-repository").click();
  await expect(page.getByTestId("written")).toBeVisible();
  const disk = temporary("stale-repo");
  writeDiskRepository(disk, edited);
  shelfkit([
    "--shelf",
    fetchShelf(SHELF),
    "compile",
    "minimal",
    "--repo",
    disk,
  ]);
  const written = await browserRepository(page, name);
  expect(written).toStrictEqual(sortedTree(disk));
  expect(new Map(written).get("apm.yml")).toContain("acme/added-after-open");
});

test("a recompile removes stale vendored files and prunes the directories they empty, as the CLI does", async ({
  page,
  request,
}) => {
  const name = "prune-repo";
  await stubDirectoryPicker(page, name);
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  const start = { "apm.yml": "name: app\n" };
  await writeBrowserRepository(page, name, start, true);
  const disk = temporary("prune-repo");
  writeDiskRepository(disk, start);

  // First compile: `minimal` vendors the prompt under vendor/minimal/.apm/prompts/.
  await page.getByTestId("open-repository").click();
  // The write reports its activity, and the live update that follows fetches the compile query again with an equal
  // plan. What was written must still be shown after that.
  const refetched = page.waitForResponse(
    (response) =>
      response.url().endsWith("/graphql") &&
      (response.request().postData() ?? "").includes("query Compile")
  );
  await page.getByTestId("write-repository").click();
  await expect(page.getByTestId("written")).toBeVisible();
  await refetched;
  await expect(page.getByTestId("written")).toBeVisible();
  shelfkit([
    "--shelf",
    fetchShelf(SHELF),
    "compile",
    "minimal",
    "--repo",
    disk,
  ]);
  expect(
    await browserDirectoryExists(page, name, "vendor/minimal/.apm/prompts")
  ).toBe(true);

  // The profile changes elsewhere: the prompt goes, a library comes in.
  await saveProfileAsOwner(request, SHELF, {
    bundles: [],
    compile: { pin: "latest" },
    extends: [],
    id: "minimal",
    items: ["drizzle"],
    title: "Minimal",
  });
  await expect(page.getByTestId("compile-apm-yml")).toBeVisible();
  await expect(
    page.getByText("vendor/minimal/.apm/instructions/drizzle.instructions.md", {
      exact: true,
    })
  ).toBeAttached();

  // Second compile, from the browser and from the CLI.
  await page.getByTestId("open-repository").click();
  await expect(page.getByTestId("output-plan")).toContainText(
    "1 old file to remove"
  );
  await page.getByTestId("write-repository").click();
  await expect(page.getByTestId("written")).toBeVisible();
  shelfkit([
    "--shelf",
    fetchShelf(SHELF),
    "compile",
    "minimal",
    "--repo",
    disk,
  ]);

  expect(await browserRepository(page, name)).toStrictEqual(sortedTree(disk));
  expect(
    await browserDirectoryExists(page, name, "vendor/minimal/.apm/prompts")
  ).toBe(false);
});

test("a browser that cannot open a folder is told the downloaded manifest needs its vendored files", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // A browser without the File System Access API.
    Reflect.deleteProperty(window, "showDirectoryPicker");
  });
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/full`);
  await expect(
    page.getByRole("button", { name: "Download apm.yml" })
  ).toBeVisible();
  await expect(page.getByTestId("download-incomplete")).toContainText(
    "./vendor/full"
  );
  await expect(page.getByTestId("download-incomplete")).toContainText(
    "apm install fails without them"
  );
});
