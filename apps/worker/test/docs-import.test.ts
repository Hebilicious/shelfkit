/**
 * Docs through the Worker's import jobs: the real Git adapter over a hand-written GitHub
 * (`packages/importers/test/fake-github.ts`) whose AGENTS.md links to two docs. The imports land as a valid
 * `instructions` item and `doc` items, AGENTS.md requiring the docs picked with it, and a profile that selects it
 * compiles with its links pointed at the docs' installed copies. The shelf is this file's own: storage is shared
 * between test files.
 */
import { adapters } from "@shelfkit/importers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

import { fakeGitHub } from "../../../packages/importers/test/fake-github.ts";
import { GitHubForge } from "../src/forge/github.ts";
import { runJob } from "../src/jobs/consumer.ts";
import type { JobDependencies } from "../src/jobs/consumer.ts";
import { data, push, shelfOf } from "./helpers.ts";

const SHELF = "docs-kit";
const owner = { keyId: "owner", kind: "owner" } as const;

const MIT = `MIT License

Copyright (c) 2026 Acme

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`;

/** acme/kit: an AGENTS.md linking a doc that links another. */
const FILES = {
  "AGENTS.md":
    "# Kit conventions\n\nName things after [the domain](docs/domain.md#terms).\n",
  "GLOSSARY.md": "# Glossary\n\n- **Widget**: the thing we sell.\n",
  "docs/domain.md": "# Domain\n\nSee [the glossary](../GLOSSARY.md).\n",
} as const;

/** acme/kit at its one commit, with an MIT licence or with none. */
function repository(licensed: boolean): typeof fetch {
  return fakeGitHub(
    { c1: licensed ? { ...FILES, LICENSE: MIT } : FILES },
    "c1"
  );
}

function dependencies(fetcher: typeof fetch): JobDependencies {
  return {
    adapters,
    fetch: fetcher,
    forge: () => new GitHubForge(fetcher),
    now: () => "2026-10-19T12:00:00Z",
    scanners: [],
  };
}

function stub() {
  return env.SHELF.get(env.SHELF.idFromName(SHELF));
}

/** Import every candidate acme/kit offers into the shelf, and answer the finished job. */
async function importEverything(fetcher: typeof fetch) {
  await push(SHELF, shelfOf(SHELF, false));
  const job = await stub().createImportJob(owner, SHELF, {
    kind: "git",
    repo: "https://github.com/acme/kit",
  });
  if (job === null) {
    throw new Error("no job");
  }
  const deps = dependencies(fetcher);
  await runJob(
    { job: job.id, shelf: SHELF, type: "import.discover" },
    env,
    deps
  );
  const [found] = (await stub().importJobs(owner, SHELF, job.id)) ?? [];
  const candidates = found?.candidates ?? [];
  await stub().pickImport(
    owner,
    SHELF,
    job.id,
    candidates.map((candidate) => ({ candidate: candidate.key }))
  );
  await runJob({ job: job.id, shelf: SHELF, type: "import.apply" }, env, deps);
  const [done] = (await stub().importJobs(owner, SHELF, job.id)) ?? [];
  return { candidates, done };
}

const ItemSchema = v.object({
  shelf: v.object({
    item: v.object({
      document: v.record(v.string(), v.unknown()),
      files: v.array(v.object({ path: v.string() })),
      kind: v.string(),
    }),
  }),
});

async function item(id: string) {
  const found = await data(
    ItemSchema,
    `{ shelf(id: "${SHELF}") { item(id: "${id}") { kind document files { path } } } }`
  );
  return found.shelf.item;
}

const PreviewSchema = v.object({
  shelf: v.object({
    previewProfile: v.object({
      conflicts: v.array(v.object({ message: v.string() })),
      errors: v.array(v.object({ message: v.string() })),
      plan: v.nullable(v.object({ files: v.unknown() })),
    }),
  }),
});

/** Compile a profile that selects the imported AGENTS.md alone. */
async function compileAgents() {
  const found = await data(
    PreviewSchema,
    `query P($document: JSON!) { shelf(id: "${SHELF}") { previewProfile(document: $document) { conflicts { message } errors { message } plan { files } } } }`,
    {
      document: {
        bundles: [],
        compile: {},
        extends: [],
        id: "p",
        items: ["kit"],
        title: "P",
      },
    }
  );
  return found.shelf.previewProfile;
}

