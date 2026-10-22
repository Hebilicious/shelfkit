/**
 * Signing in by default: a one-time link opens the owner's account, a passkey added there signs the browser back in,
 * and a signed-in browser makes a link that opens another device. No key is ever typed into a browser, and there is
 * no GitHub button unless the deployment enables it (`github.e2e.ts`).
 */
import {
  FIXTURES,
  enrollWithLink,
  expect,
  makePrivate,
  ownerSignInLink,
  passkeyDevice,
  seedShelf,
  signIn,
  test,
} from "./support.ts";

const SHELF = "sign-in-e2e";

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF, makePrivate);
});

test("the owner's enrollment link adds a passkey, which then signs in from a private shelf's page and returns to it", async ({
  page,
}) => {
  await passkeyDevice(page);
  await enrollWithLink(page, await ownerSignInLink(page.request), "Owner");
  // The token left the address bar as soon as the page read it.
  await expect(page).not.toHaveURL(/#/u);
  await page.getByRole("button", { name: "Sign out" }).click();

  await page.goto(`/shelves/${SHELF}/prompts`);
  await expect(
    page.getByRole("heading", { name: `No shelf ${SHELF}` })
  ).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).last().click();
  await expect(page.locator("input")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in with GitHub" })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();

  await expect(page).toHaveURL(new RegExp(`/shelves/${SHELF}/prompts$`, "u"));
  await expect(page.getByTestId("viewer")).toHaveText("Owner");
  await expect(page.getByRole("heading", { name: "Prompts" })).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find(
    (cookie) => cookie.name === "__Host-shelfkit_session"
  );
  expect(session).toMatchObject({
    httpOnly: true,
    sameSite: "Strict",
    secure: true,
  });
});

test("an enrollment link works once", async ({ browser, page }) => {
  await passkeyDevice(page);
  const link = await ownerSignInLink(page.request);
  await enrollWithLink(page, link, "Owner");
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await stranger.goto(link);
  await expect(stranger.getByRole("alert")).toContainText("already used");
  await expect(stranger.getByTestId("viewer")).toHaveCount(0);
});

test("a signed-in browser makes a link that opens another device, which adds its own passkey", async ({
  browser,
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/settings`);
  const passkeys = page.getByTestId("passkeys").getByRole("row");
  // The header row, and at least the passkey this browser signed in with.
  await expect(passkeys.nth(1)).toBeVisible();
  const before = await passkeys.count();
  await page.getByTestId("another-device").click();
  const link = (await page.getByTestId("sign-in-link").textContent()) ?? "";
  expect(link).toMatch(/\/link#ssl_owner_/u);

  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await passkeyDevice(phone);
  await enrollWithLink(phone, link, "Owner");
  await phone.goto(`/shelves/${SHELF}/prompts`);
  await expect(phone.getByRole("heading", { name: "Prompts" })).toBeVisible();

  await page.reload();
  await expect(passkeys).toHaveCount(before + 1);
});

test("the last passkey is removed only after saying what that means", async ({
  browser,
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/settings`);
  const form = page.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Their name").fill("Cy");
  await form.getByLabel("Read the shelf").check();
  await form.getByRole("button", { name: "Create invite" }).click();
  const url = (await page.getByTestId("invite-url").textContent()) ?? "";

  const cyContext = await browser.newContext();
  const cy = await cyContext.newPage();
  await passkeyDevice(cy);
  await enrollWithLink(cy, url, "Cy");
  await cy.goto(`/shelves/${SHELF}/settings`);
  const rows = cy.getByTestId("passkeys").getByRole("row");
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole("button", { name: "Remove" }).click();
  await rows
    .nth(1)
    .getByRole("button", { name: "Remove the last one: sure?" })
    .click();
  await expect(
    cy.getByText("To sign in again, open a sign-in link.")
  ).toBeVisible();
});
