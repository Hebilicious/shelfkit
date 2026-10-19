/**
 * The pure rules under the adapters: APM's package layouts, licence identification, ids, frontmatter, and which
 * adapter an imported item's drift check belongs to.
 */
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { skillProblem } from "../src/frontmatter.ts";
import type { TreeEntry } from "../src/github.ts";
import { parseRepository } from "../src/github.ts";
import { kebab, uniqueIds } from "../src/ids.ts";
import { sourceKindOf } from "../src/index.ts";
import {
  findArtifacts,
  inlineServers,
  isAgentPlugin,
  manifestsToRead,
  MarketplaceSchema,
} from "../src/layouts.ts";
import { classifyText, fromStatement } from "../src/licence.ts";
import { ALL_TERMS } from "../src/terms.ts";

/** A SKILL.md with the given frontmatter. */
function skill(front: string): string {
  return `---\n${front}\n---\n\n# Body\n`;
}

function blobs(...paths: string[]): TreeEntry[] {
  return paths.map((path) => ({ path, sha: path, size: 1, type: "blob" }));
}

describe("APM's package layouts", () => {
  it("finds .apm/ primitives, nested skills, hooks, and single files, each at its upstream path", () => {
    const found = findArtifacts(
      blobs(
        ".apm/prompts/review.prompt.md",
        ".apm/instructions/rust.instructions.md",
        ".apm/agents/planner.agent.md",
        ".apm/skills/deploy/SKILL.md",
        ".apm/skills/deploy/scripts/run.sh",
        "skills/pdf/SKILL.md",
        "skills/pdf/LICENSE.txt",
        "skills/pdf/nested/SKILL.md",
        "hooks/lint-on-stop.json",
        "docs/guide.prompt.md",
        "node_modules/x/y.prompt.md",
        "README.md"
      ),
      ""
    );
    expect(
      found.map((artifact) => [artifact.kind, artifact.path, artifact.name])
    ).toStrictEqual([
      ["agent", ".apm/agents/planner.agent.md", "planner"],
      ["instructions", ".apm/instructions/rust.instructions.md", "rust"],
      ["prompt", ".apm/prompts/review.prompt.md", "review"],
      ["skill", ".apm/skills/deploy", "deploy"],
      ["prompt", "docs/guide.prompt.md", "guide"],
      ["hook", "hooks/lint-on-stop.json", "lint-on-stop"],
      ["skill", "skills/pdf", "pdf"],
    ]);
    const pdf = found.find((artifact) => artifact.path === "skills/pdf");
    expect(pdf?.files?.map((file) => file.path)).toStrictEqual([
      "skills/pdf/SKILL.md",
      "skills/pdf/LICENSE.txt",
      "skills/pdf/nested/SKILL.md",
    ]);
  });

  it("reads a root SKILL.md as the whole repository, one bundle", () => {
    const found = findArtifacts(
      blobs("SKILL.md", "scripts/a.py", "extra.prompt.md"),
      ""
    );
    expect(
      found.map((artifact) => [
        artifact.kind,
        artifact.path,
        artifact.files?.length,
      ])
    ).toStrictEqual([["skill", "", 3]]);
  });

  it("tells an Agent Plugin from a Claude plugin collection by its $schema, and reads inline marketplace servers", () => {
    expect(
      isAgentPlugin({
        $schema: "https://agentplugins.dev/schemas/agent-plugin.v1.json",
      })
    ).toBeTruthy();
    expect(isAgentPlugin({ name: "collection" })).toBeFalsy();
    expect(
      manifestsToRead(
        blobs(".claude-plugin/marketplace.json", "plugin.json"),
        ""
      )
    ).toStrictEqual({
      marketplace: ".claude-plugin/marketplace.json",
      plugin: "plugin.json",
    });
    const placeholder = ["$", "{DB_TOKEN}"].join("");
    const marketplace = v.parse(MarketplaceSchema, {
      plugins: [
        { mcpServers: { db: { command: "npx", env: { TOKEN: placeholder } } } },
        { name: "other" },
      ],
    });
    expect(inlineServers(marketplace)).toStrictEqual([
      {
        definition: { command: "npx", env: { TOKEN: placeholder } },
        name: "db",
      },
    ]);
  });
});

