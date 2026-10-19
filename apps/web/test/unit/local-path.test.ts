import { describe, expect, it } from "vitest";

import { localPath } from "../../src/lib/local-path.ts";

const ORIGIN = "https://shelfkit.example";

describe("the path to return to after signing in", () => {
  it("refuses every way of naming another origin", () => {
    const hostile = [
      "/\t/evil.example",
      "/\r/evil.example",
      "/\n/evil.example",
      "/\\evil.example",
      "\\/evil.example",
      "//evil.example/x",
      "/\\/evil.example",
      " //evil.example",
      "https://evil.example",
      "http:evil.example",
      ["javascript", "alert(1)"].join(":"),
      "/auth/github/start",
    ];
    expect(hostile.map((next) => localPath(next, ORIGIN))).toStrictEqual(
      hostile.map(() => "/")
    );
  });

  it("keeps a local path with its query and fragment, and an encoded // as a path", () => {
    expect([
      localPath("/shelves/acme/prompts?tag=git#top", ORIGIN),
      localPath("/%2F%2Fevil.example", ORIGIN),
      localPath(undefined, ORIGIN),
    ]).toStrictEqual([
      "/shelves/acme/prompts?tag=git#top",
      "/%2F%2Fevil.example",
      "/",
    ]);
  });
});
