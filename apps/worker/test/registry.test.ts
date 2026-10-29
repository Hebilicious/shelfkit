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
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { packageRepository, PACKAGES_PREFIX } from "../src/packages.ts";
import {
  basic,
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
    // Every scenario starts from nothing, and each publish also commits to the profile's Git repository: about two
    // seconds alone, more beside the rest of the suite.
  }, 30_000);
});

/** One archive of the conformance suite, by its name there. */
function conformanceArchive(name: string): Uint8Array<ArrayBuffer> {
  const provided = inject("conformance");
  const suite = v.parse(SuiteSchema, JSON.parse(provided.cases));
  const file = suite.archives[name]?.file ?? "";
  return decodeBase64(provided.archives[file] ?? "");
}

/** Publish `acme/web` at `version` with the owner key. */
async function put(
  bytes: Uint8Array<ArrayBuffer>,
  version = "1.0.0"
): Promise<Response> {
  return await exports.default.fetch(
    `${ORIGIN}/apm/v1/packages/acme/web/versions/${version}`,
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

/** `GET info/refs` of a published profile's repository, as a Git client asks for it. */
async function advertisePackage(
  path: string,
  service = "git-upload-pack",
  key?: string
): Promise<Response> {
  return await exports.default.fetch(
    `${ORIGIN}/git/${path}.git/info/refs?service=${service}`,
    { headers: key === undefined ? {} : { authorization: basic(key) } }
  );
}

describe("a published profile's repository", () => {
  beforeEach(fresh);

  it("holds every version, each a commit of its archive on main, tagged", async () => {
    await push("acme", shelfOf("acme", true));
    const first = await put(conformanceArchive("web-1.0.0"));
    const second = await put(conformanceArchive("web-1.1.0"), "1.1.0");
    expect([first.status, second.status]).toStrictEqual([201, 201]);
    const repository = packageRepository(env);
    const refs = (await repository.references("acme/web")) ?? {};
    expect(Object.keys(refs).toSorted()).toStrictEqual([
      "refs/heads/main",
      "refs/tags/v1.0.0",
      "refs/tags/v1.1.0",
    ]);
    expect(refs["refs/heads/main"]).toBe(refs["refs/tags/v1.1.0"]);
    const head = await repository.head("acme/web");
    expect(head?.message).toContain("acme/web 1.1.0");
    const files = await repository.entries("acme/web", head?.tree ?? "");
    const manifest = files.find((file) => file.path === "apm.yml");
    const text = new TextDecoder().decode(
      await repository.blob("acme/web", manifest?.id ?? "")
    );
    expect(text).toContain("1.1.0");
  });

  it("is cloned over the Git route", async () => {
    await push("acme", shelfOf("acme", true));
    await put(conformanceArchive("web-1.0.0"));
    const refs = (await packageRepository(env).references("acme/web")) ?? {};
    const advertised = await advertisePackage("acme/web");
    expect(advertised.status).toBe(200);
    const body = new TextDecoder().decode(await advertised.arrayBuffer());
    expect(body).toContain(`${refs["refs/tags/v1.0.0"]} refs/tags/v1.0.0`);
    const cloned = await exports.default.fetch(
      `${ORIGIN}/git/acme/web.git/git-upload-pack`,
      {
        body: `0032want ${refs["refs/tags/v1.0.0"]}\n00000009done\n`,
        headers: { "content-type": "application/x-git-upload-pack-request" },
        method: "POST",
      }
    );
    const answer = new TextDecoder().decode(await cloned.arrayBuffer());
    expect(answer.slice(0, 12)).toBe("0008NAK\nPACK");
  });

  it("is written by publishing, never by a push", async () => {
    await push("acme", shelfOf("acme", true));
    await put(conformanceArchive("web-1.0.0"));
    const pushing = await advertisePackage(
      "acme/web",
      "git-receive-pack",
      TEST_OWNER_KEY
    );
    expect(pushing.status).toBe(403);
    const missing = await advertisePackage("acme/nothing");
    expect(missing.status).toBe(404);
  });

  it("is read by whoever may read the package from the registry", async () => {
    await push("acme", shelfOf("acme", false));
    await put(conformanceArchive("web-1.0.0"));
    const anonymous = await advertisePackage("acme/web");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic");
    const reader = await createKey("acme", ["read:acme/web"], "reader");
    const other = await createKey("acme", ["read:acme/other"], "other");
    const statuses = await Promise.all(
      [reader.secret, other.secret, "sk_not_a_key"].map(async (key) => {
        const response = await advertisePackage(
          "acme/web",
          "git-upload-pack",
          key
        );
        await response.arrayBuffer();
        return response.status;
      })
    );
    expect(statuses).toStrictEqual([200, 403, 401]);
  });

  it("commits on the next read a version whose commit was lost, as the same commit", async () => {
    await push("acme", shelfOf("acme", true));
    await put(conformanceArchive("web-1.0.0"));
    const repository = packageRepository(env);
    const before = await repository.references("acme/web");
    const listed = await env.BLOBS.list({
      prefix: `${PACKAGES_PREFIX}acme/web/`,
    });
    await env.BLOBS.delete(listed.objects.map((object) => object.key));
    await expect(repository.references("acme/web")).resolves.toBeNull();
    const advertised = await advertisePackage("acme/web");
    await advertised.arrayBuffer();
    await expect(repository.references("acme/web")).resolves.toStrictEqual(
      before
    );
  });
});
