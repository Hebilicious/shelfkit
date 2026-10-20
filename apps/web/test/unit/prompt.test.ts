import { describe, expect, it } from "vitest";

import {
  asCommand,
  asSkill,
  copyText,
  filledText,
  missingRequired,
  placeholders,
  splitFrontmatter,
} from "../../src/lib/prompt.ts";
import type { PromptSource } from "../../src/lib/prompt.ts";

const review: PromptSource = {
  body: "Write a pull request description for the staged diff.\n\nAudience: {{audience}}\nTicket: {{ticket}} {{other}}\n",
  description: "Describe a change for its reviewers.",
  id: "pr-description",
  title: "PR description",
  variables: [
    { name: "ticket", required: true },
    { default: "reviewers", name: "audience" },
  ],
};

const withFrontmatter: PromptSource = {
  body: '---\ndescription: Write a conventional commit message.\nargument-hint: "[scope]"\n---\n\nScope: {{scope}}\n',
  description: "",
  id: "commit-style",
  title: "Commit message",
  variables: [{ name: "scope" }],
};

describe("filling a prompt's variables", () => {
  it("uses what was typed, then the default, and leaves undeclared placeholders alone", () => {
    const text = filledText(review, new Map([["ticket", "SK-7"]]));
    expect(text).toBe(
      "Write a pull request description for the staged diff.\n\nAudience: reviewers\nTicket: SK-7 {{other}}\n"
    );
  });

  it("drops the prompt's own frontmatter from the copied text", () => {
    expect(filledText(withFrontmatter, new Map([["scope", "web"]]))).toBe(
      "Scope: web\n"
    );
  });

  it("names the required variables still empty", () => {
    expect(missingRequired(review.variables, new Map())).toStrictEqual([
      "ticket",
    ]);
    expect(
      missingRequired(review.variables, new Map([["ticket", " "]]))
    ).toStrictEqual(["ticket"]);
    expect(
      missingRequired(review.variables, new Map([["ticket", "SK-1"]]))
    ).toStrictEqual([]);
  });

  it("finds the placeholders a body uses, once each, in order", () => {
    expect(placeholders("{{b}} {{a}} {{b}} {{ not }} {{1x}}")).toStrictEqual([
      "b",
      "a",
    ]);
  });
});

describe("copying for a harness", () => {
  it("copies as a SKILL.md with name and description frontmatter and the values filled in", () => {
    expect(asSkill(review, new Map([["ticket", "SK-7"]]))).toBe(
      "---\nname: pr-description\ndescription: Describe a change for its reviewers.\n---\n\n" +
        "Write a pull request description for the staged diff.\n\nAudience: reviewers\nTicket: SK-7 {{other}}\n"
    );
  });

  it("copies as a slash command whose variables are positional arguments", () => {
    expect(asCommand(review)).toBe(
      '---\ndescription: Describe a change for its reviewers.\nargument-hint: "<ticket> [audience]"\n---\n\n' +
        "Write a pull request description for the staged diff.\n\nAudience: $2\nTicket: $1 {{other}}\n"
    );
  });

  it("keeps a prompt's own frontmatter when copying it as a command", () => {
    expect(asCommand(withFrontmatter)).toBe(
      '---\ndescription: Write a conventional commit message.\nargument-hint: "[scope]"\n---\n\nScope: $1\n'
    );
  });

  it("quotes a description YAML would misread", () => {
    const tricky = { ...review, description: "Review: the #1 checklist" };
    expect(copyText(tricky, "skill", new Map())).toContain(
      'description: "Review: the #1 checklist"\n'
    );
  });
});

describe("frontmatter", () => {
  it("splits as the compiler does, and needs both fences", () => {
    expect(splitFrontmatter("---\na: b\n---\nrest")).toStrictEqual({
      rest: "rest",
      yaml: "a: b",
    });
    expect(splitFrontmatter("---\na: b\n---")).toStrictEqual({
      rest: "",
      yaml: "a: b",
    });
    expect(splitFrontmatter("no\n---\n")).toBeNull();
  });
});
