/**
 * Live updates over server-sent events (`docs/PRD.md` section 10.2): a dropped subscription comes back by itself, and
 * what changed while it was down is fetched when it does; one the server refuses is not asked for again.
 */

import {
  FIXTURES,
  makePrivate,
  seedShelf,
  signIn,
  writePromptAsOwner,
  expect,
  test,
} from "./support.ts";

const SHELF = "live-e2e";
const PRIVATE = "live-private-e2e";

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF);
  seedShelf(FIXTURES.allKinds, PRIVATE, makePrivate);
});

test("a private shelf's page holds still for a signed-out browser, and asks the server nothing more", async ({
  page,
}) => {
  let reads = 0;
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/graphql") {
      reads += 1;
    }
  });
  await page.goto(`/shelves/${PRIVATE}`);
  const missing = page.getByRole("heading", { name: `No shelf ${PRIVATE}` });
  await expect(missing).toBeVisible();
  // The subscription is refused; resubscribing used to reload the page every second, blinking it.
  const settled = reads;
  await page.waitForTimeout(3500);
  expect(reads).toBe(settled);
  await expect(missing).toBeVisible();
});

test("reconnects after the subscription fails, and catches up on what changed meanwhile", async ({
  page,
  request,
}) => {
  await signIn(page);

  // The subscription answers 503 until the outage ends.
  let outage = true;
  await page.route(
    (url) =>
      url.pathname === "/graphql" &&
      url.searchParams.get("query")?.includes("shelfChanged") === true,
    async (route) => {
      await (outage
        ? route.fulfill({ body: "unavailable", status: 503 })
        : route.continue());
    }
  );

  await page.goto(`/shelves/${SHELF}/prompts`);
  const list = page.getByTestId("prompt-list");
  await expect(list).toContainText("PR description");
  await expect(page.getByTestId("live")).not.toContainText("live");

  // A change made while the subscription is down: no event can announce it.
  await writePromptAsOwner(request, SHELF, {
    body: "Summarize the incident.\n",
    id: "made-during-the-outage",
    title: "Made during the outage",
  });
  await expect(list).not.toContainText("Made during the outage");

  outage = false;
  await expect(page.getByTestId("live")).toContainText("live", {
    timeout: 15_000,
  });
  await expect(list).toContainText("Made during the outage");
});
