/**
 * Settings and sharing: a key is shown once and revoked on a second click, registry visibility is undoable, and a
 * share link renders the profile read-only to a browser that holds no key.
 */
import { expect, test } from "@playwright/test";

import { FIXTURES, dryRun, seedShelf, signIn } from "./support.ts";

const SHELF = "settings-e2e";
let seeded = "";

test.beforeAll(() => {
  seeded = seedShelf(FIXTURES.allKinds, SHELF);
});

test("creates a key that is shown once, and revokes it after a second click", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/settings`);
  await page.getByLabel("New key's name").fill("laptop CLI");
  await page.getByLabel("Read the shelf").check();
  await page.getByRole("button", { name: "Create key" }).click();
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
