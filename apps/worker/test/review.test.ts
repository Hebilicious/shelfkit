import type { ImportSource } from "@shelfkit/importers";
import { ItemSchema } from "@shelfkit/schema";
/**
 * Regressions from the review of the hosted service (PR #14): each test failed before its fix.
 */
import {
  abortAllDurableObjects,
  listDurableObjectIds,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, inject, it } from "vitest";

import { signSession } from "../src/auth/browser.ts";
import { listShelves } from "../src/auth/index.ts";
import type { Session } from "../src/auth/index.ts";
import { displayPrefix } from "../src/auth/keys.ts";
import { migrateDatabase } from "../src/db/migrate.ts";
import { GitHubForge } from "../src/forge/github.ts";
import { runJob } from "../src/jobs/consumer.ts";
import { once } from "../src/runtime/once.ts";
import { resolveSecret } from "../src/secrets.ts";
import type { ShelfIndex } from "../src/shelf-index.ts";
import { TEST_SESSION_SECRET } from "./fake-github.ts";
import {
  createKey,
  data,
  decodeBase64,
  fixtureShelf,
  graphql,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

/** The session cookie a browser holds once the owner's GitHub account signed in. */
async function ownerSessionCookie(): Promise<string> {
  const token = await signSession(TEST_SESSION_SECRET, {
    id: "owner",
    name: "Owner",
  });
  return `__Host-shelfkit_session=${token}`;
}

const owner: Session = { keyId: "owner", kind: "owner" };
const anonymous: Session = { kind: "anonymous" };

function stub(shelf = "kit") {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}

function asKey(id: string, scopes: string[], shelf = "kit"): Session {
  return { keyId: id, kind: "key", name: "x", scopes, shelf };
}

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

async function pushKit(isPublic = false): Promise<void> {
  const pushed = await push(
    "kit",
    fixtureShelf(inject("allKindsShelf"), "kit", isPublic)
  );
  expect(pushed.errors).toStrictEqual([]);
}

/** Every event a stream delivers until it ends, or `limit` reads. */
async function readEvents(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<{ readonly text: string; readonly ended: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let read = 0; read < limit; read += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- events arrive one read at a time.
    const chunk = await reader.read();
    if (chunk.done) {
      return { ended: true, text };
    }
    text += decoder.decode(chunk.value);
  }
  await reader.cancel();
  return { ended: false, text };
}

describe("1. a key's stored prefix", () => {
  beforeEach(fresh);

  it("shows the shelf and four characters of the secret, even when the secret contains `_`", () => {
    const secret = `ab_cd_ef${"g".repeat(35)}`;
    expect(displayPrefix(`sks_acme_${secret}`)).toBe("sks_acme_ab_c…");
  });

  it("never shows more than four characters of a created key's secret", async () => {
    await push("acme", shelfOf("acme", false));
    for (let index = 0; index < 24; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one key at a time.
      await createKey("acme", ["read"], `k${index}`);
    }
    const listed = await data(
      v.object({
        shelf: v.object({ keys: v.array(v.object({ prefix: v.string() })) }),
      }),
      `{ shelf(id: "acme") { keys { prefix } } }`
    );
    for (const key of listed.shelf.keys) {
      expect(key.prefix).toMatch(/^sks_acme_.{4}…$/u);
    }
  });

  it("is rewritten to the safe form by the migration, for keys stored before it", async () => {
    await push("acme", shelfOf("acme", false));
    const leaked = "sks_acme_ab_cdefghijklmnop…";
    const prefix = await runInDurableObject(
      stub("acme"),
      (_instance: ShelfIndex, state) => {
        state.storage.sql.exec(
          "INSERT INTO api_key (id, name, hash, prefix, scopes, created_at) VALUES ('old', 'old', 'hash', ?, '[]', '2026-01-01T00:00:00Z')",
          leaked
        );
        state.storage.sql.exec(
          "DELETE FROM __drizzle_migrations WHERE name LIKE '%safe_prefixes%'"
        );
        migrateDatabase(state.storage);
        return state.storage.sql
          .exec<{ prefix: string }>(
            "SELECT prefix FROM api_key WHERE id = 'old'"
          )
          .one().prefix;
      }
    );
    expect(prefix).toBe("sks_acme_ab_c…");
  });
});

describe("2. an open event stream", () => {
  beforeEach(fresh);

  it("ends when its key is revoked, and never carries a `keys` event to a key that is not the owner", async () => {
    await pushKit();
    const reader = await createKey("kit", ["read"]);
    const stream = await stub().events(asKey(reader.id, ["read"]), "kit");
    if (stream === null) {
      throw new Error("no stream");
    }
    await createKey("kit", ["read"], "another");
    await stub().putSecretName(
      owner,
      "kit",
      "PRIVATE_API_TOKEN",
      "https://api.example.com"
    );
    await stub().revokeKey(owner, reader.id);
    await stub().putSecretName(
      owner,
      "kit",
      "AFTER_REVOKING",
      "https://api.example.com"
    );
    const { ended, text } = await readEvents(stream, 10);
    expect(ended).toBeTruthy();
    expect(text).not.toContain('"kind":"keys"');
    expect(text).toContain('"id":"PRIVATE_API_TOKEN"');
    expect(text).not.toContain("AFTER_REVOKING");
  });

  it("of an anonymous reader ends when the shelf stops being public, and carries no settings", async () => {
    await pushKit(true);
    const stream = await stub().events(anonymous, "kit");
    if (stream === null) {
      throw new Error("no stream");
    }
    await stub().putSecretName(
      owner,
      "kit",
      "PRIVATE_API_TOKEN",
      "https://api.example.com"
    );
    await stub().setVisibility(owner, "kit", false);
    await stub().setFavourite(owner, "kit", "linear", true);
    const { ended, text } = await readEvents(stream, 10);
    expect(ended).toBeTruthy();
    expect(text).not.toContain("PRIVATE_API_TOKEN");
    expect(text).not.toContain('"kind":"settings"');
  });
});

/** A mutation that sets a cookie when it runs: a cross-site request must never get that far. */
function mutationBody(): string {
  return JSON.stringify({ query: "mutation { signOut }" });
}

describe("3. cross-site requests to /graphql", () => {
  beforeEach(fresh);

  it("refuse a form or multipart body, which another site's page could send", async () => {
    const form = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: new URLSearchParams({
        query: "mutation { signOut }",
      }),
      method: "POST",
    });
    expect(form.status).toBe(415);
    expect(form.headers.get("set-cookie")).toBeNull();
    const multipart = new FormData();
    multipart.append("operations", mutationBody());
    const parts = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: multipart,
      method: "POST",
    });
    expect(parts.status).toBe(415);
    expect(parts.headers.get("set-cookie")).toBeNull();
  });

  it("refuse a request from another origin that does not bring its own key, and reflect no CORS", async () => {
    const foreign = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: mutationBody(),
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      method: "POST",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("set-cookie")).toBeNull();
    const withKey = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: JSON.stringify({ query: "{ viewer { owner } }" }),
      headers: {
        authorization: `Bearer ${TEST_OWNER_KEY}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      method: "POST",
    });
    expect(withKey.status).toBe(200);
    expect(withKey.headers.get("access-control-allow-origin")).toBeNull();
    expect(withKey.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("refuse a POST the cookie authenticates unless it comes from this origin", async () => {
    await push("acme", shelfOf("acme", false));
    const query = JSON.stringify({ query: "{ viewer { owner } }" });
    const cookie = await ownerSessionCookie();
    const noOrigin = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: query,
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    });
    expect(noOrigin.status).toBe(403);
    const same = await exports.default.fetch(`${ORIGIN}/graphql`, {
      body: query,
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      method: "POST",
    });
    expect(same.status).toBe(200);
  });
});

describe("4. a stale session in the browser's cookie", () => {
  beforeEach(fresh);

  it("is cleared, and the request is anonymous, so the browser can sign in again", async () => {
    // Signed with a secret the deployment no longer has: what every browser holds after `SESSION_SECRET` rotates.
    const stale = await signSession("a-rotated-secret", {
      id: "owner",
      name: "Owner",
    });
    const headers = {
      cookie: `__Host-shelfkit_session=${stale}`,
      origin: ORIGIN,
    };
    const viewer = await graphql(
      "{ viewer { authenticated } }",
      {},
      undefined,
      headers
    );
    expect(viewer.status).toBe(200);
    expect(viewer.data).toStrictEqual({ viewer: { authenticated: false } });
    expect(viewer.headers.get("set-cookie")).toContain("Max-Age=0");
    // Signing in again starts at once: a passkey ceremony's options, for this browser.
    const again = await exports.default.fetch(
      `${ORIGIN}/auth/passkey/options`,
      {
        body: "{}",
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
      }
    );
    expect(again.status).toBe(200);
  });
});

describe("5. a request for a shelf that does not exist", () => {
  beforeEach(fresh);

  it("creates no Durable Object, on any surface", async () => {
    for (let index = 0; index < 5; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time.
      const raw = await exports.default.fetch(
        `${ORIGIN}/raw/junk-${index}/objects/${"0".repeat(64)}`
      );
      expect(raw.status).toBe(401);
    }
    await graphql(`
      {
        shelf(id: "junk") {
          id
        }
      }
    `);
    await graphql(`{ sharedProfile(token: "shs_junk_${"A".repeat(43)}") { title } }`);
    await graphql(
      `
        {
          shelf(id: "junk") {
            id
          }
        }
      `,
      {},
      TEST_OWNER_KEY
    );
    const listed = await exports.default.fetch(
      `${ORIGIN}/apm/v1/packages/junk/web/versions`
    );
    expect(listed.status).toBe(401);
    const viewer = await graphql(
      "{ viewer { authenticated } }",
      {},
      `sks_junk_${"A".repeat(43)}`
    );
    expect(viewer.status).toBe(401);
    const put = await exports.default.fetch(
      `${ORIGIN}/raw/junk/objects/${"0".repeat(64)}`,
      {
        body: "x",
        headers: { authorization: `Bearer sks_junk_${"A".repeat(43)}` },
        method: "PUT",
      }
    );
    expect(put.status).toBe(401);
    const created = await listDurableObjectIds(env.SHELF);
    const junk = ["junk", "junk-0", "junk-1", "junk-2", "junk-3", "junk-4"].map(
      (name) => env.SHELF.idFromName(name)
    );
    expect(
      created.filter((id) => junk.some((named) => named.equals(id)))
    ).toStrictEqual([]);
  });

  it("lists every shelf, across R2's pages", async () => {
    await Promise.all(
      Array.from(
        { length: 5 },
        async (_, index) => await env.BLOBS.put(`shelves/s-${index}`, "{}")
      )
    );
    // Pages of two: three pages, the last one short.
    await expect(listShelves(env, 2)).resolves.toStrictEqual([
      "s-0",
      "s-1",
      "s-2",
      "s-3",
      "s-4",
    ]);
  });
});

describe("6. a secret", () => {
  beforeEach(fresh);

  it("is released only to the origin the owner bound its name to", () => {
    const bindings = [
      { name: "LINEAR_API_KEY", origin: "https://mcp.linear.app" },
      { name: "UNBOUND", origin: null },
    ];
    expect(
      resolveSecret(
        env,
        bindings,
        "LINEAR_API_KEY",
        "https://mcp.linear.app/mcp"
      )
    ).toBe("test-linear-token");
    expect(
      resolveSecret(env, bindings, "LINEAR_API_KEY", "https://evil.example/mcp")
    ).toBeUndefined();
    expect(
      resolveSecret(
        env,
        bindings,
        "LINEAR_API_KEY",
        "http://mcp.linear.app/mcp"
      )
    ).toBeUndefined();
    expect(
      resolveSecret(env, bindings, "UNBOUND", "https://mcp.linear.app/mcp")
    ).toBeUndefined();
    expect(
      resolveSecret(env, bindings, "GITHUB_TOKEN", "https://github.com")
    ).toBeUndefined();
  });

  // A hang guard, not a budget: this test runs several ceremonies or a whole flow, slow on a CI runner.
  it(
    "cannot be sent elsewhere by a key that edits the hosted item's URL",
    { timeout: 20_000 },
    async () => {
      await pushKit();
      await stub().putSecretName(
        owner,
        "kit",
        "LINEAR_API_KEY",
        "https://mcp.linear.app"
      );
      const relay = await createKey("kit", ["mcp:kit/linear"]);
      const session = asKey(relay.id, ["mcp:kit/linear"]);
      const target = await stub().relayHeaders(session, "kit", "linear");
      expect(target.ok && target.value.headers).toStrictEqual({
        Authorization: "test-linear-token",
      });

      const publisher = await createKey("kit", ["publish:kit/*"]);
      const found = await stub().getItem(owner, "kit", "linear");
      if (!found.ok) {
        throw new Error("no linear");
      }
      const moved = await stub().writeItem(
        asKey(publisher.id, ["publish:kit/*"]),
        "kit",
        {
          document: v.parse(ItemSchema, {
            ...found.value.item,
            url: "https://evil.example/mcp",
          }),
          files: [],
        }
      );
      expect(moved.ok).toBeTruthy();
      const refused = await stub().relayHeaders(session, "kit", "linear");
      expect(refused.ok ? null : refused.failure._tag).toBe(
        "SecretUnavailable"
      );
    }
  );

  it("is bound to an origin by the owner alone", async () => {
    await pushKit();
    const publisher = await createKey("kit", ["read", "publish:kit/*"]);
    await expect(
      stub().putSecretName(
        asKey(publisher.id, ["read", "publish:kit/*"]),
        "kit",
        "X",
        "https://evil.example"
      )
    ).resolves.toBeFalsy();
    await expect(
      stub().putSecretName(owner, "kit", "X", "http://plain.example")
    ).resolves.toBeFalsy();
    await expect(
      stub().putSecretName(owner, "kit", "X", "https://api.example.com/path")
    ).resolves.toBeFalsy();
    await expect(
      stub().putSecretName(owner, "kit", "X", "https://api.example.com")
    ).resolves.toBeTruthy();
  });

  it("reaches an import adapter only for its source's origin", async () => {
    await pushKit();
    const seen: (string | undefined)[] = [];
    const adapter = {
      checkUpstream: async () =>
        await Promise.resolve({ status: "current" as const }),
      discover: async (
        _source: ImportSource,
        context: { readonly secret: (name: string) => string | undefined }
      ) => {
        seen.push(context.secret("GITHUB_TOKEN"));
        return await Promise.resolve({ candidates: [], warnings: [] });
      },
      fetch: async () => await Promise.reject(new Error("unused")),
      kind: "git" as const,
    };
    const dependencies = {
      adapters: [adapter],
      fetch,
      forge: new GitHubForge(fetch),
      now: () => "2026-10-19T12:00:00Z",
      scanners: [],
    };
    const discover = async (repo: string) => {
      const job = await stub().createImportJob(owner, "kit", {
        kind: "git",
        repo,
        secret: "GITHUB_TOKEN",
      });
      await runJob(
        { job: job?.id ?? "", shelf: "kit", type: "import.discover" },
        env,
        dependencies
      );
    };
    await stub().putSecretName(
      owner,
      "kit",
      "GITHUB_TOKEN",
      "https://github.com"
    );
    await discover("https://github.com/acme/private");
    await discover("https://evil.example/acme/private");
    expect(seen).toStrictEqual(["test-github-token", undefined]);
  });
});

describe("7. storage of uploads and archives", () => {
  beforeEach(fresh);

  it("does not serve an upload no commit took", async () => {
    await pushKit();
    const bytes = new TextEncoder().encode("never committed\n");
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const put = await exports.default.fetch(
      `${ORIGIN}/raw/kit/objects/${hash}`,
      {
        body: bytes,
        headers: { authorization: `Bearer ${TEST_OWNER_KEY}` },
        method: "PUT",
      }
    );
    expect(put.status).toBe(204);
    const refused = await stub().commitSnapshot(owner, {
      files: [{ path: "shelf.json", sha256: hash, size: bytes.length }],
      shelf: "kit",
    });
    expect(refused.ok).toBeFalsy();
    const get = await exports.default.fetch(
      `${ORIGIN}/raw/kit/objects/${hash}`,
      {
        headers: { authorization: `Bearer ${TEST_OWNER_KEY}` },
      }
    );
    expect(get.status).toBe(404);
  });

  it("keeps a published archive under archives/, the locked prefix, and moves one found under objects/ there", async () => {
    await push("acme", shelfOf("acme", true));
    const provided = inject("conformance");
    const archive = decodeBase64(
      provided.archives["archives/web-1.0.0.tar.gz"] ?? ""
    );
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", archive)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const published = await exports.default.fetch(
      `${ORIGIN}/apm/v1/packages/acme/web/versions/1.0.0`,
      {
        body: archive,
        headers: {
          authorization: `Bearer ${TEST_OWNER_KEY}`,
          "content-type": "application/gzip",
        },
        method: "PUT",
      }
    );
    expect(published.status).toBe(201);
    await expect(env.BLOBS.head(`archives/${hash}`)).resolves.not.toBeNull();
    await expect(env.BLOBS.head(`objects/${hash}`)).resolves.toBeNull();

    // As a deployment from before the move left it.
    await env.BLOBS.delete(`archives/${hash}`);
    await env.BLOBS.put(`objects/${hash}`, archive);
    const downloaded = await exports.default.fetch(
      `${ORIGIN}/apm/v1/packages/acme/web/versions/1.0.0/download`
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toStrictEqual(
      archive
    );
    await expect(env.BLOBS.head(`archives/${hash}`)).resolves.not.toBeNull();
  });
});

describe("8. the content a shelf has had", () => {
  beforeEach(fresh);

  it("is what knownObjects answers, so fetch can tell unpushed work from old content", async () => {
    await pushKit();
    const files = await stub().files(owner, "kit");
    const known = files?.files[0]?.sha256 ?? "";
    const found = await data(
      v.object({ shelf: v.object({ knownObjects: v.array(v.string()) }) }),
      `query K($s: [String!]!) { shelf(id: "kit") { knownObjects(sha256: $s) } }`,
      { s: [known, "f".repeat(64)] }
    );
    expect(found.shelf.knownObjects).toStrictEqual([known]);
  });
});

describe("9. a share link", () => {
  beforeEach(fresh);

  it("can be listed and revoked by the key that may create it", async () => {
    await pushKit();
    const editor = await createKey("kit", ["publish:kit/minimal"]);
    const created = await data(
      v.object({
        createShareLink: v.object({ link: v.object({ id: v.string() }) }),
      }),
      `mutation { createShareLink(shelf: "kit", profile: "minimal") { link { id } } }`,
      {},
      editor.secret
    );
    const listed = await data(
      v.object({ shareLinks: v.array(v.object({ id: v.string() })) }),
      `{ shareLinks(shelf: "kit") { id } }`,
      {},
      editor.secret
    );
    expect(listed.shareLinks.map((link) => link.id)).toStrictEqual([
      created.createShareLink.link.id,
    ]);
    const revoked = await data(
      v.object({ revokeShareLink: v.boolean() }),
      `mutation { revokeShareLink(shelf: "kit", id: "${created.createShareLink.link.id}") }`,
      {},
      editor.secret
    );
    expect(revoked.revokeShareLink).toBeTruthy();
  });
});

describe("10. the full-text index", () => {
  beforeEach(fresh);

  it("keeps no prompt body in the database, and still finds and quotes it", async () => {
    await pushKit();
    const holding = await runInDurableObject(
      stub(),
      (_instance: ShelfIndex, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
          )
          .toArray()
          .map((row) => row.name);
        return tables.filter((name) => {
          const rows = state.storage.sql
            .exec(`SELECT * FROM "${name}"`)
            .toArray();
          return JSON.stringify(rows).includes("Ticket: {{ticket}}");
        });
      }
    );
    expect(holding).toStrictEqual([]);
    const found = await stub().search(owner, "kit", { query: "ticket" });
    expect(found.ok && found.value.items[0]?.snippet).toContain(
      "Ticket: {{ticket}}"
    );
  });
});

describe("nits", () => {
  it("once makes a rejected promise again on the next call", async () => {
    let calls = 0;
    const make = once(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("first start fails");
      }
      return await Promise.resolve("started");
    });
    await expect(make()).rejects.toThrow("first start fails");
    await expect(make()).resolves.toBe("started");
  });
});
