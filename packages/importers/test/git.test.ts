/**
 * The `git` adapter against responses GitHub gave (fixtures/http/github.json): discovery by APM's layouts, licence per
 * artifact, link-only imports, and drift by Git object id.
 */
import { afterAll, describe, expect, it } from "vitest";

import { gitAdapter } from "../src/adapters/git.ts";
import type { Candidate, ImportSource, Item } from "../src/index.ts";
import { contextOf, recorded } from "./recording.ts";

const github = recorded("github");
const context = contextOf(github.fetch);

const ANTHROPICS = "https://github.com/anthropics/skills";
const HEAD = "dbd4588f9e1033efb41dad4bef2f7947c8993d44";
const COPILOT = "cb64ad12e32737ae764becd6885462e9b4c7cb00";

/** The brand-guidelines skill, pinned to `resolvedCommit`. */
function pinnedItem(
  resolvedCommit: string,
  path = "skills/brand-guidelines"
): Item {
  return {
    id: "brand-guidelines",
    kind: "skill",
    source: { path, ref: "main", repo: ANTHROPICS, resolvedCommit },
    title: "Brand guidelines",
  };
}

async function only(
  source: ImportSource
): Promise<{ candidate: Candidate; warnings: string[] }> {
  const found = await gitAdapter.discover(source, context);
  expect(found.candidates).toHaveLength(1);
  const [candidate] = found.candidates;
  if (candidate === undefined) {
    throw new Error("no candidate");
  }
  return { candidate, warnings: found.warnings };
}

