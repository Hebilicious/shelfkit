import { describe, expect, it } from "vitest";

import { search, searchWords } from "../../src/lib/search.ts";

const items = [
  {
    body: "Prefer `db.query` over `db.select`.",
    description: "Schema-first ORM.",
    id: "drizzle",
    tags: ["db"],
    title: "Drizzle ORM",
  },
  {
    body: "Write a conventional commit for the staged diff.",
    description: "Commit message",
    id: "commit-style",
    tags: ["git"],
    title: "Commit message",
  },
  {
    body: "Runtime: Workers. Database: D1 with Drizzle migrations.",
    description: "How we build",
    id: "vue-cloudflare",
    tags: ["vue"],
    title: "Vue on Cloudflare",
  },
];

describe("searching items in memory", () => {
  it("returns every item in its order when there is no word", () => {
    expect(search(items, "  ").map((match) => match.item.id)).toStrictEqual([
      "drizzle",
      "commit-style",
      "vue-cloudflare",
    ]);
  });

  it("ranks a title match above a body match", () => {
    expect(
      search(items, "drizzle").map((match) => match.item.id)
    ).toStrictEqual(["drizzle", "vue-cloudflare"]);
  });

  it("requires every word, each at the start of a word", () => {
    expect(
      search(items, "commit staged").map((match) => match.item.id)
    ).toStrictEqual(["commit-style"]);
    expect(search(items, "ommit")).toStrictEqual([]);
  });

  it("matches tags and ignores case and accents", () => {
    expect(search(items, "GIT").map((match) => match.item.id)).toStrictEqual([
      "commit-style",
    ]);
    expect(search(items, "dríz").map((match) => match.item.id)).toStrictEqual([
      "drizzle",
      "vue-cloudflare",
    ]);
  });

  it("gives a snippet only when the words are in the body alone", () => {
    const [title, body] = search(items, "drizzle");
    expect(title?.snippet).toBeNull();
    expect(body?.snippet).toContain("Drizzle migrations");
  });

  it("reads punctuation as no word", () => {
    expect(searchWords('"(" ')).toStrictEqual([]);
  });
});
