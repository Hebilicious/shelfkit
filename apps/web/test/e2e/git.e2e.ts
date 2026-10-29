/**
 * A hosted shelf through Git, the one way a checkout's files reach it: a clone pushes to it and pulls an edit made in
 * the UI back, and a shelf inside a larger repository is a submodule of its repository, pushed to from there. Local
 * mode runs these repositories on Miniflare's local Artifacts simulator, as Artifacts serves a deployment's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BASE_URL,
  FIXTURES,
  OWNER_KEY,
  expect,
  git,
  indexedAt,
  seedShelf,
  temporary,
  test,
} from "./support.ts";

const CLONED = "git-e2e";
const NESTED = "submodule-e2e";
const PROMPT = "items/prompts/pr-description/prompt.md";

test.beforeAll(async () => {
  await seedShelf(FIXTURES.allKinds, CLONED);
  await seedShelf(FIXTURES.allKinds, NESTED);
});

test("a clone pushes an edit, and pulls back one made in the UI", async ({
  request,
}) => {
  const parent = temporary("clone");
  git(parent, ["clone", "--quiet", `${BASE_URL}/git/${CLONED}.git`, "shelf"]);
  const clone = path.join(parent, "shelf");
  writeFileSync(path.join(clone, PROMPT), "Describe the change.\n");
  git(clone, ["commit", "--quiet", "--all", "--message", "A shorter prompt"]);
  git(clone, ["push", "--quiet", "origin", "main"]);
  await indexedAt(CLONED, git(clone, ["rev-parse", "HEAD"]).trim());

  const edited = await request.post(`${BASE_URL}/graphql`, {
    data: {
      query: `mutation { updatePrompt(shelf: "${CLONED}", id: "pr-description", body: "Describe the change, briefly.\\n") { ok } }`,
    },
    headers: { authorization: `Bearer ${OWNER_KEY}` },
  });
  await expect(edited.json()).resolves.toStrictEqual({
    data: { updatePrompt: { ok: true } },
  });
  git(clone, ["pull", "--quiet", "--ff-only"]);
  expect(readFileSync(path.join(clone, PROMPT), "utf-8")).toBe(
    "Describe the change, briefly.\n"
  );
});

test("a shelf inside a larger repository is a submodule of its repository, pushed to from there", async () => {
  const project = temporary("project");
  git(project, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(path.join(project, "README.md"), "# A project\n");
  git(project, [
    "submodule",
    "add",
    "--quiet",
    `${BASE_URL}/git/${NESTED}.git`,
    "shelf",
  ]);
  git(project, ["add", "--all"]);
  git(project, ["commit", "--quiet", "--message", "The shelf, as a submodule"]);

  const shelf = path.join(project, "shelf");
  writeFileSync(path.join(shelf, PROMPT), "From the project.\n");
  git(shelf, [
    "commit",
    "--quiet",
    "--all",
    "--message",
    "Edited in the project",
  ]);
  git(shelf, ["push", "--quiet", "origin", "HEAD:main"]);
  const head = git(shelf, ["rev-parse", "HEAD"]).trim();
  await indexedAt(NESTED, head);

  git(project, [
    "commit",
    "--quiet",
    "--all",
    "--message",
    "The shelf, updated",
  ]);
  expect(git(project, ["ls-tree", "HEAD", "shelf"])).toBe(
    `160000 commit ${head}\tshelf\n`
  );
});
