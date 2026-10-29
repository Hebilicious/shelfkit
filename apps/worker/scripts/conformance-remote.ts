#!/usr/bin/env tsx
/**
 * Run the registry conformance suite (`crates/registry/conformance/cases.json`) against a deployed Worker:
 * `moon run worker:conformance-remote` with `SHELFKIT_URL` and an owner key in `SHELFKIT_KEY`.
 *
 * Each scenario needs an empty registry, and a deployment keeps what it publishes, so each scenario gets a shelf of its
 * own, `conformance-<run>-<n>`, created with the owner key and given the scenario's keys. The suite addresses its owner
 * as `acme`; requests are rewritten to the scenario's shelf, and its name is written back to `acme` in answers, so the
 * suite's expectations hold unchanged. The shelves are left behind: their archives are under the bucket lock.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { runConformance } from "@shelfkit/engine/conformance";
import type {
  ConformanceRequest,
  ConformanceResponse,
} from "@shelfkit/engine/conformance";
import { loadConformanceSuite, loadEngine } from "@shelfkit/engine/node";
import * as v from "valibot";

const url = (process.env.SHELFKIT_URL ?? "").replace(/\/+$/u, "");
const ownerKey = process.env.SHELFKIT_KEY ?? "";
if (!url.startsWith("https://") || ownerKey === "") {
  console.error(
    "set SHELFKIT_URL to the deployment (https://...) and SHELFKIT_KEY to its owner key"
  );
  process.exit(2);
}

const run = randomBytes(3).toString("hex");

const AnswerSchema = v.object({
  data: v.optional(v.unknown()),
  errors: v.optional(v.array(v.unknown())),
});

/** Run an operation with the owner key, and parse its `data` with `schema`. */
async function graphql<const TSchema extends v.GenericSchema>(
  query: string,
  variables: Readonly<Record<string, string | boolean | readonly unknown[]>>,
  schema: TSchema
): Promise<v.InferOutput<TSchema>> {
  const response = await fetch(`${url}/graphql`, {
    body: JSON.stringify({ query, variables }),
    headers: {
      authorization: `Bearer ${ownerKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const answer = v.parse(AnswerSchema, await response.json());
  if (answer.errors !== undefined) {
    throw new Error(
      `GraphQL answered ${response.status}: ${JSON.stringify(answer.errors)}`
    );
  }
  return v.parse(schema, answer.data);
}

const IndexedSchema = v.object({
  shelf: v.nullable(
    v.object({
      repository: v.object({
        commit: v.nullable(v.string()),
        refused: v.nullable(v.object({ commit: v.string() })),
      }),
    })
  ),
});

/**
 * Create the scenario's shelf, one shelf.json, public or not: a root commit pushed to its repository as `git push`
 * would push it, then indexed by the deployment's queue.
 */
async function createShelf(shelf: string, isPublic: boolean): Promise<void> {
  const engine = await loadEngine();
  const planned = engine.gitCommit({
    author: {
      email: "conformance@shelfkit.invalid",
      name: "ShelfKit conformance",
      offset: 0,
      time: Math.floor(Date.now() / 1000),
    },
    base: [],
    files: [
      {
        contents: `${JSON.stringify({ name: shelf, registry: { namespace: shelf, public: isPublic } }, null, 2)}\n`,
        path: "shelf.json",
      },
    ],
    message: "A conformance scenario's shelf",
  });
  if (!planned.ok || planned.value.request === null) {
    throw new Error(`planning ${shelf}'s first commit failed`);
  }
  const pushed = await fetch(`${url}/git/${shelf}.git/git-receive-pack`, {
    body: Uint8Array.from(planned.value.request),
    headers: {
      authorization: `Bearer ${ownerKey}`,
      "content-type": "application/x-git-receive-pack-request",
    },
    method: "POST",
  });
  const report = engine.gitReport(new Uint8Array(await pushed.arrayBuffer()));
  if (
    !report.ok ||
    !report.value.unpack.ok ||
    report.value.refs.some((ref) => !ref.ok)
  ) {
    throw new Error(
      `pushing ${shelf} answered ${pushed.status}: ${JSON.stringify(report)}`
    );
  }
  const { commit } = planned.value;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling: each read waits for the one before.
    const found = await graphql(
      "query Indexed($shelf: ID!) { shelf(id: $shelf) { repository { commit refused { commit } } } }",
      { shelf },
      IndexedSchema
    );
    if (found.shelf?.repository.commit === commit) {
      return;
    }
    if (found.shelf?.repository.refused?.commit === commit) {
      throw new Error(`${shelf} refused its first commit`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
    await sleep(250);
  }
  throw new Error(`${shelf} was not indexed within a minute`);
}

async function createKey(
  shelf: string,
  name: string,
  scopes: readonly string[]
): Promise<string> {
  const data = await graphql(
    "mutation Key($shelf: ID!, $name: String!, $scopes: [String!]!) { createKey(shelf: $shelf, name: $name, scopes: $scopes) { secret } }",
    { name, scopes, shelf },
    v.object({ createKey: v.object({ secret: v.string() }) })
  );
  return data.createKey.secret;
}

function rewriteAuthorization(
  value: string,
  keys: ReadonlyMap<string, string>
): string {
  const [scheme = "", rest = ""] = value.split(" ", 2);
  if (scheme === "Bearer") {
    return `Bearer ${keys.get(rest) ?? rest}`;
  }
  if (scheme === "Basic") {
    const decoded = Buffer.from(rest, "base64").toString("utf-8");
    const colon = decoded.indexOf(":");
    const real = keys.get(decoded.slice(colon + 1));
    return real === undefined
      ? value
      : `Basic ${Buffer.from(`${decoded.slice(0, colon)}:${real}`).toString("base64")}`;
  }
  return value;
}

async function send(
  request: ConformanceRequest,
  shelf: string,
  owner: string,
  keys: ReadonlyMap<string, string>
): Promise<ConformanceResponse> {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    headers.append(
      name,
      name.toLowerCase() === "authorization"
        ? rewriteAuthorization(value, keys)
        : value
    );
  }
  const path = request.path.replace(
    new RegExp(`^/v1/packages/(${owner})(?=/|%2F)`, "iu"),
    (_match, written: string) => `/v1/packages/${sameCase(written, shelf)}`
  );
  const response = await fetch(`${url}/apm${path}`, {
    body: request.body === undefined ? undefined : new Uint8Array(request.body),
    headers,
    method: request.method,
    redirect: "manual",
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const answered = new Headers();
  for (const [name, value] of response.headers) {
    answered.append(name, restore(value, shelf, owner));
  }
  const media = response.headers.get("content-type") ?? "";
  const restored = media.includes("json")
    ? new TextEncoder().encode(
        restore(new TextDecoder().decode(body), shelf, owner)
      )
    : body;
  return { body: restored, headers: answered, status: response.status };
}

async function main(): Promise<void> {
  const { suite, archives } = await loadConformanceSuite();
  let index = 0;
  const failures = await runConformance(suite, archives, async (scenario) => {
    index += 1;
    const shelf = `conformance-${run}-${index}`;
    await createShelf(shelf, scenario.public);
    const keys = new Map<string, string>();
    for (const key of scenario.keys) {
      const scopes = key.scopes.map((scope) =>
        scope.replace(`:${suite.owner}/`, `:${shelf}/`)
      );
      // oxlint-disable-next-line eslint/no-await-in-loop -- keys are created in the scenario's order.
      keys.set(key.key, await createKey(shelf, key.name, scopes));
    }
    console.log(`scenario ${index}: ${scenario.name} on ${shelf}`);
    return {
      send: async (request) => await send(request, shelf, suite.owner, keys),
    };
  });
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(
    `${url}: every registry conformance scenario passes (${suite.scenarios.length} scenarios).`
  );
}

/** `text` with the scenario's shelf written back as the suite's owner, in whatever case the answer used. */
function restore(text: string, shelf: string, owner: string): string {
  return text.replaceAll(new RegExp(shelf, "giu"), (found) =>
    sameCase(found, owner)
  );
}

/** `name` in the case `written` uses: all upper, capitalized, or as it is. */
function sameCase(written: string, name: string): string {
  if (written === written.toUpperCase()) {
    return name.toUpperCase();
  }
  if (written.startsWith(written[0]?.toUpperCase() ?? "")) {
    return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
  }
  return name;
}

await main();
