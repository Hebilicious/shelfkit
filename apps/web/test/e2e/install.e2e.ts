/**
 * Installing a profile (`screens/compile.vue`): the page hands out a prompt for an agent, terminal steps, and the
 * ShelfKit CLI's steps. The terminal steps are run here as a person would paste them, with the pinned APM through
 * uvx, against this Worker's registry, and must leave the profile's prompt where Claude Code reads it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BASE_URL,
  FIXTURES,
  clipboard,
  seedShelf,
  signIn,
  temporary,
  expect,
  test,
} from "./support.ts";

const SHELF = "install-e2e";

test.beforeAll(() => {
  seedShelf(FIXTURES.allKinds, SHELF);
});

test("the prompt for an agent names this registry, the profile, and the steps", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  await expect(
    page.getByRole("heading", { name: "Install Minimal" })
  ).toBeVisible();
  await page.getByTestId("copy-install").click();
  const prompt = await clipboard(page);
  expect(prompt).toContain(`${BASE_URL}/apm`);
  expect(prompt).toContain(`id: ${SHELF}/minimal`);
  expect(prompt).toContain("apm experimental enable registries");
  expect(prompt).toContain("apm install");
  await expect(page.getByTestId("install-places")).toContainText(
    ".claude/commands/pr-description.md"
  );
});

test("the terminal steps install the profile with stock APM", async ({
  page,
}) => {
  test.skip(
    process.env.SHELFKIT_TEST_APM_UVX === undefined,
    "runs APM through uvx: set SHELFKIT_TEST_APM_UVX=1"
  );
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  await page.getByTestId("install-terminal").click();
  const steps = (await page.getByTestId("install-text").textContent()) ?? "";

  const root = temporary("install-terminal");
  const repository = path.join(root, "my-app");
  const home = path.join(root, "home");
  mkdirSync(repository);
  mkdirSync(home);
  writeFileSync(path.join(root, "steps.sh"), steps);
  const ran = spawnSync("bash", ["-e", path.join(root, "steps.sh")], {
    cwd: repository,
    encoding: "utf-8",
    // A scratch HOME, so APM's experimental flag and config stay out of the real one.
    env: { ...process.env, HOME: home },
    timeout: 300_000,
  });
  expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  expect(readFileSync(path.join(repository, "apm.yml"), "utf-8")).toContain(
    "name: my-app"
  );
  expect(existsSync(path.join(repository, "apm.lock.yaml"))).toBe(true);
  expect(
    existsSync(path.join(repository, ".claude/commands/pr-description.md"))
  ).toBe(true);
});