describe("the git adapter over recorded GitHub answers", () => {
  afterAll(() => {
    github.save();
  });

  describe("the git adapter", () => {
    it("imports a skill with its own Apache-2.0 licence file, content and all, pinned to the commit", async () => {
      const source: ImportSource = {
        kind: "git",
        path: "skills/brand-guidelines",
        ref: HEAD,
        repo: ANTHROPICS,
      };
      const { candidate, warnings } = await only(source);
      expect(candidate).toMatchObject({
        id: "brand-guidelines",
        kind: "skill",
        licenseId: "Apache-2.0",
        linkOnly: false,
        path: "skills/brand-guidelines",
        upstream: { ref: HEAD, resolvedCommit: HEAD },
      });
      expect(warnings).toStrictEqual([]);

      const imported = await gitAdapter.fetch(
        source,
        candidate,
        { candidate: candidate.key },
        context
      );
      expect(imported.warnings).toStrictEqual([]);
      expect(imported.files.map((file) => file.path)).toStrictEqual([
        "LICENSE.txt",
        "SKILL.md",
      ]);
      expect(imported.item.source).toStrictEqual({
        creditText: "anthropics/skills: skills/brand-guidelines (Apache-2.0)",
        license: "Apache-2.0",
        licenseId: "Apache-2.0",
        linkTarget: ANTHROPICS,
        path: "skills/brand-guidelines",
        recordUrl: `${ANTHROPICS}/tree/${HEAD}/skills/brand-guidelines`,
        ref: HEAD,
        repo: ANTHROPICS,
        resolvedCommit: HEAD,
        shareAlike: false,
      });
    });

    it("imports a skill with no licence anywhere as a link, with no content and a warning", async () => {
      const source: ImportSource = {
        kind: "git",
        path: "skills/doc-coauthoring",
        ref: HEAD,
        repo: ANTHROPICS,
      };
      const { candidate, warnings } = await only(source);
      expect(candidate).toMatchObject({
        license: "none stated",
        linkOnly: true,
      });
      expect(candidate.licenseId).toBeUndefined();
      expect(warnings).toStrictEqual([
        "1 of 1 candidates have no licence ShelfKit can identify as permitting copies; they import as links, without content",
      ]);
    });

    it("fetches a skill with no licence as provenance only, and says why", async () => {
      const source: ImportSource = {
        kind: "git",
        path: "skills/doc-coauthoring",
        ref: HEAD,
        repo: ANTHROPICS,
      };
      const { candidate } = await only(source);
      const imported = await gitAdapter.fetch(
        source,
        candidate,
        { candidate: candidate.key },
        context
      );
      expect(imported.files).toStrictEqual([]);
      expect(imported.item.description).toBeUndefined();
      expect(imported.item.source).toMatchObject({
        license: "none stated",
        path: "skills/doc-coauthoring",
        repo: ANTHROPICS,
        resolvedCommit: HEAD,
      });
      expect(imported.warnings).toStrictEqual([
        `doc-coauthoring: its licence (none stated) does not permit keeping a copy, so it was imported as a link to ${ANTHROPICS}/tree/${HEAD}/skills/doc-coauthoring, without its content`,
      ]);
    });

    it("imports a skill under a proprietary licence file as a link", async () => {
      const source: ImportSource = {
        kind: "git",
        path: "skills/docx/SKILL.md",
        ref: HEAD,
        repo: ANTHROPICS,
      };
      const found = await gitAdapter.discover(
        { ...source, path: "skills/docx/SKILL.md" },
        context
      );
      // A path naming SKILL.md lists only that file: the skill is its directory.
      expect(
        found.candidates.map((candidate) => [
          candidate.kind,
          candidate.path,
          candidate.linkOnly,
        ])
      ).toStrictEqual([["skill", "skills/docx", true]]);
      expect(found.candidates[0]?.license).toMatch(
        /^unrecognised: © 2025 Anthropic, PBC\. All rights reserved\./u
      );
    });

    it("imports from an awesome list with no licence (ComposioHQ/awesome-claude-skills) only as links, with a warning", async () => {
      const source: ImportSource = {
        kind: "git",
        path: "domain-name-brainstormer",
        repo: "https://github.com/ComposioHQ/awesome-claude-skills",
      };
      const { candidate, warnings } = await only(source);
      expect(candidate.linkOnly).toBeTruthy();
      expect(warnings).toHaveLength(1);
      const imported = await gitAdapter.fetch(
        source,
        candidate,
        { candidate: candidate.key },
        context
      );
      expect(imported.files).toStrictEqual([]);
      expect(imported.warnings).toHaveLength(1);
      expect(imported.warnings[0]).toContain("imported as a link");
    });

    it("pins a single file of awesome-copilot (MIT) as a virtual-file dependency, with its content and the MIT notice", async () => {
      const repo = "https://github.com/github/awesome-copilot";
      for (const [path, kind, files] of [
        [
          "instructions/rust.instructions.md",
          "instructions",
          ["AGENTS.fragment.md", "LICENSE"],
        ],
        ["agents/CSharpExpert.agent.md", "agent", ["LICENSE", "agent.md"]],
      ] as const) {
        const source: ImportSource = { kind: "git", path, ref: COPILOT, repo };
        // oxlint-disable-next-line eslint/no-await-in-loop -- one recorded source at a time.
        const { candidate } = await only(source);
        expect(candidate).toMatchObject({
          key: path,
          kind,
          licenseId: "MIT",
          linkOnly: false,
          path,
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        const imported = await gitAdapter.fetch(
          source,
          candidate,
          { candidate: candidate.key },
          context
        );
        expect(imported.files.map((entry) => entry.path)).toStrictEqual([
          ...files,
        ]);
        expect(imported.item.source?.path).toBe(path);
        expect(imported.item.source?.resolvedCommit).toMatch(/^[0-9a-f]{40}$/u);
      }
    });

    it("refuses a repository on another host by name", async () => {
      await expect(
        gitAdapter.discover(
          { kind: "git", repo: "https://gitlab.com/acme/kit" },
          context
        )
      ).rejects.toThrow("is not a github.com repository");
    });
  });

  describe("drift for a git item", () => {
    it("is current when the branch moved but the artifact's tree did not", async () => {
      const state = await gitAdapter.checkUpstream(
        pinnedItem("683bc88e56f3e09ba94f7055977f3d3aa499f202"),
        context
      );
      expect(state).toStrictEqual({
        latest: { ref: "main", resolvedCommit: HEAD },
        status: "current",
      });
    });

    it("has moved when the artifact changed after the pinned commit", async () => {
      const state = await gitAdapter.checkUpstream(
        pinnedItem("0f77e501e6506235956d953cd2d7a2a4aa9ba133"),
        context
      );
      expect(state).toStrictEqual({
        latest: { ref: "main", resolvedCommit: HEAD },
        status: "moved",
      });
    });

    it("is gone when the path no longer exists upstream", async () => {
      const state = await gitAdapter.checkUpstream(
        pinnedItem(
          "0f77e501e6506235956d953cd2d7a2a4aa9ba133",
          "skills/no-such-skill"
        ),
        context
      );
      expect(state.status).toBe("gone");
    });
  });

  describe("drift for an awesome-copilot file pinned to a commit", () => {
    it("measures a commit pin against the default branch, file by file", async () => {
      const states = await Promise.all(
        [
          "instructions/rust.instructions.md",
          "agents/CSharpExpert.agent.md",
        ].map(
          async (path) =>
            await gitAdapter.checkUpstream(
              {
                id: "x",
                kind: path.endsWith(".agent.md") ? "agent" : "instructions",
                source: {
                  path,
                  ref: COPILOT,
                  repo: "https://github.com/github/awesome-copilot",
                  resolvedCommit: COPILOT,
                },
                title: "x",
              },
              context
            )
        )
      );
      for (const state of states) {
        expect(state.latest?.ref).toBe("main");
        expect(["current", "moved"]).toContain(state.status);
      }
    });
  });
});
