/**
 * Editing an item.json as a person would (`src/shelf/json-edit.ts`): the members whose value changed, and every other
 * byte where it was, so an edit in the UI reads as that edit in the shelf's Git history.
 */
import { describe, expect, it } from "vitest";

import { editJsonObject } from "../src/shelf/json-edit.ts";

/** An item.json as a person formats it: their key order, one-line values, and a default the engine drops. */
const WRITTEN = `{
  "id": "commit-style",
  "kind": "prompt",
  "title": "Commit message",
  "description": "Write a conventional commit for the staged changes.",
  "asCommand": true,
  "variables": [{ "name": "scope", "required": false }],
  "tags": ["git"]
}
`;

/** The same document as the engine reads it: keys reordered, the default dropped. */
const READ = {
  asCommand: true,
  description: "Write a conventional commit for the staged changes.",
  id: "commit-style",
  kind: "prompt",
  tags: ["git"],
  title: "Commit message",
  variables: [{ name: "scope" }],
};

describe("editing an item.json", () => {
  it("leaves the file as it is when nothing changed", () => {
    expect(editJsonObject(WRITTEN, READ, { ...READ })).toBe(WRITTEN);
  });

  it("rewrites only the member that changed", () => {
    expect(editJsonObject(WRITTEN, READ, { ...READ, title: "Commit" })).toBe(
      WRITTEN.replace('"title": "Commit message"', '"title": "Commit"')
    );
  });

  it("keeps a one-line value on one line", () => {
    expect(
      editJsonObject(WRITTEN, READ, { ...READ, tags: ["git", "review"] })
    ).toBe(WRITTEN.replace('"tags": ["git"]', '"tags": ["git", "review"]'));
  });

  it("removes a member, in the middle or last", () => {
    const { asCommand: _middle, ...withoutMiddle } = READ;
    expect(editJsonObject(WRITTEN, READ, withoutMiddle)).toBe(
      WRITTEN.replace('  "asCommand": true,\n', "")
    );
    const { tags: _last, ...withoutLast } = READ;
    expect(editJsonObject(WRITTEN, READ, withoutLast)).toBe(
      WRITTEN.replace(',\n  "tags": ["git"]', "")
    );
  });

  it("adds a member after the last one, indented as its neighbours", () => {
    expect(editJsonObject(WRITTEN, READ, { ...READ, license: "MIT" })).toBe(
      WRITTEN.replace(
        '  "tags": ["git"]\n',
        '  "tags": ["git"],\n  "license": "MIT"\n'
      )
    );
  });

  it("declines a file that is not an object", () => {
    expect(editJsonObject("[1, 2]", READ, READ)).toBeNull();
  });
});
