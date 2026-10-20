/**
 * The git adapter's licence rules on hand-written repositories (not recordings): a fake GitHub serving two commits,
 * so a test can pin a commit discovery never saw and say what each file holds.
 */
import { describe, expect, it } from "vitest";

import { gitAdapter } from "../src/adapters/git.ts";
import type { Candidate, Discovery, ImportSource } from "../src/index.ts";
import { contextOf } from "./recording.ts";

const MIT = `MIT License

Copyright (c) 2026 Acme

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

const PROPRIETARY =
  "Copyright 2026 Acme. All rights reserved. No copying without a written agreement.\n";

function skill(front: string): string {
  return `---\nname: deploy\ndescription: Deploy the app.\n${front}---\n\n# Deploy\n`;
}

type Commits = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A fake GitHub for `acme/kit`: `main` is the last commit; every tree's SHA is `<commit>:<directory>`. */
function fakeGitHub(commits: Commits, head: string): typeof fetch {
  const listing = (commit: string, directory: string, recursive: boolean) => {
    const files = Object.keys(commits[commit] ?? {});
    const prefix = directory === "" ? "" : `${directory}/`;
    const entries = new Map<
      string,
      { path: string; sha: string; type: string; size: number }
    >();
    for (const file of files.filter((path) => path.startsWith(prefix))) {
      const rest = file.slice(prefix.length);
      const [first = ""] = rest.split("/");
      if (recursive || !rest.includes("/")) {
        entries.set(rest, {
          path: rest,
          sha: `${commit}:${file}`,
          size: 1,
          type: "blob",
        });
      } else {
        entries.set(first, {
          path: first,
          sha: `${commit}:${prefix}${first}`,
          size: 0,
          type: "tree",
        });
      }
    }
    return { sha: `${commit}:${directory}`, tree: [...entries.values()] };
  };
  /** A file's text at a commit, as `raw` or `/contents` serves it. */
  const file = (
    commit: string | undefined,
    path: string | undefined
  ): Response => {
    const text = commits[commit ?? ""]?.[decodeURIComponent(path ?? "")];
    return text === undefined
      ? new Response("", { status: 404 })
      : new Response(text);
  };
  return async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const routes: [
      RegExp,
      (groups: Record<string, string | undefined>) => Response,
    ][] = [
      [
        /^https:\/\/api\.github\.com\/repos\/acme\/kit$/u,
        () => Response.json({ default_branch: "main" }),
      ],
      [/\/commits\/main$/u, () => Response.json({ sha: head })],
      [
        /\/git\/trees\/(?<sha>[^?]+)(?<recursive>\?recursive=1)?$/u,
        (groups) => {
          const [commit = "", directory = ""] = decodeURIComponent(
            groups.sha ?? ""
          ).split(":");
          return Response.json(
            listing(commit, directory, groups.recursive !== undefined)
          );
        },
      ],
      [
        /\/contents\/(?<path>[^?]+)\?ref=(?<commit>.+)$/u,
        (groups) => file(groups.commit, groups.path),
      ],
      [
        /^https:\/\/raw\.githubusercontent\.com\/acme\/kit\/(?<commit>[^/]+)\/(?<path>.+)$/u,
        (groups) => file(groups.commit, groups.path),
      ],
    ];
    const routed = routes
      .map(([pattern, answer]) => ({ answer, match: pattern.exec(url) }))
      .find(({ match }) => match !== null);
    const response =
      routed === undefined
        ? new Response("", { status: 404 })
        : routed.answer(routed.match?.groups ?? {});
    return await Promise.resolve(response);
  };
}

/** The one candidate a discovery offers. */
async function onlyCandidate(found: Promise<Discovery>): Promise<Candidate> {
  const { candidates } = await found;
  const [candidate] = candidates;
  if (candidate === undefined) {
    throw new Error("no candidate");
  }
  return candidate;
}

const source: ImportSource = {
  kind: "git",
  path: "skills/deploy",
  repo: "https://github.com/acme/kit",
};

describe("the git adapter's licence decision", () => {
  it("reads the licence again at the commit a pick pins, and links when that commit's licence forbids copies", async () => {
    const fetcher = fakeGitHub(
      {
        new: { LICENSE: MIT, "skills/deploy/SKILL.md": skill("") },
        old: { LICENSE: PROPRIETARY, "skills/deploy/SKILL.md": skill("") },
      },
      "new"
    );
    const context = contextOf(fetcher);
    const candidate = await onlyCandidate(gitAdapter.discover(source, context));
    expect(candidate).toMatchObject({ licenseId: "MIT", linkOnly: false });
    const imported = await gitAdapter.fetch(
      source,
      candidate,
      { candidate: "skills/deploy/SKILL.md", pin: { resolvedCommit: "old" } },
      context
    );
    expect([
      imported.files,
      imported.item.source?.resolvedCommit,
    ]).toStrictEqual([[], "old"]);
    expect(imported.warnings[0]).toContain("does not permit keeping a copy");
  });

  it("links a skill whose SKILL.md states a licence off the allowlist, whatever the repository's licence", async () => {
    const context = contextOf(
      fakeGitHub(
        {
          c1: {
            LICENSE: MIT,
            "skills/deploy/SKILL.md": skill("license: CC-BY-NC-4.0\n"),
          },
        },
        "c1"
      )
    );
    const candidate = await onlyCandidate(gitAdapter.discover(source, context));
    const imported = await gitAdapter.fetch(
      source,
      candidate,
      { candidate: "skills/deploy/SKILL.md" },
      context
    );
    expect(imported.files).toStrictEqual([]);
    expect(imported.item.source).toMatchObject({ license: "CC-BY-NC-4.0" });
  });

  it("adds the licence file that requires its notice when the copied item does not include it", async () => {
    const context = contextOf(
      fakeGitHub(
        { c1: { LICENSE: MIT, "skills/deploy/SKILL.md": skill("") } },
        "c1"
      )
    );
    const candidate = await onlyCandidate(gitAdapter.discover(source, context));
    const imported = await gitAdapter.fetch(
      source,
      candidate,
      { candidate: "skills/deploy/SKILL.md" },
      context
    );
    expect(imported.files.map((file) => file.path)).toStrictEqual([
      "LICENSE",
      "SKILL.md",
    ]);
    expect(imported.item.source?.creditText).toBe(
      "acme/kit: skills/deploy (MIT)"
    );
  });

  it("sends a source's token to https://api.github.com only, reading files through the API", async () => {
    const sent: { url: string; token: boolean }[] = [];
    const fake = fakeGitHub(
      { c1: { LICENSE: MIT, "skills/deploy/SKILL.md": skill("") } },
      "c1"
    );
    const watching: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      sent.push({
        token: request.headers.has("authorization"),
        url: request.url,
      });
      return await fake(input, init);
    };
    const context = {
      ...contextOf(watching),
      secret: (name: string) => (name === "KIT_TOKEN" ? "t0ken" : undefined),
    };
    const bound: ImportSource = {
      ...source,
      secret: "KIT_TOKEN",
      url: "https://api.github.com",
    };
    const candidate = await onlyCandidate(gitAdapter.discover(bound, context));
    await gitAdapter.fetch(
      bound,
      candidate,
      { candidate: "skills/deploy/SKILL.md" },
      context
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.every(
        ({ token, url }) => token && url.startsWith("https://api.github.com/")
      )
    ).toBeTruthy();
    await expect(
      gitAdapter.discover(
        { ...source, secret: "KIT_TOKEN", url: "https://github.com" },
        context
      )
    ).rejects.toThrow("bind KIT_TOKEN to https://api.github.com");
  });
});
