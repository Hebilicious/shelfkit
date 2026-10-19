import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  adapterFor,
  adapters,
  ImportedItemSchema,
  scanners,
} from "../src/index.ts";
import type { SourceAdapter } from "../src/index.ts";

describe("the importer seam", () => {
  it("has no adapter or scanner until issue #8 adds them", () => {
    expect(adapters).toStrictEqual([]);
    expect(scanners).toStrictEqual([]);
    expect(adapterFor("git")).toBeUndefined();
  });

  it("finds an adapter by the kind of source", () => {
    const git: SourceAdapter = {
      // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
      checkUpstream: () => Promise.resolve({ status: "current" }),
      // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
      discover: () => Promise.resolve({ candidates: [], warnings: [] }),
      // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
      fetch: () => Promise.reject(new Error("unused")),
      kind: "git",
    };
    expect(adapterFor("git", [git])).toBe(git);
    expect(adapterFor("catalog", [git])).toBeUndefined();
  });

  it("refuses an imported item whose item.json is not one", () => {
    const parsed = v.safeParse(ImportedItemSchema, {
      files: [],
      item: { id: "Bad Id", kind: "prompt", title: "x" },
      warnings: [],
    });
    expect(parsed.success).toBeFalsy();
  });
});
