/**
 * Signing the CLI in through the browser, against the real Worker: a login started as `shelfkit login` starts one,
 * its approval page sent through sign-in and back, approved or denied there, and the key the poll hands over used by
 * the CLI built from this checkout. The CLI's own side (showing the code, opening the page, polling, keeping the key in
 * the OS keychain) is `crates/compiler/tests/hosted.rs`: this run must not write to the machine's keychain.
 */
import { execFileSync } from "node:child_process";

import type { APIRequestContext } from "@playwright/test";
import * as v from "valibot";

import {
  BASE_URL,
  BINARY,
  FIXTURES,
  expect,
  makePrivate,
  ownerSignInLink,
  seedShelf,
  temporary,
  test,
} from "./support.ts";

const SHELF = "cli-login-e2e";

const StartedSchema = v.object({
  deviceCode: v.string(),
  userCode: v.string(),
  verificationUrl: v.string(),
});

const PolledSchema = v.object({
  key: v.optional(v.string()),
  status: v.string(),
});

/** What `shelfkit login` posts first. */
async function startLogin(request: APIRequestContext, device: string) {
  const response = await request.post(`${BASE_URL}/auth/cli/start`, {
    data: { device },
  });
  return v.parse(StartedSchema, await response.json());
}

/** What `shelfkit login` posts until it is answered. */
async function poll(request: APIRequestContext, deviceCode: string) {
  const response = await request.post(`${BASE_URL}/auth/cli/poll`, {
    data: { deviceCode },
  });
  return v.parse(PolledSchema, await response.json());
}

/** A sign-in link for the owner that goes on to `next`, as `shelfkit open <url>/<path>` makes one. */
async function linkTo(request: APIRequestContext, next: string) {
  const link = await ownerSignInLink(request);
  const [base = "", token = ""] = link.split("#");
  return `${base}?next=${encodeURIComponent(next)}#${token}`;
}

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF, makePrivate);
});

test("a CLI login is approved in a browser that signs in first, and its key works for the CLI until revoked", async ({
  page,
}) => {
  const login = await startLogin(page.request, "e2e-laptop");
  const approval = new URL(login.verificationUrl);
  expect(approval.pathname).toBe(`/cli/${login.userCode}`);

  // Not signed in: the page sends the browser through sign-in, which comes back to it.
  await page.goto(approval.pathname);
  await expect(page.getByTestId("cli-sign-in")).toBeVisible();
  await page.goto(await linkTo(page.request, approval.pathname));
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page).toHaveURL(new RegExp(`/cli/${login.userCode}$`, "u"));
  await expect(page.getByTestId("cli-code")).toHaveText(login.userCode);
  await expect(page.getByTestId("cli-device")).toContainText("e2e-laptop");
  await expect(page.getByRole("note")).toContainText(
    "Approve only if your own terminal shows this code"
  );
  await expect(poll(page.request, login.deviceCode)).resolves.toStrictEqual({
    status: "pending",
  });

  await page.getByTestId("cli-approve").click();
  await expect(page.getByTestId("cli-approved")).toContainText(
    "CLI on e2e-laptop"
  );
  const approved = await poll(page.request, login.deviceCode);
  const key = approved.key ?? "";
  expect({
    key: key.startsWith("skc_owner_"),
    status: approved.status,
  }).toStrictEqual({
    key: true,
    status: "approved",
  });
  // Handed over once.
  await expect(poll(page.request, login.deviceCode)).resolves.toStrictEqual({
    status: "expired",
  });

  // The CLI reads the private shelf with it.
  const listed = execFileSync(
    BINARY,
    ["fetch", "--id", SHELF, "--out", temporary("cli-login")],
    {
      encoding: "utf-8",
      env: { ...process.env, SHELFKIT_KEY: key, SHELFKIT_URL: BASE_URL },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  expect(listed).not.toContain(key);

  // The account lists it, and revoking it signs that CLI out.
  await page.goto(`/shelves/${SHELF}/settings`);
  const row = page
    .getByTestId("cli-keys")
    .getByRole("row", { name: /CLI on e2e-laptop/u });
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Revoke: sure?" }).click();
  await expect(page.getByTestId("cli-keys")).toHaveCount(0);
  const viewer = await page.request.post(`${BASE_URL}/graphql`, {
    data: { query: "{ viewer { authenticated } }" },
    headers: { authorization: `Bearer ${key}` },
  });
  expect(viewer.status()).toBe(401);
});

test("a CLI login denied in the browser leaves the CLI with nothing", async ({
  page,
}) => {
  await page.goto(await linkTo(page.request, "/"));
  await page.getByRole("button", { name: "Not now" }).click();
  const login = await startLogin(page.request, "someone else's machine");
  await page.goto(`/cli/${login.userCode.toLowerCase()}`);
  await expect(page.getByTestId("cli-device")).toContainText(
    "someone else's machine"
  );
  await page.getByTestId("cli-deny").click();
  await expect(page.getByTestId("cli-denied")).toBeVisible();
  await expect(poll(page.request, login.deviceCode)).resolves.toStrictEqual({
    status: "denied",
  });
  await page.reload();
  await expect(page.getByTestId("cli-not-waiting")).toBeVisible();
});
