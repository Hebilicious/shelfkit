import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import * as v from "valibot";
import { beforeAll, describe, expect, it } from "vitest";

import { runConformance } from "../src/conformance.ts";
import type {
  ConformanceRequest,
  ConformanceResponse,
  Scenario,
  Started,
} from "../src/conformance.ts";
import type {
  Engine,
  RegistryAccess,
  RegistryResponse,
  VersionRecord,
} from "../src/index.ts";
import { loadConformanceSuite, loadEngine, readShelf } from "../src/node.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const binary = path.join(
  repository,
  "target/debug",
  process.platform === "win32" ? "shelfkit.exe" : "shelfkit"
);

/** A running `shelfkit serve`. */
interface Server {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/** Start `shelfkit serve` on a free loopback port and wait for the line that names its URL. */
async function serve(
  shelf: string,
  args: readonly string[],
  keys = ""
): Promise<Server> {
  const child: ChildProcess = spawn(
    binary,
    ["--shelf", shelf, "serve", "--port", "0", ...args],
    {
      env: { ...process.env, SHELFKIT_SERVE_KEYS: keys },
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  const { stdout } = child;
  if (stdout === null) {
    throw new Error("serve has no stdout");
  }
  const lines = createInterface({ input: stdout });
  // Readline keeps reading after the first line, so the server never blocks on a full pipe.
  const [first] = v.parse(v.tuple([v.string()]), await once(lines, "line"));
  const url = first.replace(/^listening on /u, "");
  return {
    stop: async () => {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
    url,
  };
}

function toHeaders(pairs: readonly (readonly [string, string])[]): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    headers.append(name, value);
  }
  return headers;
}

function sender(url: string) {
  return async (request: ConformanceRequest): Promise<ConformanceResponse> => {
    const response = await fetch(`${url}${request.path}`, {
      body:
        request.body === undefined ? undefined : new Uint8Array(request.body),
      headers: toHeaders(request.headers),
      method: request.method,
      redirect: "manual",
    });
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
      status: response.status,
    };
  };
}

/**
 * A registry host over memory that runs the engine's two steps, as the Worker runs them over a Durable Object and R2:
 * prepare, resolve the key and load the context, respond, then store a publish and send the stored bytes for an
 * `archive` body.
 */
function memoryHost(
  engine: Engine,
  owner: string,
  scenario: Scenario
): Started {
  const shelves = new Map([[owner.toLowerCase(), { public: scenario.public }]]);
  const keys = new Map(scenario.keys.map((key) => [key.key, key.scopes]));
  const packages = new Map<
    string,
    { readonly record: VersionRecord; readonly bytes: Uint8Array }[]
  >();

  const toResponse = (response: RegistryResponse): ConformanceResponse => {
    const headers = toHeaders(response.headers);
    const { body } = response;
    if (body.kind === "json") {
      return {
        body: new TextEncoder().encode(body.text),
        headers,
        status: response.status,
      };
    }
    if (body.kind === "archive") {
      const stored = packages
        .get(body.package)
        ?.find((entry) => entry.record.version === body.version);
      if (stored === undefined) {
        throw new Error(
          `no stored archive for ${body.package} ${body.version}`
        );
      }
      return { body: stored.bytes, headers, status: response.status };
    }
    return { body: new Uint8Array(), headers, status: response.status };
  };

  return {
    send: (request): ConformanceResponse => {
      const headers = toHeaders(request.headers);
      const prepared = engine.registry.prepare({
        authorization: headers.get("authorization") ?? undefined,
        method: request.method,
        path: request.path,
      });
      if ("respond" in prepared) {
        return toResponse(prepared.respond);
      }
      let access: RegistryAccess = { credential: "anonymous" };
      if (prepared.credential.kind === "unreadable") {
        access = { credential: "invalid" };
      } else if (prepared.credential.kind === "key") {
        const scopes = keys.get(prepared.credential.key);
        access =
          scopes === undefined
            ? { credential: "invalid" }
            : { credential: "key", scopes };
      }
      const stored = packages.get(prepared.packageKey) ?? [];
      const outcome = engine.registry.respond({
        access,
        body: request.body,
        contentType: headers.get("content-type") ?? undefined,
        context: {
          shelf: shelves.get(prepared.ownerKey) ?? null,
          versions: stored.map((entry) => entry.record),
        },
        ifNoneMatch: headers.get("if-none-match") ?? undefined,
        method: request.method,
        now: "2026-10-19T12:00:00Z",
        path: request.path,
      });
      if (outcome.publish !== undefined) {
        stored.push({
          bytes: request.body ?? new Uint8Array(),
          record: outcome.publish,
        });
        packages.set(prepared.packageKey, stored);
      }
      return toResponse(outcome.response);
    },
  };
}

describe("the registry conformance suite", () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await loadEngine();
  });

  it("passes against `shelfkit serve`", async () => {
    const { suite, archives } = await loadConformanceSuite();
    const shelf = path.join(repository, "crates/registry/conformance/shelf");
    const failures = await runConformance(suite, archives, async (scenario) => {
      const keys = scenario.keys
        .map((key) => `${key.scopes.join(",")}=${key.key}`)
        .join(" ");
      const server = await serve(
        shelf,
        [scenario.public ? "--public" : "--private"],
        keys
      );
      return { send: sender(server.url), stop: server.stop };
    });
    expect(failures).toStrictEqual([]);
  });

  it("passes against the engine, over a host that keeps packages in memory", async () => {
    const { suite, archives } = await loadConformanceSuite();
    const failures = await runConformance(suite, archives, (scenario) =>
      memoryHost(engine, suite.owner, scenario)
    );
    expect(failures).toStrictEqual([]);
  });
});

