import type { SourceAdapter, Scanner } from "@shelfkit/importers";
/**
 * Work that outlives a request: indexing a shelf from GitHub (against recorded responses), and the importer seam issue
 * #8 fills in, driven here by stand-in adapters and a scanner.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

import type { Session } from "../src/auth/index.ts";
import { GitHubForge } from "../src/forge/github.ts";
import { indexFromForge } from "../src/forge/index.ts";
import { runJob } from "../src/jobs/consumer.ts";
import type { JobDependencies } from "../src/jobs/consumer.ts";
import recording from "./fixtures/github-shelfkit.json";
import { data, push, shelfOf } from "./helpers.ts";

const system: Session = { job: "test", kind: "system" };
const owner: Session = { keyId: "owner", kind: "owner" };

const RecordingSchema = v.object({
  responses: v.record(
    v.string(),
    v.union([v.object({ json: v.unknown() }), v.object({ base64: v.string() })])
  ),
});

/** A `fetch` over recorded responses, and the URLs it was asked for. */
interface Recorded {
  readonly fetch: typeof fetch;
  readonly requests: string[];
}

/** `fetch` over the recording: each URL answers what GitHub answered, and anything else is a 404. */
function recorded(): Recorded {
  const { responses } = v.parse(RecordingSchema, recording);
  const requests: string[] = [];
  // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
  const fetcher: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    const found = responses[url];
    if (found === undefined) {
      return Promise.resolve(new Response("not recorded", { status: 404 }));
    }
    if ("json" in found) {
      return Promise.resolve(Response.json(found.json));
    }
    return Promise.resolve(
      new Response(
        Uint8Array.from(atob(found.base64), (char) => char.codePointAt(0) ?? 0)
      )
    );
  };
  return { fetch: fetcher, requests };
}

function stub(shelf: string) {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}

/** Start every test from nothing: no shelf, no objects, no jobs. */
async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

describe("indexing from GitHub", () => {
  beforeEach(fresh);

  it("snapshots a repository's shelf into R2 by sha256 and commits it", async () => {
    const github = recorded();
    const committed = await indexFromForge(
      env,
      new GitHubForge(github.fetch),
      owner,
      {
        repository: "Hebilicious/shelfkit",
        root: "shelf",
        shelf: "hebilicious",
      }
    );
    if (!committed.ok) {
      throw new Error(JSON.stringify(committed.errors));
    }
    expect(committed.snapshot.origin).toBe("forge");
    expect(committed.snapshot.message).toContain(
      "Hebilicious/shelfkit@a945df0dbbf409047c7b8103dd7d121366c3b804"
    );
    expect(committed.changed.items.toSorted()).toStrictEqual([
      "commit-style",
      "shelfkit-stack",
      "typescript-strict",
    ]);
    const files = await stub("hebilicious").files(owner, "hebilicious");
    for (const file of files?.files ?? []) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each object is checked where the snapshot says it is.
      const object = await env.BLOBS.head(`objects/${file.sha256}`);
      expect(object?.size).toBe(file.size);
    }
    expect(github.requests[0]).toBe(
      "https://api.github.com/repos/Hebilicious/shelfkit"
    );
  });

  it("fails on a ref GitHub does not know, and commits nothing", async () => {
    const github = recorded();
    await expect(
      indexFromForge(env, new GitHubForge(github.fetch), owner, {
        ref: "no-such-branch",
        repository: "Hebilicious/shelfkit",
        root: "shelf",
        shelf: "hebilicious",
      })
    ).rejects.toThrow("GitHub answered 404");
    const summary = await stub("hebilicious").summary(owner, "hebilicious");
    expect(summary.ok).toBeFalsy();
  });
});

const prompt = {
  description: "From upstream",
  id: "upstream-prompt",
  kind: "prompt" as const,
  source: {
    license: "MIT",
    licenseId: "MIT",
    repo: "https://github.com/acme/prompts",
    resolvedCommit: "a".repeat(40),
  },
  title: "Upstream prompt",
};

/** A stand-in Git adapter: one candidate, fetched with provenance, and an upstream that has moved. */
const adapter: SourceAdapter = {
  // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
  checkUpstream: () =>
    Promise.resolve({
      latest: { resolvedCommit: "b".repeat(40) },
      status: "moved",
    }),
  // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
  discover: () =>
    Promise.resolve({
      candidates: [
        {
          id: "upstream-prompt",
          key: "prompts/upstream.prompt.md",
          kind: "prompt",
          license: "MIT",
          licenseId: "MIT",
          linkOnly: false,
          title: "Upstream prompt",
          upstream: { resolvedCommit: "a".repeat(40) },
        },
      ],
      warnings: ["one file skipped"],
    }),
  // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
  fetch: () =>
    Promise.resolve({
      files: [
        {
          contents: "Do the upstream thing.\n",
          encoding: "utf-8",
          path: "prompt.md",
        },
      ],
      item: prompt,
      warnings: [],
    }),
  kind: "git",
};