describe("docs through the import jobs", () => {
  beforeEach(async () => {
    await reset();
    await abortAllDurableObjects();
  });

  it("offers AGENTS.md and the docs its links reach, and imports every one", async () => {
    const { candidates, done } = await importEverything(repository(true));
    expect(candidates.map(({ key, kind }) => ({ key, kind }))).toStrictEqual([
      { key: "AGENTS.md", kind: "instructions" },
      { key: "docs/domain.md", kind: "doc" },
      { key: "GLOSSARY.md", kind: "doc" },
    ]);
    expect(done).toMatchObject({ error: null, status: "done" });
    expect(done?.imported.toSorted()).toStrictEqual([
      "domain",
      "glossary",
      "kit",
    ]);
  });

  it("lands AGENTS.md as instructions requiring its doc, and the doc as a doc item with its text", async () => {
    await importEverything(repository(true));
    const agents = await item("kit");
    expect(agents).toMatchObject({
      document: { requires: ["domain"] },
      kind: "instructions",
    });
    expect(agents.files.map((file) => file.path)).toContain(
      "AGENTS.fragment.md"
    );
    const domain = await item("domain");
    expect(domain).toMatchObject({
      document: {
        kind: "doc",
        path: "docs/domain.md",
        requires: ["glossary"],
        title: "Domain",
      },
      kind: "doc",
    });
    expect(domain.files.map((file) => file.path)).toContain("doc.md");
  });

  it("compiles a profile that selects AGENTS.md with its docs in the docs skill and its links pointed there", async () => {
    await importEverything(repository(true));
    const compiled = await compileAgents();
    expect(compiled.errors).toStrictEqual([]);
    const files = JSON.stringify(compiled.plan?.files);
    expect(files).toContain("docs-kit-p-docs/docs/domain.md");
    expect(files).toContain("docs-kit-p-docs/GLOSSARY.md");
    expect(files).toContain(
      "[the domain](.agents/skills/docs-kit-p-docs/docs/domain.md#terms)"
    );
  });

  it("has AGENTS.md imported alone require the doc the shelf already has at the path it links to, and compile with it", async () => {
    // The shelf's own doc at docs/domain.md, under an id of its own, written before the import.
    await push(
      SHELF,
      shelfOf(SHELF, false, {
        "items/docs/domain-words/doc.md": "# Domain\n\nOur words.\n",
        "items/docs/domain-words/item.json": `${JSON.stringify({ id: "domain-words", kind: "doc", path: "docs/domain.md", title: "Domain" })}\n`,
      })
    );
    const deps = dependencies(repository(true));
    const job = await stub().createImportJob(owner, SHELF, {
      kind: "git",
      repo: "https://github.com/acme/kit",
    });
    if (job === null) {
      throw new Error("no job");
    }
    await runJob(
      { job: job.id, shelf: SHELF, type: "import.discover" },
      env,
      deps
    );
    await stub().pickImport(owner, SHELF, job.id, [{ candidate: "AGENTS.md" }]);
    await runJob(
      { job: job.id, shelf: SHELF, type: "import.apply" },
      env,
      deps
    );
    const [done] = (await stub().importJobs(owner, SHELF, job.id)) ?? [];
    const agents = await item("kit");
    const compiled = await compileAgents();
    expect({
      imported: done?.imported,
      requires: agents.document.requires,
      status: done?.status,
    }).toStrictEqual({
      imported: ["kit"],
      requires: ["domain-words"],
      status: "done",
    });
    expect(compiled.errors).toStrictEqual([]);
    expect(JSON.stringify(compiled.plan?.files)).toContain(
      "[the domain](.agents/skills/docs-kit-p-docs/docs/domain.md#terms)"
    );
  });

  it("imports unlicensed docs as links, which a profile cannot compile, and says why", async () => {
    const { done } = await importEverything(repository(false));
    expect(done).toMatchObject({ status: "done" });
    const domain = await item("domain");
    expect(domain.files.map((file) => file.path)).toStrictEqual(["item.json"]);
    expect(domain.document).toMatchObject({
      kind: "doc",
      path: "docs/domain.md",
    });
    const compiled = await compileAgents();
    expect(compiled.plan).toBeNull();
    expect(
      [...compiled.errors, ...compiled.conflicts].some((problem) =>
        problem.message.includes("was imported as a link, without its text")
      )
    ).toBeTruthy();
  });
});
