import { runConformance, SuiteSchema } from "@shelfkit/engine/conformance";
import type {
  ConformanceRequest,
  ConformanceResponse,
} from "@shelfkit/engine/conformance";
/**
 * The registry served by the Worker from the shelf's object: the shared conformance suite, run over HTTP against the
 * Worker as `shelfkit serve` and the engine run it, and a publish race the object must win.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, inject, it } from "vitest";

import {
  createKey,
  decodeBase64,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

/** Start every scenario from nothing: no shelf, no keys, no packages. */
async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

/** Replace a scenario's fixed key with the real key the Worker issued for it, in Bearer and in Basic. */
function rewrite(
  authorization: string,
  keys: ReadonlyMap<string, string>
): string {
  const [scheme = "", rest = ""] = authorization.split(" ", 2);
  if (scheme === "Bearer") {
    return `Bearer ${keys.get(rest) ?? rest}`;
  }
  if (scheme === "Basic") {
    try {
      const decoded = atob(rest);
      const colon = decoded.indexOf(":");
      const user = decoded.slice(0, colon);
      const key = decoded.slice(colon + 1);
      const real = keys.get(key);
      return real === undefined
        ? authorization
        : `Basic ${btoa(`${user}:${real}`)}`;
    } catch {
      return authorization;
    }
  }
  return authorization;
}

async function send(
  request: ConformanceRequest,
  keys: ReadonlyMap<string, string>
): Promise<ConformanceResponse> {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    headers.append(
      name,
      name.toLowerCase() === "authorization" ? rewrite(value, keys) : value
    );
  }
  const response = await exports.default.fetch(`${ORIGIN}/apm${request.path}`, {
    body: request.body === undefined ? undefined : new Uint8Array(request.body),
    headers,
    method: request.method,
    redirect: "manual",
  });
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers,
    status: response.status,
  };
}

describe("the Worker's registry", () => {
  it("passes the registry conformance suite", async () => {
    const provided = inject("conformance");
    const suite = v.parse(SuiteSchema, JSON.parse(provided.cases));
    const archives = new Map(
      Object.entries(suite.archives).map(([name, archive]) => [
        name,
        decodeBase64(provided.archives[archive.file] ?? ""),
      ])
    );
    const failures = await runConformance(suite, archives, async (scenario) => {
      await fresh();
      const created = await push(
        suite.owner,
        shelfOf(suite.owner, scenario.public)
      );
      expect(created.errors).toStrictEqual([]);
      const keys = new Map<string, string>();
      for (const key of scenario.keys) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- keys are created one at a time, in the scenario's order.
        const issued = await createKey(suite.owner, key.scopes, key.name);
        keys.set(key.key, issued.secret);
      }
      return { send: async (request) => await send(request, keys) };
    });
    expect(failures).toStrictEqual([]);
  });
});

/** One archive of the conformance suite, by its name there. */
function conformanceArchive(name: string): Uint8Array<ArrayBuffer> {
  const provided = inject("conformance");
  const suite = v.parse(SuiteSchema, JSON.parse(provided.cases));
  const file = suite.archives[name]?.file ?? "";
  return decodeBase64(provided.archives[file] ?? "");
}

/** Publish `acme/web@1.0.0` with the owner key. */
async function put(bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  return await exports.default.fetch(
    `${ORIGIN}/apm/v1/packages/acme/web/versions/1.0.0`,
    {
      body: bytes,
      headers: {
        authorization: `Bearer ${TEST_OWNER_KEY}`,
        "content-type": "application/gzip",
      },
      method: "PUT",
    }
  );
}

describe("a publish", () => {
  beforeEach(fresh);

  it("of one version, twice at once, is accepted once and refused once by the object", async () => {
    await push("acme", shelfOf("acme", true));
    const statuses = await Promise.all([
      put(conformanceArchive("web-1.0.0")),
      put(conformanceArchive("web-1.0.0-other")),
    ]);
    expect(
      statuses.map((response) => response.status).toSorted((a, b) => a - b)
    ).toStrictEqual([201, 409]);
    const listed = await exports.default.fetch(
      `${ORIGIN}/apm/v1/packages/acme/web/versions`
    );
    const body = v.parse(
      v.object({ versions: v.array(v.object({ version: v.string() })) }),
      await listed.json()
    );
    expect(body.versions.map((entry) => entry.version)).toStrictEqual([
      "1.0.0",
    ]);
  });

  it("of the same bytes, ten times at once, is accepted once", async () => {
    await push("acme", shelfOf("acme", true));
    const bytes = conformanceArchive("web-1.0.0");
    const statuses = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const response = await put(bytes);
        return response.status;
      })
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
  });
});
