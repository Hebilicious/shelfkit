/**
 * M3's exit criterion (`docs/PRD.md` section 12), using only the browser: someone who has never used the CLI finds a
 * prompt, copies it with its variables filled in, then composes a profile and copies the prompt that has their agent
 * install it. `install.e2e.ts` runs the install itself with APM.
 */

import {
  FIXTURES,
  clipboard,
  profileRevision,
  reportActivityAsOwner,
  seedShelf,
  signIn,
  expect,
  test,
} from "./support.ts";

const SHELF = "m3-e2e";
const REPOSITORY_NAME = "my-repo";

test.beforeAll(async () => {
  await seedShelf(FIXTURES.allKinds, SHELF);
});

test("finds a prompt, copies it filled in, composes a profile and copies how to install it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}`);

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

  // 3. Install it: the prompt an agent follows names this registry and the new profile.
  await page.locator("body").press("g");
  await page.locator("body").press("k");
  await page.getByTestId("compile-profile").selectOption("my-app");
  await expect(
    page.getByRole("heading", { name: "Install My app" })
  ).toBeVisible();
  await page.getByTestId("copy-install").click();
  await expect
    .poll(async () => await clipboard(page))
    .toContain(`shelfkit install ${SHELF}/my-app --url`);

  // 4. The agent reports the install, and Repositories shows which repository runs which profile.
  await reportActivityAsOwner(page.request, {
    apmYmlDigest: `sha256:${"0".repeat(64)}`,
    outcome: "applied",
    profile: "my-app",
    profileRevision: await profileRevision(page.request, SHELF, "my-app"),
    repository: REPOSITORY_NAME,
    shelf: SHELF,
  });
  await page.locator("body").press("g");
  await page.locator("body").press("a");
  await expect(page.getByTestId("activity")).toContainText(REPOSITORY_NAME);
  await expect(page.getByTestId("activity")).toContainText("my-app");
});
