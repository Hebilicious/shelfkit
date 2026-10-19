import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The composer (`docs/PRD.md` section 9.2): its live `apm.yml` preview and `shelfkit compile --dry-run` produce identical
 * output for the same profile, because both run the same Rust compiler. The preview is compiled in the browser by the
 * WASM engine on the shelf's files plus the unsaved profile.
 */
import type { Page } from "@playwright/test";

import {
  FIXTURES,
  dryRun,
  fetchShelf,
  seedShelf,
  signIn,
  expect,
  test,
} from "./support.ts";

const SHELF = "compose-e2e";
let seeded = "";

test.beforeAll(() => {
  seeded = seedShelf(FIXTURES.allKinds, SHELF);
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** The preview once the browser has compiled the current draft. */
async function settledPreview(
  page: Page
): Promise<{ apmYml: string; planJson: string }> {
  // `data-state` is `current` only when the preview shown was compiled from the draft as it is now.
  await expect(page.getByTestId("preview-runner")).toHaveAttribute(
    "data-state",
    "current"
  );
  await expect(page.getByTestId("preview-runner")).toHaveText(
    "compiled in your browser"
  );
  const planJson = (await page.getByTestId("plan-json").textContent()) ?? "";
  const apmYml = (await page.getByTestId("apm-yml").textContent()) ?? "";
  return { apmYml, planJson };
}

test("the preview of an unsaved profile is what shelfkit compile --dry-run prints for it", async ({
  page,
}) => {
  await page.goto(`/shelves/${SHELF}`);

  // Bulk-select from the inventory into a new profile: `j` moves, `x` selects, and checkboxes work too.
  await page.getByLabel("Select PR description").check();
  await page.getByLabel("Select Drizzle ORM").check();
  await page.getByTestId("add-to-profile").click();
  await expect(page).toHaveURL((url) =>
    url.pathname.includes(`/shelves/${SHELF}/compose`)
  );

  await page.locator('input[name="title"]').fill("Web stack");
  await expect(page.locator('input[name="id"]')).toHaveValue("web-stack");
  await page.getByTestId("add-review-checklist").click();
  await page
    .getByRole("group", { exact: true, name: "Targets" })
    .getByRole("button", { name: "claude" })
    .click();
  await page
    .getByRole("group", { exact: true, name: "Targets" })
    .getByRole("button", { name: "cursor" })
    .click();

  // The rail resolves the draft: every item, with the bundle's skill pulled in by nothing else.
  const resolved = page.getByTestId("resolved");
  await expect(resolved).toContainText("pr-description");
  await expect(resolved).toContainText("drizzle");
  await expect(resolved).toContainText("review-checklist");
  await expect(page.getByTestId("conflicts")).toBeVisible();

  await page.getByRole("tab", { name: "Plan JSON" }).click();
  const unsaved = await settledPreview(page);
  await expect(page.getByTestId("dirty")).toBeVisible();

  // Save it, download the shelf as the CLI would, and compile the same profile natively.
  await page.getByTestId("save-profile").click();
  await expect(page).toHaveURL((url) =>
    url.pathname.endsWith(`/compose/web-stack`)
  );
  await expect(page.getByTestId("dirty")).toHaveCount(0);
  const cli = dryRun(fetchShelf(SHELF), "web-stack");

  expect(unsaved.planJson).toBe(cli);
  const parsed: unknown = JSON.parse(cli);
  expect(parsed).toMatchObject({
    apmYml: unsaved.apmYml,
    profile: "web-stack",
  });
});

test("an existing profile with extends and bundles previews byte for byte as the CLI compiles it, live", async ({
  page,
}) => {
  await page.goto(`/shelves/${SHELF}/compose/minimal`);
  await page.getByRole("tab", { name: "Plan JSON" }).click();
  const before = await settledPreview(page);
  expect(before.planJson).toBe(dryRun(seeded, "minimal"));

  await page.goto(`/shelves/${SHELF}/compose/full`);
  await page.getByRole("tab", { name: "Plan JSON" }).click();
  const full = await settledPreview(page);
  expect(full.planJson).toBe(dryRun(seeded, "full"));

  // Removing an item changes the preview at once; undo brings the same bytes back.
  await page.getByRole("button", { name: "Remove playwright" }).click();
  await expect(page.getByTestId("plan-json")).not.toHaveText(full.planJson);
  await expect(page.getByTestId("resolved")).not.toContainText("playwright");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("plan-json")).toHaveText(full.planJson);
});

test("the stack-marker tester reports which stacks a package.json matches", async ({
  page,
}) => {
  await page.goto(`/shelves/${SHELF}/compose/full`);
  await page
    .getByLabel("package.json")
    .fill(
      '{ "packageManager": "pnpm@11.8.0", "dependencies": { "vue": "^3.5.0", "wrangler": "^4.0.0" } }'
    );
  await page
    .getByLabel("Other files at the root")
    .fill("wrangler.jsonc, vite.config.ts");
  await page.getByRole("button", { name: "Test markers" }).click();
  await expect(page.getByTestId("stack-match")).toContainText("vue-cloudflare");
});

test("an edit marks the preview as updating until the draft is compiled again", async ({
  page,
}) => {
  await page.goto(`/shelves/${SHELF}/compose/minimal`);
  await settledPreview(page);
  await page.getByTestId("add-drizzle").click();
  // At once, before the debounce runs the compile: the old preview is never shown as current.
  await expect(page.getByTestId("preview-runner")).toHaveText("updating…");
  await expect(page.getByTestId("preview-runner")).not.toHaveAttribute(
    "data-state",
    "current"
  );
  await page.getByRole("tab", { name: "Plan JSON" }).click();
  const after = await settledPreview(page);
  expect(after.planJson).toContain(
    '"vendor/minimal/.apm/instructions/drizzle.instructions.md"'
  );
});

test("a prompt.md that starts with a byte-order mark previews as the CLI compiles it", async ({
  page,
}) => {
  const shelf = "bom-e2e";
  const root = seedShelf(FIXTURES.allKinds, shelf, (copy) => {
    const prompt = path.join(copy, "items/prompts/pr-description/prompt.md");
    writeFileSync(prompt, `\uFEFF${readFileSync(prompt, "utf-8")}`);
  });
  await page.goto(`/shelves/${shelf}/compose/minimal`);
  await page.getByRole("tab", { name: "Plan JSON" }).click();
  const preview = await settledPreview(page);
  expect(preview.planJson).toBe(dryRun(root, "minimal"));
});
