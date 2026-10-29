/**
 * A published profile through Git: each profile the registry publishes is a repository of its own,
 * `/git/{shelf}/{profile}.git`, each version a tag holding exactly its archive's files, which APM installs with a
 * version range and no experimental flag. Nobody pushes to it.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";

import {
  BASE_URL,
  FIXTURES,
  expect,
  git,
  seedShelf,
  temporary,
  test,
} from "./support.ts";

const SHELF = "packages-e2e";

test.beforeAll(async () => {
  await seedShelf(FIXTURES.allKinds, SHELF);
});

/** Every file under `root` but `.git`, by path, with its bytes. */
function filesUnder(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, full);
    if (entry.isFile() && !relative.split(path.sep).includes(".git")) {
      files.set(relative, readFileSync(full, "base64"));
    }
  }
  return new Map([...files].toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

test("a published profile is a repository of its own: each version a tag, holding its archive's files", async ({
  request,
}) => {
  const listed = await request.get(
    `${BASE_URL}/apm/v1/packages/${SHELF}/minimal/versions`
  );
  expect(listed.status()).toBe(200);
  const [published] = v.parse(
    v.object({ versions: v.array(v.object({ version: v.string() })) }),
    await listed.json()
  ).versions;
  const version = published?.version ?? "";
  const remote = `${BASE_URL}/git/${SHELF}/minimal.git`;
  const parent = temporary("package");
  expect(git(parent, ["ls-remote", remote])).toContain(`refs/tags/v${version}`);

  git(parent, [
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--branch",
    `v${version}`,
    remote,
    "package",
  ]);
  const archive = await request.get(
    `${BASE_URL}/apm/v1/packages/${SHELF}/minimal/versions/${encodeURIComponent(version)}/download`
  );
  expect(archive.status()).toBe(200);
  const unpacked = temporary("archive");
  writeFileSync(path.join(unpacked, "package.tar.gz"), await archive.body());
  execFileSync("tar", ["-xzf", "package.tar.gz"], { cwd: unpacked });
  const fromArchive = filesUnder(unpacked);
  fromArchive.delete("package.tar.gz");
  expect(filesUnder(path.join(parent, "package"))).toStrictEqual(fromArchive);
  expect(fromArchive.has("apm.yml")).toBe(true);

  // Published by `shelfkit publish`, never pushed to.
  expect(() =>
    git(path.join(parent, "package"), [
      "push",
      "--quiet",
      "origin",
      "HEAD:main",
    ])
  ).toThrow(/403/u);
});
