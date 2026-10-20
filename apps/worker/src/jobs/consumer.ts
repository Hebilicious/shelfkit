/**
 * The queue consumer and the cron. Each job runs with a `system` session, which only job code makes, against the
 * shelf its message names. A job that throws is retried by the queue, then dead-lettered to `shelfkit-jobs-dlq`.
 */
import { adapterFor, adapters, scanners } from "@shelfkit/importers";
import type {
  AdapterContext,
  SourceAdapter,
  Scanner,
} from "@shelfkit/importers";
import * as v from "valibot";

import { listShelves, shelfStub } from "../auth/index.ts";
import type { Session } from "../auth/index.ts";
import { GitHubForge } from "../forge/github.ts";
import { indexFromForge } from "../forge/index.ts";
import type { Forge } from "../forge/index.ts";
import { resolveSecret } from "../secrets.ts";
import type { SecretBindingRecord } from "../secrets.ts";
import { JobMessageSchema } from "./messages.ts";
import type { JobMessage } from "./messages.ts";

/** What a job reaches besides the Worker's bindings; tests pass their own. */
export interface JobDependencies {
  readonly adapters: readonly SourceAdapter[];
  readonly scanners: readonly Scanner[];
  readonly forge: Forge;
  readonly fetch: typeof fetch;
  readonly now: () => string;
}

export function jobDependencies(env: Env): JobDependencies {
  return {
    adapters,
    fetch: async (input, init) => await fetch(input, init),
    forge: new GitHubForge(
      async (input, init) => await fetch(input, init),
      env.GITHUB_TOKEN
    ),
    now: () => `${new Date().toISOString().slice(0, 19)}Z`,
    scanners,
  };
}

/**
 * The context an adapter or a scanner runs with, for one destination: `secret(name)` releases a secret only by the
 * secret rule (`src/secrets.ts`): the shelf lists the name, and the owner bound it to the destination's origin. A
 * destination of `null` (no URL to send to) releases nothing.
 */
export function adapterContext(
  env: Env,
  dependencies: JobDependencies,
  bindings: readonly SecretBindingRecord[],
  destination: string | null
): AdapterContext {
  return {
    fetch: dependencies.fetch,
    now: dependencies.now,
    secret: (name) =>
      destination === null
        ? undefined
        : resolveSecret(env, bindings, name, destination),
  };
}

/** Where a source sends its requests: its URL, or its Git repository's when that is a URL. */
function sourceDestination(source: {
  readonly url?: string;
  readonly repo?: string;
}): string | null {
  return (
    source.url ??
    (source.repo?.startsWith("https://") === true ? source.repo : null)
  );
}

export async function consume(batch: MessageBatch, env: Env): Promise<void> {
  const dependencies = jobDependencies(env);
  for (const message of batch.messages) {
    const parsed = v.safeParse(JobMessageSchema, message.body);
    if (!parsed.success) {
      // A message no consumer can read is dropped, not retried forever.
      console.error("dropping a job message that is not one", parsed.issues);
      message.ack();
      continue;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- jobs of one batch run in turn; each may write its shelf.
      await runJob(parsed.output, env, dependencies);
      message.ack();
    } catch (error) {
      console.error(
        `job ${parsed.output.type} for ${parsed.output.shelf} failed`,
        error
      );
      message.retry();
    }
  }
}

/** One kind of job message. */
type JobOf<T extends JobMessage["type"]> = Extract<JobMessage, { type: T }>;

export async function runJob(
  message: JobMessage,
  env: Env,
  dependencies: JobDependencies
): Promise<void> {
  switch (message.type) {
    case "import.discover": {
      await discoverImport(message, env, dependencies);
      return;
    }
    case "import.apply": {
      await applyImport(message, env, dependencies);
      return;
    }
    case "upstream.check": {
      await checkUpstream(message, env, dependencies);
      return;
    }
    case "scan.item": {
      await scanItem(message, env, dependencies);
      return;
    }
    case "index.forge": {
      await indexForge(message, env, dependencies);
      return;
    }
    default: {
      const unhandled: never = message;
      throw new Error(`no job runs \`${JSON.stringify(unhandled)}\``);
    }
  }
}

/** List what an import's source offers. */
async function discoverImport(
  message: JobOf<"import.discover">,
  env: Env,
  dependencies: JobDependencies
): Promise<void> {
  const session: Session = { job: message.type, kind: "system" };
  const stub = shelfStub(env, message.shelf);
  const [job] =
    (await stub.importJobs(session, message.shelf, message.job)) ?? [];
  if (job === undefined) {
    return;
  }
  const adapter = adapterFor(job.source.kind, dependencies.adapters);
  if (adapter === undefined) {
    await stub.discovered(session, message.shelf, message.job, {
      error: `there is no importer for \`${job.source.kind}\` sources yet`,
    });
    return;
  }
  try {
    const bindings = await stub.secretBindings(session, message.shelf);
    const found = await adapter.discover(
      job.source,
      adapterContext(env, dependencies, bindings, sourceDestination(job.source))
    );
    await stub.discovered(session, message.shelf, message.job, found);
  } catch (error) {
    await stub.discovered(session, message.shelf, message.job, {
      error: String(error),
    });
  }
}

