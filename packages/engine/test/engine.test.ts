import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

import { CompilePlanSchema } from "@shelfkit/schema";
import * as v from "valibot";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../src/index.ts";
import { loadEngine, readShelf } from "../src/node.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const binary = path.join(
  repository,
  "target/debug",
  process.platform === "win32" ? "shelfkit.exe" : "shelfkit"
);

/** Every fixture shelf, and ShelfKit's own. */
const shelves = {
  "all-kinds": path.join(repository, "crates/core/tests/fixtures/all-kinds"),
  registry: path.join(repository, "crates/compiler/tests/fixtures/registry"),
  shelfkit: path.join(repository, "shelf"),
};

function profilesOf(root: string): string[] {
  return readdirSync(path.join(root, "profiles"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .toSorted();
}

function dryRun(root: string, profile: string): string {
  return execFileSync(
    binary,
    ["--shelf", root, "compile", "--dry-run", "--json", profile],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

/** Every profile of every shelf, as `[shelf, root, profile]`. */
const cases = Object.entries(shelves).flatMap(([name, root]) =>
  profilesOf(root).map((profile) => [name, root, profile] as const)
);

describe("the engine and `shelfkit compile --dry-run --json`", () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await loadEngine();
  });

  it.each(cases)(
    "plans %s (%s) %s to the same bytes",
    async (_name, root, profile) => {
      const result = engine.planCompile(await readShelf(root), { profile });
      if (!result.ok) {
        throw new Error(
          result.errors
            .map((error) => `${error.path}: ${error.message}`)
            .join("\n")
        );
      }
      expect(result.text).toBe(dryRun(root, profile));
      expect(v.parse(CompilePlanSchema, JSON.parse(result.text))).toStrictEqual(
        result.plan
      );
    }
  );
});

describe("the engine", () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await loadEngine();
  });

  it("compiles an unsaved profile, validated as the file it replaces", async () => {
    const files = await readShelf(shelves["all-kinds"]);
    const draft = {
      bundles: [],
      compile: { targets: ["claude"] },
      extends: [],
      id: "minimal",
      items: ["api-architect"],
      title: "Draft",
    };
    const result = engine.planCompile(files, { overrideProfile: draft });
    expect(result.ok).toBeTruthy();
    expect(result.ok && result.plan.apmYml).toBe(
      'name: minimal\nversion: "0.0.0"\ntargets:\n  - claude\ndependencies:\n  apm:\n    - ./vendor/minimal\n'
    );

    const broken = engine.planCompile(files, {
      overrideProfile: { ...draft, items: ["ghost"] },
    });
    expect(broken).toStrictEqual({
      errors: [
        {
          message: "`items` references unknown item `ghost`",
          path: "profiles/minimal.json",
        },
      ],
      ok: false,
    });
  });

  it("reports a shelf that does not load, each error in its file", async () => {
    const result = engine.planCompile(
      await readShelf(
        path.join(repository, "crates/core/tests/fixtures/errors")
      ),
      {
        profile: "a",
      }
    );
    expect(result.ok).toBeFalsy();
    expect(
      !result.ok &&
        result.errors.some(
          (error) => error.path === "items/libraries/typo/item.json"
        )
    ).toBeTruthy();
  });

  it("carries binary files through as base64", async () => {
    const result = engine.planCompile(await readShelf(shelves.registry), {
      profile: "team",
    });
    const logo = result.ok
      ? result.plan.files.find((file) => file.path.endsWith("logo.png"))
      : undefined;
    expect(logo?.encoding).toBe("base64");
  });
});
