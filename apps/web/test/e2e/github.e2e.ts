/**
 * Signing in with GitHub, on a deployment that enables it (`moon run worker:setup -- --github-sign-in`): the `github`
 * project runs these against a second Worker whose GitHub is a stand-in (`fake-github-server.ts`). "Sign in with
 * GitHub" goes to GitHub and comes back signed in, to where it started.
 */
import { FAKE_GITHUB_WEB } from "./github.ts";
import { GITHUB_BASE_URL } from "./ports.ts";
import { FIXTURES, expect, makePrivate, seedShelf, test } from "./support.ts";

const SHELF = "github-e2e";

test.beforeAll(async () => {
  await seedShelf(FIXTURES.allKinds, SHELF, makePrivate, GITHUB_BASE_URL);
});

test("a private shelf's page sends the browser through GitHub and back to it, signed in as the owner", async ({
  page,
}) => {
  await page.goto(`/shelves/${SHELF}/prompts`);
  await expect(
    page.getByRole("heading", { name: `No shelf ${SHELF}` })
  ).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).last().click();

  await expect(page.locator("input")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page).toHaveURL(
    new RegExp(`^${FAKE_GITHUB_WEB}/login/oauth/authorize\\?`, "u")
  );
  await page.getByRole("link", { name: "Authorize as @shelf-owner" }).click();

  await expect(page).toHaveURL(new RegExp(`/shelves/${SHELF}/prompts$`, "u"));
  await expect(page.getByTestId("viewer")).toHaveText("@shelf-owner");
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

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("viewer")).toHaveCount(0);
});

test("refusing at GitHub comes back signed out, and says why", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "GitHub did not authorize ShelfKit, so you are not signed in."
  );
  await expect(page.getByTestId("viewer")).toHaveCount(0);
});

test("an account the owner has granted nothing is signed in, and told it has no shelf yet", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Authorize as @grace" }).click();
  await expect(page.getByTestId("viewer")).toHaveText("@grace");
  await expect(page.getByTestId("no-access")).toContainText(
    "@grace has no access to a shelf here yet"
  );
});
