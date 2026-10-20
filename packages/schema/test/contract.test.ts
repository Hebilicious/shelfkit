import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { catalogOf, defineCapability } from "@acid-cat/core-ts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  capabilities,
  CompilePlanSchema,
  shelfReport,
  shelfSearch,
} from "../src/capabilities.ts";
import { catalogApp } from "../src/catalog.ts";
import { toCatalogJsonSchema } from "../src/json-schema.ts";
import {
  ItemIdSchema,
  ItemRefSchema,
  ItemSchema,
  NoticeSchema,
  ProfileSchema,
  ResolvedProfileSchema,
} from "../src/shelf.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const coreTests = path.join(repository, "crates/core/tests");
const compilerGolden = path.join(repository, "crates/compiler/tests/golden");

/** Every `item.json` under a shelf's `items/`. */
function itemFiles(shelf: string): string[] {
  const items = path.join(shelf, "items");
  return readdirSync(items, { encoding: "utf-8", recursive: true })
    .filter((file) => file.endsWith(`${path.sep}item.json`))
    .map((file) => path.join(items, file))
    .toSorted();
}

// BOUNDARY: JSON read from disk is unknown until the schema under test parses it.
function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf-8"));
}

/** An AcidCat capability id: two or more dot-separated kebab segments, at most 128 characters. */
const ACIDCAT_ID =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;

describe("the capability ids", () => {
  it("are AcidCat ids, so they can never contain the `__` a relayed tool uses", () => {
    for (const capability of capabilities) {
      expect(capability.id).toMatch(ACIDCAT_ID);
      expect(capability.id.length).toBeLessThanOrEqual(128);
      expect(capability.id).not.toContain("_");
    }
  });

  it("are the six the contract freezes", () => {
    expect(capabilities.map((capability) => capability.id)).toStrictEqual([
      "shelf.search",
      "shelf.recommend",
      "shelf.profile.get",
      "shelf.item.get",
      "shelf.compile.plan",
      "shelf.report",
    ]);
  });
});

describe("the descriptors", () => {
  it("read, except shelf.report", () => {
    const writers = capabilities
      .filter((capability) => !capability.readOnly)
      .map((capability) => capability.id);
    expect(writers).toStrictEqual(["shelf.report"]);
  });

  it("name the shelf in every input", () => {
    for (const capability of capabilities) {
      expect(Object.keys(capability.input.entries)).toContain("shelf");
    }
  });

  it("tag every failure with its own key", () => {
    const document = catalogOf(catalogApp, {
      toJsonSchema: toCatalogJsonSchema,
    });
    for (const capability of Object.values(document.capabilities)) {
      for (const [tag, schema] of Object.entries(capability.failures ?? {})) {
        expect(schema).toMatchObject({ properties: { _tag: { const: tag } } });
        expect(schema.required).toContain("_tag");
      }
    }
  });

  it("are accepted by @acid-cat/core-ts and keep their read-only hints in the catalog", () => {
    const search = defineCapability({
      ...shelfSearch,
      run: () => ({
        ok: true as const,
        value: { items: [], truncated: false },
      }),
    });
    expect(search.id).toBe("shelf.search");

    const document = catalogOf(catalogApp, {
      toJsonSchema: toCatalogJsonSchema,
    });
    expect(document.capabilities["shelf.search"]?.readOnly).toBeTruthy();
    expect(document.capabilities[shelfReport.id]?.readOnly).toBeUndefined();
    expect(Object.keys(document.targets)).toStrictEqual(["mcp"]);
  });
});

describe("the Rust model and these schemas agree", () => {
  it("on every item of the all-kinds fixture and of ShelfKit's own shelf", () => {
    const files = [
      ...itemFiles(path.join(coreTests, "fixtures/all-kinds")),
      ...itemFiles(path.join(repository, "shelf")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(16);
    for (const file of files) {
      const { issues } = v.safeParse(ItemSchema, readJson(file));
      expect({ file, issues }).toStrictEqual({ file, issues: undefined });
    }
  });

  it("on refusing an unknown key", () => {
    const typo = readJson(
      path.join(coreTests, "fixtures/errors/items/libraries/typo/item.json")
    );
    expect(v.safeParse(ItemSchema, typo).success).toBeFalsy();
  });

  it("on the resolved profiles and notices the Rust golden file records", () => {
    const golden = v.parse(
      v.object({
        check: v.array(NoticeSchema),
        declared: v.record(v.string(), ProfileSchema),
        profiles: v.record(v.string(), ResolvedProfileSchema),
      }),
      readJson(path.join(coreTests, "golden/all-kinds.json"))
    );
    expect(Object.keys(golden.profiles)).toStrictEqual([
      "base",
      "full",
      "minimal",
    ]);
  });

  it("on how long an id may be, pinned or not", () => {
    const pin = `@sha256-${"0".repeat(64)}`;
    for (const [ref, valid] of [
      ["a".repeat(64), true],
      [`${"a".repeat(64)}${pin}`, true],
      ["a".repeat(65), false],
      [`${"a".repeat(65)}${pin}`, false],
    ] as const) {
      expect({
        ref,
        valid: v.safeParse(ItemRefSchema, ref).success,
      }).toStrictEqual({ ref, valid });
    }
  });

  it("on what an item id is", () => {
    expect(v.safeParse(ItemIdSchema, "pr-description").success).toBeTruthy();
    for (const id of ["a__b", "a_b", "Pr", "-a", "a--b", "a".repeat(65)]) {
      expect({
        id,
        valid: v.safeParse(ItemIdSchema, id).success,
      }).toStrictEqual({ id, valid: false });
    }
  });
});

describe("the compile plan", () => {
  it("is the CompiledManifest with camelCase fields", () => {
    const plan = {
      apmYml: "name: full-stack\nversion: 0.0.0\n",
      apmYmlDigest: `sha256:${"a".repeat(64)}`,
      files: [
        {
          contents: "Write a PR description.\n",
          path: "vendor/full-stack/.apm/prompts/pr-description.prompt.md",
        },
      ],
      installCommand: "apm install",
      notes: [
        {
          code: "hook-approval",
          message: "Approve the hook format-on-save.",
          path: "profiles/full.json",
        },
      ],
      profile: "full",
      profileRevision: `sha256-${"b".repeat(64)}`,
    };
    expect(v.parse(CompilePlanSchema, plan)).toStrictEqual(plan);
    expect(
      v.safeParse(CompilePlanSchema, { ...plan, apm_yml: plan.apmYml }).success
    ).toBeFalsy();
  });
});

describe("the compiler's golden plans", () => {
  it("each parse with CompilePlanSchema, as the Rust CompiledManifest serializes them", () => {
    const plans = readdirSync(compilerGolden, {
      encoding: "utf-8",
      recursive: true,
    })
      .filter((file) => file.endsWith(".plan.json"))
      .toSorted();
    expect(plans.length).toBeGreaterThanOrEqual(6);
    for (const file of plans) {
      const { issues } = v.safeParse(
        CompilePlanSchema,
        readJson(path.join(compilerGolden, file))
      );
      expect({ file, issues }).toStrictEqual({ file, issues: undefined });
    }
  });
});