/** Fetch the picked candidates of an import and commit them, then queue a scan of each changed item. */
async function applyImport(
  message: JobOf<"import.apply">,
  env: Env,
  dependencies: JobDependencies
): Promise<void> {
  const session: Session = { job: message.type, kind: "system" };
  const stub = shelfStub(env, message.shelf);
  const [job] =
    (await stub.importJobs(session, message.shelf, message.job)) ?? [];
  const adapter =
    job === undefined
      ? undefined
      : adapterFor(job.source.kind, dependencies.adapters);
  if (job === undefined || adapter === undefined) {
    return;
  }
  try {
    const bindings = await stub.secretBindings(session, message.shelf);
    const context = adapterContext(
      env,
      dependencies,
      bindings,
      sourceDestination(job.source)
    );
    const candidates = new Map(
      job.candidates.map((candidate) => [candidate.key, candidate])
    );
    const items = await Promise.all(
      job.picks.map(async (pick) => {
        const candidate = candidates.get(pick.candidate);
        if (candidate === undefined) {
          throw new Error(`no candidate ${pick.candidate}`);
        }
        return await adapter.fetch(job.source, candidate, pick, context);
      })
    );
    const committed = await stub.applyImport(
      session,
      message.shelf,
      message.job,
      { items, warnings: [] }
    );
    if (committed?.ok === true && dependencies.scanners.length > 0) {
      await env.JOBS.sendBatch(
        committed.changed.items.map((item) => ({
          body: { item, shelf: message.shelf, type: "scan.item" },
        }))
      );
    }
  } catch (error) {
    await stub.applyImport(session, message.shelf, message.job, {
      error: String(error),
    });
  }
}

/** Check every imported item's upstream for drift. */
async function checkUpstream(
  message: JobOf<"upstream.check">,
  env: Env,
  dependencies: JobDependencies
): Promise<void> {
  const session: Session = { job: message.type, kind: "system" };
  const stub = shelfStub(env, message.shelf);
  const bindings = await stub.secretBindings(session, message.shelf);
  for (const imported of await stub.importedItems(session, message.shelf)) {
    const adapter =
      imported.sourceKind === null
        ? undefined
        : adapterFor(imported.sourceKind, dependencies.adapters);
    if (adapter === undefined) {
      continue;
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one upstream at a time, to be gentle with each source.
      const state = await adapter.checkUpstream(
        imported.item,
        adapterContext(
          env,
          dependencies,
          bindings,
          sourceDestination(imported.item.source ?? {})
        )
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- recorded as it is learned.
      await stub.recordUpstream(session, message.shelf, imported.id, state);
    } catch (error) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- recorded as it is learned.
      await stub.recordUpstream(session, message.shelf, imported.id, {
        error: String(error),
        status: "error",
      });
    }
  }
}

/** Run every scanner over one revision of an item. */
async function scanItem(
  message: JobOf<"scan.item">,
  env: Env,
  dependencies: JobDependencies
): Promise<void> {
  const session: Session = { job: message.type, kind: "system" };
  const stub = shelfStub(env, message.shelf);
  const ref =
    message.revision === undefined
      ? message.item
      : `${message.item}@${message.revision}`;
  const found = await stub.getItem(session, message.shelf, ref);
  if (!found.ok) {
    return;
  }
  const { item, revision } = found.value;
  for (const scanner of dependencies.scanners) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- scanners run in turn; each verdict is recorded as it arrives.
    const verdict = await scanner.scan(
      {
        files: found.value.files.map((file) => ({
          contents: file.contents,
          encoding: file.encoding,
          path: file.path,
        })),
        item,
        revision,
      },
      // A scanner reads what it is given and is given no secret.
      adapterContext(env, dependencies, [], null)
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- recorded as it arrives.
    await stub.recordScan(
      session,
      message.shelf,
      message.item,
      revision,
      verdict
    );
  }
}

/** Index a shelf from a repository on the forge. */
async function indexForge(
  message: JobOf<"index.forge">,
  env: Env,
  dependencies: JobDependencies
): Promise<void> {
  const session: Session = { job: message.type, kind: "system" };
  const committed = await indexFromForge(env, dependencies.forge, session, {
    ref: message.ref,
    repository: message.repository,
    root: message.root,
    shelf: message.shelf,
  });
  if (!committed.ok) {
    console.error(
      `indexing ${message.repository} into ${message.shelf} was refused`,
      committed.errors
    );
  }
}

/** The hourly cron: queue an upstream check for every shelf the deployment holds. */
export async function scheduled(env: Env): Promise<void> {
  const shelves = await listShelves(env);
  for (let start = 0; start < shelves.length; start += 100) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a batch holds at most 100 messages.
    await env.JOBS.sendBatch(
      shelves
        .slice(start, start + 100)
        .map((shelf) => ({ body: { shelf, type: "upstream.check" } }))
    );
  }
}
