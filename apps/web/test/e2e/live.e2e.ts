/**
 * Live updates over server-sent events (`docs/PRD.md` section 10.2): a dropped subscription comes back by itself, and
 * what changed while it was down is fetched when it does.
 */
import { expect, test } from "@playwright/test";

import { FIXTURES, seedShelf, signIn, writePromptAsOwner } from "./support.ts";

const SHELF = "live-e2e";

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF);
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
