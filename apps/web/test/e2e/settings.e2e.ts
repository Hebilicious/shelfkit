/**
 * Settings and sharing: a key is shown once and revoked on a second click, registry visibility is undoable, a share
 * link renders the profile read-only to a browser that is not signed in, and the owner invites people, who sign in
 * with passkeys of their own, and removes them.
 */

import type { BrowserContext, Page } from "@playwright/test";

import {
  FIXTURES,
  dryRun,
  enrollWithLink,
  makePrivate,
  passkeyDevice,
  seedShelf,
  signIn,
  signInWithPasskey,
  expect,
  test,
} from "./support.ts";

const SHELF = "settings-e2e";
/** A private shelf, so an invited person reads it only while the owner grants them access. */
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

/** The owner invites `name` to read the private shelf in Settings, and they accept in their own browser. */
async function invited(
  owner: Page,
  context: BrowserContext,
  name: string
): Promise<Page> {
  await owner.goto(`/shelves/${PRIVATE}/settings`);
  const form = owner.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Their name").fill(name);
  await form.getByLabel("Read the shelf").check();
  await form.getByRole("button", { name: "Create invite" }).click();
  const url = (await owner.getByTestId("invite-url").textContent()) ?? "";
  expect(url).toMatch(new RegExp(`/link#ssi_${PRIVATE}_`, "u"));
  const ada = await context.newPage();
  await passkeyDevice(ada);
  await enrollWithLink(ada, url, name);
  return ada;
}

test("an invited person signs in with their own passkey, reads the shelf, and loses it when the owner removes access", async ({
  browser,
  page,
}) => {
  await signIn(page);
  const other = await browser.newContext();
  const ada = await invited(page, other, "Ada");
  await ada.getByRole("button", { name: "Sign out" }).click();
  await signInWithPasskey(ada, "Ada");
  await ada.goto(`/shelves/${PRIVATE}/prompts/pr-description`);
  await expect(ada.getByTestId("prompt-title")).toHaveText("PR description");
  // Read access is not ownership: no keys and no people, but an account and passkeys of her own.
  await ada.goto(`/shelves/${PRIVATE}/settings`);
  await expect(ada.getByTestId("account")).toHaveText("Signed in as Ada");
  await expect(ada.getByTestId("passkeys").getByRole("row")).toHaveCount(2);
  await expect(
    ada.getByRole("heading", { exact: true, name: "Keys" })
  ).toHaveCount(0);

  await page.reload();
  const row = page
    .getByTestId("grants")
    .getByRole("row")
    .filter({ hasText: "Ada" });
  await row.getByRole("button", { name: "Remove access" }).click();
  await row.getByRole("button", { name: "Remove access: sure?" }).click();
  await expect(row).toHaveCount(0);

  await ada.goto(`/shelves/${PRIVATE}/prompts/pr-description`);
  await expect(ada.getByText("You cannot read it as Ada")).toBeVisible();
  await other.close();
});

test("removing a person signs them out, and their passkey no longer signs in", async ({
  browser,
  page,
}) => {
  await signIn(page);
  const other = await browser.newContext();
  const ada = await invited(page, other, "Bea");
  await page.reload();
  const row = page
    .getByTestId("grants")
    .getByRole("row")
    .filter({ hasText: "Bea" });
  await row.getByRole("button", { name: "Remove the person" }).click();
  await row.getByRole("button", { name: "Remove the person: sure?" }).click();
  await expect(row).toHaveCount(0);

  await ada.reload();
  await expect(ada.getByTestId("viewer")).toHaveCount(0);
  await ada.goto("/sign-in");
  await ada.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(ada.getByRole("alert")).toContainText("belongs to no account");
  await other.close();
});

test("an invite is listed until it is used, and a used invite does not open again", async ({
  browser,
  page,
}) => {
  await signIn(page);
  const other = await browser.newContext();
  await page.goto(`/shelves/${PRIVATE}/settings`);
  const form = page.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Their name").fill("Grace");
  await form.getByLabel("Read the shelf").check();
  await form.getByRole("button", { name: "Create invite" }).click();
  const url = (await page.getByTestId("invite-url").textContent()) ?? "";
  await expect(page.getByTestId("invites")).toContainText("Grace");
  const grace = await other.newPage();
  await passkeyDevice(grace);
  await enrollWithLink(grace, url, "Grace");
  const lateContext = await browser.newContext();
  const late = await lateContext.newPage();
  await late.goto(url);
  await expect(late.getByRole("alert")).toContainText("already used");
  await other.close();
});
