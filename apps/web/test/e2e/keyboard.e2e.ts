/** The keyboard map: `/` focuses search, `g` then `p` goes to profiles, `j` and `k` move in lists. */
import { expect, test } from "@playwright/test";

import { FIXTURES, seedShelf, signIn } from "./support.ts";

const SHELF = "keys-e2e";

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF);
});

test("moves through the shelf and its lists from the keyboard", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}`);
  await expect(page.getByTestId("inventory")).toContainText("PR description");

  await page.locator("body").press("/");
  await expect(page.getByLabel("Search the shelf")).toBeFocused();
  await page.keyboard.press("Escape");

  const current = page.locator('[data-list-row][aria-current="true"]');
  await page.locator("body").press("j");
  await expect(current).toHaveCount(1);
  const first = (await current.textContent()) ?? "";
  await page.locator("body").press("j");
  await expect(current).not.toHaveText(first);
  await page.locator("body").press("k");
  await expect(current).toHaveText(first);

  await page.locator("body").press("x");
  await expect(page.getByText("1 selected")).toBeVisible();

  await page.locator("body").press("g");
  await page.locator("body").press("p");
  await expect(page).toHaveURL((url) =>
    url.pathname.endsWith(`/shelves/${SHELF}/profiles`)
  );
  await expect(page.getByTestId("profile-list")).toContainText("Minimal");
  await page.locator("body").press("j");
  await expect(
    page.locator('[data-list-row][aria-current="true"]')
  ).toHaveCount(1);
  await page.locator("body").press("Enter");
  await expect(page).toHaveURL((url) =>
    url.pathname.includes(`/shelves/${SHELF}/compose/`)
  );

  await page.locator("body").press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
});