describe("licences", () => {
  it("identifies licence texts by their fixed wording, and anything else as restrictive", () => {
    expect(classifyText("Apache License\n Version 2.0, January 2004").id).toBe(
      "Apache-2.0"
    );
    expect(
      classifyText(
        "Permission is hereby granted, free of charge, to any person ... without restriction ... The above copyright notice and this permission notice shall be included"
      ).id
    ).toBe("MIT");
    expect(
      classifyText(
        "MIT No Attribution\n\nPermission is hereby granted, free of charge"
      ).id
    ).toBe("MIT-0");
    const noDerivatives = classifyText(
      "licensed under Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International"
    );
    expect([noDerivatives.id, noDerivatives.permitsCopy]).toStrictEqual([
      "CC-BY-NC-ND-4.0",
      false,
    ]);
    const proprietary = classifyText(
      "© 2025 Anthropic, PBC. All rights reserved."
    );
    expect([proprietary.id, proprietary.permitsCopy]).toStrictEqual([
      undefined,
      false,
    ]);
  });

  it("reads a SKILL.md licence statement", () => {
    expect(fromStatement("Apache-2.0")).toMatchObject({
      id: "Apache-2.0",
      permitsCopy: true,
    });
    expect(fromStatement("Complete terms in LICENSE.txt")).toBe("see-file");
    expect(
      fromStatement("Proprietary. LICENSE.txt has complete terms")
    ).toMatchObject({ permitsCopy: false });
  });

  it("records every source's terms with a citation and the date they were read", () => {
    for (const terms of ALL_TERMS) {
      expect(terms.citations.length).toBeGreaterThan(0);
      expect(terms.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });
});

describe("ids, repositories, and frontmatter", () => {
  it("makes kebab-case ids, unique within one import", () => {
    expect(kebab("CSharpExpert")).toBe("csharp-expert");
    expect(kebab("My_Skill.v2")).toBe("my-skill-v2");
    expect(
      uniqueIds([
        { name: "review", qualifier: "prompt" },
        { name: "review", qualifier: "agent" },
        { name: "review", qualifier: "agent" },
      ])
    ).toStrictEqual(["review", "review-agent", "review-2"]);
  });

  it("reads github.com repositories only", () => {
    expect(parseRepository("https://github.com/acme/kit.git")).toStrictEqual({
      name: "kit",
      owner: "acme",
    });
    expect(parseRepository("acme/kit")).toStrictEqual({
      name: "kit",
      owner: "acme",
    });
    expect(() => parseRepository("https://gitlab.com/acme/kit")).toThrow(
      "not a github.com repository"
    );
  });

  it("checks a SKILL.md as the shelf loader does", () => {
    expect(
      skillProblem(skill("name: pdf\ndescription: Read PDFs."), "pdf")
    ).toBeUndefined();
    expect(
      skillProblem(
        skill("name: pdf\ndescription: Read PDFs.\nversion: 1"),
        "pdf"
      )
    ).toContain("version");
    expect(skillProblem(skill("name: other\ndescription: x"), "pdf")).toContain(
      "must be the item id"
    );
    expect(
      skillProblem(
        skill("name: pdf\ndescription: x\nmetadata:\n  nested:\n    a: b"),
        "pdf"
      )
    ).toContain("metadata");
  });
});

describe("which adapter checks an imported item's drift", () => {
  it("reads the kind from the item's own source when shelf.json declares none", () => {
    expect(sourceKindOf({ repo: "https://github.com/acme/kit" })).toBe("git");
    expect(
      sourceKindOf({ url: "https://clawhub.ai/steipete/skills/github" })
    ).toBe("catalog");
    expect(
      sourceKindOf({
        url: "https://registry.modelcontextprotocol.io/v0.1/servers/x/versions/1.0.0",
      })
    ).toBe("catalog");
    expect(
      sourceKindOf({
        path: "hebilicious/default",
        url: "https://shelfkit.example",
      })
    ).toBe("shelfkit");
    expect(sourceKindOf({ license: "MIT" })).toBeNull();
  });
});