/** Every fixture shelf, and ShelfKit's own. */
const shelves = {
  "all-kinds": path.join(repository, "crates/core/tests/fixtures/all-kinds"),
  edges: path.join(repository, "crates/compiler/tests/fixtures/edges"),
  registry: path.join(repository, "crates/compiler/tests/fixtures/registry"),
  shelfkit: path.join(repository, "shelf"),
};

function profilesOf(root: string): string[] {
  return readdirSync(path.join(root, "profiles"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .toSorted();
}

const ListingSchema = v.object({
  versions: v.array(v.object({ digest: v.string(), version: v.string() })),
});

describe("the engine's packages and `shelfkit serve`'s", () => {
  let engine: Engine;

  beforeAll(async () => {
    engine = await loadEngine();
  });

  it.each([["edges"], ["registry"]] as const)(
    "are refused alike for %s, which has no registry namespace",
    async (name) => {
      const root = shelves[name];
      const files = await readShelf(root);
      const refusals = profilesOf(root).map((profile) => {
        const result = engine.packageProfile(files, { profile });
        return result.ok
          ? "packaged"
          : result.errors.map((error) => error.path);
      });
      expect(refusals).toStrictEqual(
        profilesOf(root).map(() => ["shelf.json"])
      );
      const exited = spawnSync(
        binary,
        ["--shelf", root, "serve", "--port", "0"],
        {
          stdio: "ignore",
        }
      );
      expect(exited.status).toBe(1);
    }
  );

  it.each([["all-kinds"], ["shelfkit"]] as const)(
    "are the same bytes for every profile of %s",
    async (name) => {
      const root = shelves[name];
      const files = await readShelf(root);
      const server = await serve(root, []);
      const send = sender(server.url);
      const get = async (route: string) =>
        await send({ headers: [], method: "GET", path: route });
      try {
        const compared = await Promise.all(
          profilesOf(root).map(async (profile) => {
            const result = engine.packageProfile(files, { profile });
            if (!result.ok) {
              // A profile the engine cannot package, `serve` does not publish either.
              const owner = /"namespace":\s*"(?<owner>[^"]+)"/u.exec(
                await readFile(path.join(root, "shelf.json"), "utf-8")
              )?.groups?.owner;
              const missing = await get(
                `/v1/packages/${String(owner)}/${profile}/versions`
              );
              return {
                expected: { profile, status: 404 },
                served: { profile, status: missing.status },
              };
            }
            const { packaged } = result;
            const versions = `/v1/packages/${packaged.package}/versions`;
            const listed = await get(versions);
            const listing = v.parse(
              ListingSchema,
              JSON.parse(new TextDecoder().decode(listed.body))
            );
            const [latest] = listing.versions;
            const download = await get(
              `${versions}/${encodeURIComponent(packaged.version)}/download`
            );
            return {
              expected: {
                archive: packaged.archive,
                digest: packaged.digest,
                profile,
                version: packaged.version,
              },
              served: {
                archive: download.body,
                digest: latest?.digest,
                profile,
                version: latest?.version,
              },
            };
          })
        );
        expect(compared.map((entry) => entry.served)).toStrictEqual(
          compared.map((entry) => entry.expected)
        );
      } finally {
        await server.stop();
      }
    }
  );
});
