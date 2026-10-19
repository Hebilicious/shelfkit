/**
 * The importer seam's contract: what the Worker's jobs rely on from any adapter issue #8 adds, checked against the
 * schemas, so it holds however many adapters there are.
 */
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  adapterFor,
  CandidateSchema,
  ImportedItemSchema,
  ImportSourceSchema,
  ScanVerdictSchema,
  UpstreamStateSchema,
} from "../src/index.ts";
import type { SourceAdapter } from "../src/index.ts";

const git: SourceAdapter = {
  checkUpstream: async () => await Promise.resolve({ status: "current" }),
  discover: async () => await Promise.resolve({ candidates: [], warnings: [] }),
  fetch: async () => await Promise.reject(new Error("unused")),
  kind: "git",
};

describe("the importer seam", () => {
  it("finds an adapter by the kind of source, and none for a kind with no adapter", () => {
    expect(adapterFor("git", [git])).toBe(git);
    expect(adapterFor("catalog", [git])).toBeUndefined();
  });

  it("names a source's credential by a secret name, never a value", () => {
    expect(
      v.is(ImportSourceSchema, {
        kind: "git",
        repo: "https://github.com/acme/private",
        secret: "GITHUB_TOKEN",
      })
    ).toBeTruthy();
    expect(
      v.is(ImportSourceSchema, { kind: "git", secret: "ghp_0123456789abcdef" })
    ).toBeFalsy();
  });

  it("requires a candidate to say whether it is link-only, and to carry its pin", () => {
    const candidate = {
      id: "review",
      key: "prompts/review.prompt.md",
      kind: "prompt",
      linkOnly: true,
      title: "Review",
      upstream: { resolvedCommit: "a".repeat(40) },
    };
    expect(v.is(CandidateSchema, candidate)).toBeTruthy();
    const { linkOnly: _linkOnly, ...missing } = candidate;
    expect(v.is(CandidateSchema, missing)).toBeFalsy();
  });

  it("refuses an imported item whose item.json is not one", () => {
    const parsed = v.safeParse(ImportedItemSchema, {
      files: [],
      item: { id: "Bad Id", kind: "prompt", title: "x" },
      warnings: [],
    });
    expect(parsed.success).toBeFalsy();
  });

  it("keeps drift and verdicts to their closed vocabularies", () => {
    expect(
      v.is(UpstreamStateSchema, {
        latest: { version: "2.0.0" },
        status: "moved",
      })
    ).toBeTruthy();
    expect(v.is(UpstreamStateSchema, { status: "stale" })).toBeFalsy();
    expect(
      v.is(ScanVerdictSchema, { scanner: "s", verdict: "clean" })
    ).toBeTruthy();
    expect(
      v.is(ScanVerdictSchema, { scanner: "s", verdict: "safe" })
    ).toBeFalsy();
  });
});