const verdicts: string[] = [];
const scanner: Scanner = {
  id: "stand-in",
  // oxlint-disable-next-line typescript/promise-function-async -- a stand-in with nothing to wait for answers with a settled promise.
  scan: (subject) => {
    verdicts.push(subject.revision);
    return Promise.resolve({
      scanner: "stand-in",
      summary: "nothing found",
      verdict: "clean",
    });
  },
};

function dependencies(): JobDependencies {
  return {
    adapters: [adapter],
    fetch,
    forge: new GitHubForge(recorded().fetch),
    now: () => "2026-10-19T12:00:00Z",
    scanners: [scanner],
  };
}

const ImportedSchema = v.object({
  shelf: v.object({
    item: v.object({
      drift: v.object({ latest: v.unknown(), status: v.string() }),
      scanStatus: v.string(),
      scans: v.array(v.object({ revision: v.string(), verdict: v.string() })),
      source: v.unknown(),
    }),
  }),
});

/** Create an import job on `kit` for the stand-in's repository, and run its discovery. */
async function discover(): Promise<string> {
  await push("kit", shelfOf("kit", false));
  const job = await stub("kit").createImportJob(owner, "kit", {
    kind: "git",
    repo: "https://github.com/acme/prompts",
  });
  if (job === null) {
    throw new Error("no job");
  }
  await runJob(
    { job: job.id, shelf: "kit", type: "import.discover" },
    env,
    dependencies()
  );
  return job.id;
}

/** Pick the stand-in's one candidate and apply the import. */
async function apply(job: string): Promise<void> {
  await stub("kit").pickImport(owner, "kit", job, [
    { candidate: "prompts/upstream.prompt.md" },
  ]);
  await runJob(
    { job, shelf: "kit", type: "import.apply" },
    env,
    dependencies()
  );
}

/** Import the stand-in's prompt, check its upstream, and scan it. */
async function importAndScan(): Promise<void> {
  await apply(await discover());
  await runJob({ shelf: "kit", type: "upstream.check" }, env, dependencies());
  await runJob(
    { item: "upstream-prompt", shelf: "kit", type: "scan.item" },
    env,
    dependencies()
  );
}

const IMPORTED = `{ shelf(id: "kit") { item(id: "upstream-prompt") { source drift { status latest } scanStatus scans { revision verdict } } } }`;

describe("the importer seam", () => {
  beforeEach(fresh);

  it("discovers, then imports what was picked", async () => {
    const job = await discover();
    const [ready] = (await stub("kit").importJobs(owner, "kit", job)) ?? [];
    expect(ready?.status).toBe("ready");
    expect(ready?.warnings).toStrictEqual(["one file skipped"]);

    await apply(job);
    const [done] = (await stub("kit").importJobs(owner, "kit", job)) ?? [];
    expect(done).toMatchObject({
      imported: ["upstream-prompt"],
      status: "done",
    });
  });

  it("imports with provenance, records drift, and binds verdicts to our hash", async () => {
    await importAndScan();
    const imported = await data(ImportedSchema, IMPORTED);
    expect(imported.shelf.item.source).toStrictEqual(prompt.source);
    expect(imported.shelf.item.drift).toStrictEqual({
      latest: { resolvedCommit: "b".repeat(40) },
      status: "moved",
    });
    expect(imported.shelf.item.scanStatus).toBe("clean");
    expect(
      imported.shelf.item.scans.map((scan) => scan.revision)
    ).toStrictEqual([verdicts.at(-1)]);
  });

  it("leaves a new revision unscanned: it inherits no verdict", async () => {
    await importAndScan();
    await data(
      v.unknown(),
      `mutation { updatePrompt(shelf: "kit", id: "upstream-prompt", body: "Changed.\\n") { ok } }`
    );
    const changed = await data(ImportedSchema, IMPORTED);
    expect(changed.shelf.item.scanStatus).toBe("unscanned");
    expect(changed.shelf.item.scans).toHaveLength(1);
  });

  it("fails an import plainly when no adapter reads the source", async () => {
    await push("kit", shelfOf("kit", false));
    const job = await stub("kit").createImportJob(owner, "kit", {
      kind: "catalog",
      url: "https://example.com",
    });
    await runJob(
      { job: job?.id ?? "", shelf: "kit", type: "import.discover" },
      env,
      dependencies()
    );
    const [failed] =
      (await stub("kit").importJobs(owner, "kit", job?.id)) ?? [];
    expect(failed).toMatchObject({
      error: "there is no importer for `catalog` sources yet",
      status: "failed",
    });
  });

  it("refuses discoveries and verdicts from anyone but the Worker's own jobs", async () => {
    await push("kit", shelfOf("kit", false));
    await expect(
      stub("kit").recordUpstream(owner, "kit", "x", { status: "current" })
    ).resolves.toBeFalsy();
    await expect(
      stub("kit").discovered(owner, "kit", "x", {
        candidates: [],
        warnings: [],
      })
    ).resolves.toBeFalsy();
    await expect(
      stub("kit").recordUpstream(system, "kit", "x", {
        status: "current",
      })
    ).resolves.toBeTruthy();
  });
});
