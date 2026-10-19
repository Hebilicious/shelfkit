/**
 * Settings and sharing: a key is shown once and revoked on a second click, registry visibility is undoable, a share
 * link renders the profile read-only to a browser that is not signed in, and the owner grants and removes another
 * GitHub account's access.
 */

import {
  FIXTURES,
  dryRun,
  makePrivate,
  seedShelf,
  signIn,
  expect,
  test,
} from "./support.ts";

const SHELF = "settings-e2e";
/** A private shelf, so a GitHub account reads it only while the owner grants it access. */
const PRIVATE = "people-e2e";
let seeded = "";

test.beforeAll(() => {
  seeded = seedShelf(FIXTURES.allKinds, SHELF);
  seedShelf(FIXTURES.allKinds, PRIVATE, makePrivate);
});

test("creates a key that is shown once, and revokes it after a second click", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/settings`);
  const form = page.getByRole("form", { name: "New key" });
  await form.getByLabel("New key's name").fill("laptop CLI");
  await form.getByLabel("Read the shelf").check();
  await form.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByTestId("new-key")).toHaveText(
    new RegExp(`^sks_${SHELF}_[A-Za-z0-9_-]{43}$`, "u")
  );
  await page.getByRole("button", { name: "Done" }).first().click();
  await expect(page.getByTestId("new-key")).toHaveCount(0);

  const row = page.getByRole("row").filter({ hasText: "laptop CLI" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Revoke: sure?" }).click();
  await expect(row.getByText("revoked")).toBeVisible();
});

test("makes the registry private, and undoes it", async ({ page }) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/settings`);
  await page.getByTestId("toggle-visibility").click();
  await expect(page.getByText("The registry is private")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("The registry is public")).toBeVisible();
});

test("a share link shows the profile read-only to a browser with no key", async ({
  browser,
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/settings`);
  await page.locator("#share-profile").selectOption("minimal");
  await page.getByTestId("create-share").click();
  const url = (await page.getByTestId("share-url").textContent()) ?? "";
  expect(url).toMatch(new RegExp(`/share/shs_${SHELF}_`, "u"));

  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  await visitor.goto(url);
  await expect(visitor.getByTestId("shared-title")).toHaveText("Minimal");
  const plan: unknown = JSON.parse(dryRun(seeded, "minimal"));
  expect(plan).toMatchObject({
    apmYml: await visitor.getByTestId("shared-apm-yml").textContent(),
  });
  await expect(
    visitor.getByRole("button", { name: "Save profile" })
  ).toHaveCount(0);
  await anonymous.close();
});

test("the owner grants a second GitHub account access, and removing it ends that access at its next request", async ({
  browser,
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${PRIVATE}/settings`);
  const grant = page.getByRole("form", { name: "Grant access" });
  await grant.getByLabel("GitHub account").fill("@ada");
  await grant.getByLabel("Read the shelf").check();
  await grant.getByRole("button", { name: "Grant access" }).click();
  const row = page
    .getByTestId("grants")
    .getByRole("row")
    .filter({ hasText: "@ada" });
  await expect(row).toContainText("read");

  const other = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const ada = await other.newPage();
  await signIn(ada, "ada");
  await ada.goto(`/shelves/${PRIVATE}/prompts/pr-description`);
  await expect(ada.getByTestId("prompt-title")).toHaveText("PR description");
  // Read access is not ownership: no keys, no people, but an account of its own.
  await ada.goto(`/shelves/${PRIVATE}/settings`);
  await expect(ada.getByTestId("account")).toHaveText("Signed in as @ada");
  await expect(ada.getByRole("heading", { name: "Keys" })).toHaveCount(0);

  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove: sure?" }).click();
  await expect(row).toHaveCount(0);

  await ada.goto(`/shelves/${PRIVATE}/prompts/pr-description`);
  await expect(ada.getByText("You cannot read it as @ada")).toBeVisible();
  await other.close();
});
