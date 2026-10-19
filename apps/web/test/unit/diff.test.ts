import { describe, expect, it } from "vitest";

import { diffLines, diffStat } from "../../src/lib/diff.ts";

describe("line diffs", () => {
  it("marks kept, removed, and added lines in reading order", () => {
    const diff = diffLines("a\nb\nc\n", "a\nc\nd\n");
    expect(diff.map((line) => `${line.kind[0]} ${line.text}`)).toStrictEqual([
      "s a",
      "r b",
      "s c",
      "a d",
    ]);
    expect(diffStat(diff)).toStrictEqual({ added: 1, removed: 1 });
  });

  it("treats CRLF and LF as the same line ending", () => {
    expect(diffStat(diffLines("a\r\nb\r\n", "a\nb\n"))).toStrictEqual({
      added: 0,
      removed: 0,
    });
  });

  it("diffs from and to nothing", () => {
    expect(diffLines("", "x\n")).toStrictEqual([
      { after: 1, kind: "added", text: "x" },
    ]);
    expect(diffLines("x", "")).toStrictEqual([
      { before: 1, kind: "removed", text: "x" },
    ]);
  });
});
