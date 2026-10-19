/**
 * One auth module for every surface: a key works on GraphQL, the registry, `/raw`, and `/mcp`, and once revoked it fails
 * on all of them at the next request.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createKey,
  data,
  graphql,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

/** Start every test from nothing: no shelf, no keys. */
async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

const ViewerSchema = v.object({
  viewer: v.object({
    authenticated: v.boolean(),
    owner: v.boolean(),
    scopes: v.array(v.string()),
    shelf: v.nullable(v.string()),
  }),
});

const VIEWER = "{ viewer { authenticated owner shelf scopes } }";

async function status(
  path: string,
  key: string,
  init: RequestInit = {}
): Promise<number> {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
  await response.arrayBuffer();
  return response.status;
}

async function surfaces(key: string): Promise<Record<string, number>> {
  const viewer = await graphql(VIEWER, {}, key);
  return {
    graphql: viewer.status,
    mcp: await status("/mcp", key, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    raw: await status(`/raw/acme/objects/${"0".repeat(64)}`, key),
    registry: await status("/apm/v1/packages/acme/web/versions", key),
  };
}

describe("a key", () => {
  beforeEach(fresh);

  it("works on every surface until it is revoked, then fails on every one at once", async () => {
    await push("acme", shelfOf("acme", false));
    const key = await createKey("acme", ["read", "publish:acme/*"]);
    await expect(surfaces(key.secret)).resolves.toStrictEqual({
      graphql: 200,
      mcp: 501,
      raw: 404,
      registry: 404,
    });

    const revoked = await data(
      v.object({ revokeKey: v.boolean() }),
      "mutation Revoke($shelf: ID!, $id: ID!) { revokeKey(shelf: $shelf, id: $id) }",
      { id: key.id, shelf: "acme" }
    );
    expect(revoked.revokeKey).toBeTruthy();
    await expect(surfaces(key.secret)).resolves.toStrictEqual({
      graphql: 401,
      mcp: 401,
      raw: 401,
      registry: 401,
    });
  });

  it("that is malformed or unknown is 401 everywhere, never anonymous", async () => {
    await push("acme", shelfOf("acme", true));
    const unknown = `sks_acme_${"A".repeat(43)}`;
    for (const key of ["not-a-key", unknown, `sko_${"B".repeat(43)}`]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each key is checked on every surface in turn.
      await expect(surfaces(key)).resolves.toStrictEqual({
        graphql: 401,
        mcp: 401,
        raw: 401,
        registry: 401,
      });
    }
  });

  it("is resolved to its shelf and scopes, and the owner key to the owner", async () => {
    await push("acme", shelfOf("acme", false));
    const key = await createKey("acme", ["read"]);
    const asKey = await graphql(VIEWER, {}, key.secret);
    const scoped = v.parse(ViewerSchema, asKey.data);
    expect(scoped.viewer).toStrictEqual({
      authenticated: true,
      owner: false,
      scopes: ["read"],
      shelf: "acme",
    });
    const asOwner = await graphql(VIEWER, {}, TEST_OWNER_KEY);
    const owner = v.parse(ViewerSchema, asOwner.data);
    expect(owner.viewer.owner).toBeTruthy();
  });

  it("can only hold scopes on its own shelf", async () => {
    await push("acme", shelfOf("acme", false));
    const answer = await graphql(
      `
        mutation {
          createKey(shelf: "acme", name: "x", scopes: ["read:other/web"]) {
            secret
          }
        }
      `,
      {},
      TEST_OWNER_KEY
    );
    expect(answer.errors?.[0]?.message).toContain(
      "can only hold scopes on `acme`"
    );
  });

  it("of one shelf cannot read another, which looks as if it did not exist", async () => {
    await push("acme", shelfOf("acme", false));
    await push("other", shelfOf("other", false));
    const key = await createKey("acme", ["read", "publish:acme/*"]);
    const found = await graphql(
      `
        {
          shelf(id: "other") {
            id
          }
        }
      `,
      {},
      key.secret
    );
    expect(found.data).toStrictEqual({ shelf: null });
    await expect(
      status("/apm/v1/packages/other/web/versions", key.secret)
    ).resolves.toBe(404);
  });

  it("that is not the owner cannot manage keys", async () => {
    await push("acme", shelfOf("acme", false));
    const key = await createKey("acme", ["read", "publish:acme/*"]);
    const answer = await graphql(
      `
        mutation {
          createKey(shelf: "acme", name: "x", scopes: ["read"]) {
            secret
          }
        }
      `,
      {},
      key.secret
    );
    expect(answer.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});

/** Push a shelf, create a key on it, and sign in with that key: the `Set-Cookie` the answer carries. */
async function signIn(): Promise<string> {
  await push("acme", shelfOf("acme", false));
  const key = await createKey("acme", ["read"]);
  const signedIn = await graphql(
    "mutation SignIn($key: String!) { signIn(key: $key) { shelf } }",
    { key: key.secret }
  );
  return signedIn.headers.get("set-cookie") ?? "";
}

describe("the browser's cookie", () => {
  beforeEach(fresh);

  it("is set HttpOnly, Secure, and SameSite=Strict by signIn", async () => {
    const cookie = await signIn();
    expect(cookie).toContain("shelfkit_key=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("authenticates like the header, and is cleared by signOut", async () => {
    const cookie = await signIn();
    const viewer = await graphql(VIEWER, {}, undefined, {
      cookie: cookie.split(";")[0] ?? "",
    });
    expect(v.parse(ViewerSchema, viewer.data).viewer.shelf).toBe("acme");

    const signedOut = await graphql("mutation { signOut }");
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("is refused by signIn for a key that is not valid", async () => {
    const answer = await graphql(`
      mutation {
        signIn(key: "sko_nope") {
          owner
        }
      }
    `);
    expect(answer.errors?.[0]?.extensions?.code).toBe("UNAUTHENTICATED");
    expect(answer.headers.get("set-cookie")).toBeNull();
  });
});
