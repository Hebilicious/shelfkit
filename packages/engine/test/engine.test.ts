import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CompilePlanSchema } from "@shelfkit/schema";
import * as v from "valibot";
import { beforeAll, describe, expect, it } from "vitest";

import { createEngine } from "../src/index.ts";
import type { Engine } from "../src/index.ts";
import { WASM_PATH, loadEngine, readShelf } from "../src/node.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const binary = path.join(
  repository,
  "target/debug",
  process.platform === "win32" ? "shelfkit.exe" : "shelfkit"
);

/** Every fixture shelf, and ShelfKit's own. */
const shelves = {
  "all-kinds": path.join(repository, "crates/core/tests/fixtures/all-kinds"),
  edges: path.join(repository, "crates/compiler/tests/fixtures/edges"),
  registry: path.join(repository, "crates/compiler/tests/fixtures/registry"),
  shelfkit: path.join(repository, "shelf"),
};

// BOUNDARY: a raw instance's exports are untyped until this guard has checked the two the test calls.
function hasInputAndPlan(
  exports: WebAssembly.Exports
): exports is WebAssembly.Exports & {
  readonly shelfkit_input: (length: number) => number;
  readonly shelfkit_plan: () => number;
} {
  return (
    typeof exports.shelfkit_input === "function" &&
    typeof exports.shelfkit_plan === "function"
  );
}

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
      version: "0.1.0",
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

const LsSchema = v.array(v.object({ id: v.string(), revision: v.string() }));

const ShowSchema = v.object({ resolution: v.unknown() });

describe("the engine's inventory, resolution, and recommendations", () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await loadEngine();
  });

  it.each(Object.entries(shelves))(
    "index %s with the revisions `shelfkit ls` reports",
    async (_name, root) => {
      const result = engine.inventory(await readShelf(root));
      if (!result.ok) {
        throw new Error(JSON.stringify(result.errors));
      }
      const listed = v.parse(
        LsSchema,
        JSON.parse(
          execFileSync(binary, ["--shelf", root, "ls", "--json"], {
            encoding: "utf-8",
          })
        )
      );
      expect(
        result.value.items.map((entry) => ({
          id: entry.item.id,
          revision: entry.revision,
        }))
      ).toStrictEqual(
        listed.map((row) => ({ id: row.id, revision: row.revision }))
      );
      expect(
        result.value.profiles.map((entry) => entry.profile.id)
      ).toStrictEqual(profilesOf(root));
    }
  );

  it.each(cases)(
    "resolves %s (%s) %s as `shelfkit show --json` does",
    async (_name, root, profile) => {
      const result = engine.resolve(await readShelf(root), { profile });
      const shown = v.parse(
        ShowSchema,
        JSON.parse(
          execFileSync(binary, ["--shelf", root, "show", "--json", profile], {
            encoding: "utf-8",
          })
        )
      );
      expect(result).toStrictEqual({ ok: true, value: shown.resolution });
    }
  );

  it("recommends from markers as `shelfkit recommend` does", async () => {
    const result = engine.recommend(await readShelf(shelves["all-kinds"]), {
      dependencies: ["vue"],
      files: ["wrangler.jsonc"],
      packageManager: "pnpm@11.8.0",
    });
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    expect(result.value.items.map((item) => item.id)).toStrictEqual([
      "context7",
      "drizzle",
      "vue-cloudflare",
      "vue-sfc-patterns",
    ]);
  });

  it("reports a shelf that does not load instead of indexing it", () => {
    const result = engine.inventory([{ contents: "{", path: "shelf.json" }]);
    expect(result.ok ? [] : result.errors.map((error) => error.path)).toContain(
      "shelf.json"
    );
  });
});

describe("the engine after a trap", () => {
  it("throws for the call that trapped and plans again on a fresh instance", async () => {
    const module = await WebAssembly.compile(readFileSync(WASM_PATH));
    let made = 0;
    const engine = await createEngine(module, (wasm) => {
      made += 1;
      const instance = new WebAssembly.Instance(wasm, {});
      if (made > 1) {
        return instance;
      }
      // The first instance traps on its first plan, as one out of memory would.
      return {
        exports: {
          ...instance.exports,
          shelfkit_plan: () => {
            throw new WebAssembly.RuntimeError("unreachable");
          },
        },
      };
    });
    const files = await readShelf(shelves.shelfkit);
    expect(() => engine.planCompile(files)).toThrow(/trapped/u);
    expect(made).toBe(2);
    expect(engine.planCompile(files).ok).toBeTruthy();
  });

  it("refuses an input the module cannot hold, and plans on the same instance after", async () => {
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(readFileSync(WASM_PATH)),
      {}
    );
    const { exports } = instance;
    if (!hasInputAndPlan(exports)) {
      throw new TypeError("not the engine module");
    }
    expect(exports.shelfkit_input(0xff_ff_ff_ff)).toBe(0);
    // The module is still usable: an empty request is answered, not trapped on.
    expect(exports.shelfkit_input(2)).not.toBe(0);
    expect(() => exports.shelfkit_plan()).not.toThrow();
  });
});

describe("readShelf and the native loader", () => {
  it("fail a shelf with a symbolic link with the same error", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "shelfkit-engine-"));
    cpSync(shelves.shelfkit, root, { recursive: true });
    symlinkSync(
      path.join(root, "items/prompts/commit-style/prompt.md"),
      path.join(root, "items/prompts/commit-style/link.md")
    );
    const engine = await loadEngine();
    const result = engine.planCompile(await readShelf(root));
    const native = spawnSync(
      binary,
      ["--shelf", root, "compile", "--dry-run", "--json"],
      {
        encoding: "utf-8",
      }
    );
    expect(native.status).toBe(1);
    expect(result.ok).toBeFalsy();
    const lines = result.ok
      ? []
      : result.errors.map((error) => `${error.path}: ${error.message}`);
    expect(lines).toStrictEqual([
      "items/prompts/commit-style/link.md: invalid path: symbolic links are not allowed in a shelf",
    ]);
    expect(native.stderr.startsWith(`${lines.join("\n")}\n`)).toBeTruthy();
  });

  it("keep a byte-order mark", async () => {
    const files = await readShelf(shelves.edges);
    const agent = files.find(
      (file) => file.path === "items/agents/bom-agent/agent.md"
    );
    expect(
      agent !== undefined && "contents" in agent && agent.contents.slice(0, 1)
    ).toBe("\uFEFF");
  });
});
