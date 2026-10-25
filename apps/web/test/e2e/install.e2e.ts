/**
 * Installing a profile (`screens/compile.vue`): the page hands out a prompt for an agent and terminal steps, with the
 * ShelfKit CLI or with APM alone. Both ways' terminal steps are run here as a person would paste them, with the pinned
 * APM through uvx, against this Worker's registry, and must leave the profile's prompt where Claude Code reads it.
 * The CLI's steps start by installing the CLI from a GitHub release; that line is skipped here, and the CLI built from
 * this checkout is the one on PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BASE_URL,
  BINARY,
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

test("the prompt for an agent installs the CLI, then the profile from this deployment", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  await expect(
    page.getByRole("heading", { name: "Install Minimal" })
  ).toBeVisible();
  await page.getByTestId("copy-install").click();
  const prompt = await clipboard(page);
  expect(prompt).toContain(`${BASE_URL}/install.sh`);
  expect(prompt).toContain(
    `shelfkit install ${SHELF}/minimal --url ${BASE_URL}`
  );
  await expect(page.getByTestId("install-places")).toContainText(
    ".claude/commands/pr-description.md"
  );
});

test("the prompt for APM alone names this registry, the profile, and the steps", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  await page.getByTestId("install-apm-toggle").click();
  await page.getByTestId("copy-install-apm").click();
  const prompt = await clipboard(page);
  expect(prompt).toContain(`${BASE_URL}/apm`);
  expect(prompt).toContain(`id: ${SHELF}/minimal`);
  expect(prompt).toContain("apm experimental enable registries");
  expect(prompt).toContain("apm install");
});

/** Run pasted steps in a fresh `my-app` folder, with a scratch HOME so APM's configuration stays out of the real one. */
function runSteps(name: string, steps: string): string {
  const root = temporary(name);
  const repository = path.join(root, "my-app");
  const home = path.join(root, "home");
  mkdirSync(repository);
  mkdirSync(home);
  writeFileSync(path.join(root, "steps.sh"), steps);
  const ran = spawnSync("bash", ["-e", path.join(root, "steps.sh")], {
    cwd: repository,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.dirname(BINARY)}${path.delimiter}${process.env.PATH ?? ""}`,
      SHELFKIT_KEY: "",
      XDG_CONFIG_HOME: path.join(home, ".config"),
    },
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
  return repository;
}

test("the CLI's terminal steps install the profile", async ({ page }) => {
  test.skip(
    process.env.SHELFKIT_TEST_APM_UVX === undefined,
    "runs APM through uvx: set SHELFKIT_TEST_APM_UVX=1"
  );
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  await page.getByTestId("install-cli-terminal").click();
  const steps = (await page.getByTestId("install-text").textContent()) ?? "";
  expect(steps).toContain(`curl -fsSL ${BASE_URL}/install.sh | sh`);
  runSteps(
    "install-cli",
    steps
      .split("\n")
      .filter((line) => !line.includes("/install."))
      .join("\n")
  );
});

test("the terminal steps with APM alone install the profile with stock APM", async ({
  page,
}) => {
  test.skip(
    process.env.SHELFKIT_TEST_APM_UVX === undefined,
    "runs APM through uvx: set SHELFKIT_TEST_APM_UVX=1"
  );
  await signIn(page);
  await page.goto(`/shelves/${SHELF}/compile/minimal`);
  await page.getByTestId("install-apm-toggle").click();
  await page.getByTestId("install-apm-terminal").click();
  runSteps(
    "install-apm",
    (await page.getByTestId("install-text-apm").textContent()) ?? ""
  );
});
