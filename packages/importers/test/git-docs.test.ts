/**
 * Docs through the git adapter, on hand-written repositories (`fake-github.ts`): a root AGENTS.md offered as
 * instructions with the docs it links to, a single markdown file offered as a doc, and the licence deciding copy or
 * link for both.
 */
import { describe, expect, it } from "vitest";

import { gitAdapter } from "../src/adapters/git.ts";
import { markdownLinks, resolveLink } from "../src/docs.ts";
import { requireLinked } from "../src/index.ts";
import type { Candidate, ImportSource } from "../src/index.ts";
import { fakeGitHub } from "./fake-github.ts";
import type { Commits } from "./fake-github.ts";
import { contextOf } from "./recording.ts";

const MIT = `MIT License

Copyright (c) 2026 Acme

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

const AGENTS = `# Acme conventions

Read [the domain](docs/domain.md#terms) before naming anything, and [the guide](./docs/guide.md "Guide").
Deploys follow [the ops guide][ops]. [Missing](docs/missing.md), [elsewhere](https://example.com/docs/guide.md),
[setup](#setup), [Claude](CLAUDE.md), and [a prompt](prompts/review.prompt.md) are no docs of this repository.

\`\`\`md
[fenced](docs/fenced.md)
\`\`\`

[ops]: ops/guide.md
`;

/** A repository whose AGENTS.md links to three docs, one of which links to a fourth (which links back). */
const FILES = {
  "AGENTS.md": AGENTS,
  "CLAUDE.md": "AGENTS.md",
  "GLOSSARY.md": "# Glossary\n\nThe words of [the domain](docs/domain.md).\n",
  "docs/domain.md": "# Domain\n\nSee [the glossary](../GLOSSARY.md).\n",
  "docs/fenced.md": "# Fenced\n",
  "docs/guide.md":
    "---\ndescription: How to work here.\n---\n\n# Working guide\n\nShip small.\n",
  "ops/guide.md": "Deploy on Tuesdays.\n",
  "prompts/review.prompt.md": "Review the change.\n",
} as const;

/** The repository at its one commit, `c1`, with an MIT licence or with none. */
function repository(licensed: boolean): Commits {
  return { c1: licensed ? { ...FILES, LICENSE: MIT } : FILES };
}

const source: ImportSource = {
  kind: "git",
  repo: "https://github.com/acme/kit",
};

function contextFor(commits: Commits) {
  return contextOf(fakeGitHub(commits, "c1", ["CLAUDE.md"]));
}

function candidate(candidates: readonly Candidate[], key: string): Candidate {
  const found = candidates.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`no candidate ${key}`);
  }
  return found;
}

describe("links in markdown", () => {
  it("finds inline links and reference definitions, outside code", () => {
    expect(
      markdownLinks(
        '[a](x.md) and [b](<y z.md>) `[c](no.md)`\n[d]: ./w.md "W"\n```\n[e](fenced.md)\n```\n'
      )
    ).toStrictEqual(["x.md", "y z.md", "./w.md"]);
  });

  it("resolves a link from the file it is in, and refuses what leaves the repository or is no path", () => {
    expect(resolveLink("docs/a.md", "b.md#part")).toBe("docs/b.md");
    expect(resolveLink("docs/a.md", "../GLOSSARY.md")).toBe("GLOSSARY.md");
    expect(resolveLink("AGENTS.md", "./docs/a%20b.md")).toBe("docs/a b.md");
    for (const link of [
      "../outside.md",
      "/docs/a.md",
      "https://example.com/a.md",
      "mailto:a@example.com",
      "#anchor",
      "a.md?raw=1",
    ]) {
      expect(resolveLink("AGENTS.md", link)).toBeUndefined();
    }
  });
});

describe("docs through the git adapter", () => {
  it("offers a root AGENTS.md as instructions and every doc its links reach, ids deduplicated", async () => {
    const context = contextFor(repository(true));
    const found = await gitAdapter.discover(source, context);
    const docs = found.candidates.filter(
      (entry) => entry.kind === "doc" || entry.kind === "instructions"
    );
    expect(
      docs.map(({ id, key, kind, title }) => ({ id, key, kind, title }))
    ).toStrictEqual([
      {
        id: "kit",
        key: "AGENTS.md",
        kind: "instructions",
        title: "Acme conventions",
      },
      { id: "domain", key: "docs/domain.md", kind: "doc", title: "Domain" },
      {
        id: "guide",
        key: "docs/guide.md",
        kind: "doc",
        title: "Working guide",
      },
      { id: "guide-doc", key: "ops/guide.md", kind: "doc", title: "Guide" },
      { id: "glossary", key: "GLOSSARY.md", kind: "doc", title: "Glossary" },
    ]);
    expect(
      Object.fromEntries(docs.map((entry) => [entry.key, entry.requires]))
    ).toStrictEqual({
      "AGENTS.md": ["docs/domain.md", "docs/guide.md", "ops/guide.md"],
      "GLOSSARY.md": ["docs/domain.md"],
      "docs/domain.md": ["GLOSSARY.md"],
      "docs/guide.md": undefined,
      "ops/guide.md": undefined,
    });
    expect(
      docs.every((entry) => !entry.linkOnly && entry.licenseId === "MIT")
    ).toBeTruthy();
    // The prompt is still found by its layout, as before.
    expect(found.candidates.map((entry) => entry.key)).toContain(
      "prompts/review.prompt.md"
    );
    expect(found.warnings).toStrictEqual([]);
  });

  it("imports a doc with its path, its text in doc.md, and its licence's notice", async () => {
    const context = contextFor(repository(true));
    const found = await gitAdapter.discover(source, context);
    const guide = candidate(found.candidates, "docs/guide.md");
    const imported = await gitAdapter.fetch(
      source,
      guide,
      { candidate: guide.key },
      context
    );
    expect(imported.item).toMatchObject({
      description: "How to work here.",
      id: "guide",
      kind: "doc",
      path: "docs/guide.md",
      source: {
        licenseId: "MIT",
        path: "docs/guide.md",
        repo: "https://github.com/acme/kit",
        resolvedCommit: "c1",
      },
      title: "Working guide",
    });
    expect(imported.files.map((file) => file.path)).toStrictEqual([
      "LICENSE",
      "doc.md",
    ]);
    expect(imported.files[1]?.contents).toContain("Ship small.");
  });

  it("imports AGENTS.md into AGENTS.fragment.md, requiring the docs picked with it under their picked ids", async () => {
    const context = contextFor(repository(true));
    const found = await gitAdapter.discover(source, context);
    const picks = [
      { candidate: "AGENTS.md" },
      { candidate: "docs/domain.md", id: "domain-words" },
      { candidate: "GLOSSARY.md" },
    ];
    const fetched = await Promise.all(
      picks.map(async (pick) => {
        const picked = candidate(found.candidates, pick.candidate);
        const imported = await gitAdapter.fetch(source, picked, pick, context);
        return { candidate: picked, imported, pick };
      })
    );
    const [agents, domain, glossary] = requireLinked(fetched);
    expect(agents?.item).toMatchObject({
      id: "kit",
      kind: "instructions",
      requires: ["domain-words"],
      title: "Acme conventions",
    });
    expect(agents?.files.map((file) => file.path)).toStrictEqual([
      "AGENTS.fragment.md",
      "LICENSE",
    ]);
    expect(domain?.item.requires).toStrictEqual(["glossary"]);
    expect(glossary?.item.requires).toStrictEqual(["domain-words"]);
  });

  it("has AGENTS.md picked alone require the doc already on the shelf at the path it links to, and not guess between two", async () => {
    const context = contextFor(repository(true));
    const found = await gitAdapter.discover(source, context);
    const picked = candidate(found.candidates, "AGENTS.md");
    const fetched = [
      {
        candidate: picked,
        imported: await gitAdapter.fetch(
          source,
          picked,
          { candidate: picked.key },
          context
        ),
        pick: { candidate: picked.key },
      },
    ];
    const linked = (docs: { id: string; path: string }[]) => {
      const [agents] = requireLinked(fetched, {
        candidates: found.candidates,
        docs,
        tree: undefined,
      });
      return { requires: agents?.item.requires, warnings: agents?.warnings };
    };
    expect(
      linked([
        { id: "domain-words", path: "docs/domain.md" },
        { id: "guide", path: "docs/guide.md" },
      ])
    ).toStrictEqual({ requires: ["domain-words", "guide"], warnings: [] });
    expect(
      linked([
        { id: "domain-words", path: "docs/domain.md" },
        { id: "domain-old", path: "docs/domain.md" },
      ])
    ).toStrictEqual({
      requires: undefined,
      warnings: [
        "kit: links to docs/domain.md, which 2 docs on the shelf have (domain-words, domain-old), so it requires none of them; add the one it means to its requires",
      ],
    });
    expect(
      linked([{ id: "elsewhere", path: "other/domain.md" }])
    ).toStrictEqual({ requires: undefined, warnings: [] });
  });

  it("imports AGENTS.md and its docs as links, without their text, when nothing licenses a copy", async () => {
    const context = contextFor(repository(false));
    const found = await gitAdapter.discover(source, context);
    const guide = candidate(found.candidates, "docs/guide.md");
    expect(
      [guide, candidate(found.candidates, "AGENTS.md")].map(
        (entry) => entry.linkOnly
      )
    ).toStrictEqual([true, true]);
    const imported = await gitAdapter.fetch(
      source,
      guide,
      { candidate: guide.key },
      context
    );
    expect(imported.files).toStrictEqual([]);
    expect(imported.item).toMatchObject({
      kind: "doc",
      path: "docs/guide.md",
      title: "Working guide",
    });
    expect(imported.item.description).toBeUndefined();
    expect(imported.warnings[0]).toContain("imported as a link");
  });

  it("gives a doc under an imported directory the path its AGENTS.md links to, and follows no link out of it", async () => {
    const commits: Commits = {
      c1: {
        LICENSE: MIT,
        "README.md": "# Readme\n",
        "packages/web/AGENTS.md":
          "# Web\n\nSee [the routes](docs/routes.md) and [the readme](../../README.md).\n",
        "packages/web/docs/routes.md": "# Routes\n",
      },
    };
    const context = contextFor(commits);
    const scoped: ImportSource = { ...source, path: "packages/web" };
    const found = await gitAdapter.discover(scoped, context);
    expect(found.candidates.map(({ id, key }) => ({ id, key }))).toStrictEqual([
      { id: "web", key: "packages/web/AGENTS.md" },
      { id: "routes", key: "packages/web/docs/routes.md" },
    ]);
    const routes = candidate(found.candidates, "packages/web/docs/routes.md");
    const imported = await gitAdapter.fetch(
      scoped,
      routes,
      { candidate: routes.key },
      context
    );
    expect(imported.item).toMatchObject({
      path: "docs/routes.md",
      source: { path: "packages/web/docs/routes.md" },
    });
  });

  it("imports a single markdown file named by the path as a doc, at its repository path", async () => {
    const context = contextFor(repository(true));
    const single: ImportSource = { ...source, path: "ops/guide.md" };
    const found = await gitAdapter.discover(single, context);
    expect(found.candidates).toMatchObject([
      { id: "guide", key: "ops/guide.md", kind: "doc", title: "Guide" },
    ]);
    const [only] = found.candidates;
    if (only === undefined) {
      throw new Error("no candidate");
    }
    const imported = await gitAdapter.fetch(
      single,
      only,
      { candidate: only.key },
      context
    );
    expect(imported.item).toMatchObject({ kind: "doc", path: "ops/guide.md" });

    const prompt = await gitAdapter.discover(
      { ...source, path: "prompts/review.prompt.md" },
      context
    );
    expect(prompt.candidates.map((entry) => entry.kind)).toStrictEqual([
      "prompt",
    ]);
  });

  it("offers no AGENTS.md that is a symbolic link, and no doc that is one", async () => {
    const commits: Commits = {
      c1: {
        "AGENTS.md": "CLAUDE.md",
        "CLAUDE.md": "# Rules\n\nSee [the guide](guide.md).\n",
        LICENSE: MIT,
        "guide.md": "# Guide\n",
      },
    };
    const context = contextOf(fakeGitHub(commits, "c1", ["AGENTS.md"]));
    const found = await gitAdapter.discover(source, context);
    expect(found.candidates).toStrictEqual([]);
    expect(found.warnings[0]).toContain("no AGENTS.md");
  });
});
