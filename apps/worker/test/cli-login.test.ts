/**
 * Signing the CLI in through the browser (`src/auth/cli.ts`): `shelfkit login` starts a login, a signed-in browser
 * approves or denies it, and the CLI's poll picks the key up once. The key acts as the person who approved it, on
 * every surface, with what they hold now.
 */
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

import { signSession } from "../src/auth/browser.ts";
import type { CliLoginIndex } from "../src/auth/cli-logins.ts";
import { TEST_SESSION_SECRET } from "./fake-github.ts";
import { graphql, ORIGIN, push, shelfOf, TEST_OWNER_KEY } from "./helpers.ts";

const StartSchema = v.object({
  deviceCode: v.string(),
  expiresAt: v.string(),
  expiresIn: v.number(),
  interval: v.number(),
  userCode: v.string(),
  verificationUrl: v.string(),
});

type Started = v.InferOutput<typeof StartSchema>;

const PollSchema = v.union([
  v.object({ status: v.picklist(["pending", "denied", "expired"]) }),
  v.object({ key: v.string(), status: v.literal("approved") }),
]);

/** What the CLI posts: a name for its computer, or the device code it polls with. */
type CliBody = { readonly device: string } | { readonly deviceCode: string };

async function post(path: string, body: CliBody): Promise<Response> {
  return await exports.default.fetch(`${ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

/** What `shelfkit login` sends first. */
async function start(device = "ada-laptop"): Promise<Started> {
  const response = await post("/auth/cli/start", { device });
  if (response.status !== 200) {
    throw new Error(`starting a login answered ${response.status}`);
  }
  return v.parse(StartSchema, await response.json());
}

/** What `shelfkit login` sends until it is answered. */
async function poll(deviceCode: string) {
  const response = await post("/auth/cli/poll", { deviceCode });
  if (response.headers.get("cache-control") !== "no-store") {
    throw new Error("a poll's answer may be cached");
  }
  return v.parse(PollSchema, await response.json());
}

/** A browser signed in as the owner, by its session cookie. */
async function ownerCookie(): Promise<string> {
  return `__Host-shelfkit_session=${await signSession(TEST_SESSION_SECRET, { id: "owner", name: "Owner" })}`;
}

/** A GraphQL operation from a signed-in browser: its cookie, from this origin. */
async function asBrowser(
  cookie: string,
  query: string,
  variables: Parameters<typeof graphql>[1] = {}
) {
  return await graphql(query, variables, undefined, { cookie, origin: ORIGIN });
}

const APPROVE = `mutation ($code: String!) { approveCliLogin(code: $code) { name device } }`;
const DENY = `mutation ($code: String!) { denyCliLogin(code: $code) }`;
const PREVIEW = `query ($code: String!) { cliLogin(code: $code) { code device expiresAt } }`;
const VIEWER = "{ viewer { authenticated owner name principal } }";

/** An invited person, signed in: accepting an invite to `shelf` with `scopes` makes their account and cookie. */
async function invitedPerson(
  shelf: string,
  scopes: readonly string[]
): Promise<string> {
  const made = await graphql(
    `
      mutation ($shelf: ID!, $scopes: [String!]!) {
        createInvite(shelf: $shelf, name: "Ada", scopes: $scopes) {
          url
        }
      }
    `,
    { scopes, shelf },
    TEST_OWNER_KEY
  );
  const { url } = v.parse(
    v.object({ createInvite: v.object({ url: v.string() }) }),
    made.data
  ).createInvite;
  const [, token = ""] = url.split("#");
  const redeemed = await graphql(
    `
      mutation ($token: String!) {
        redeemLink(token: $token) {
          name
        }
      }
    `,
    { token },
    undefined,
    { origin: ORIGIN }
  );
  const cookie = redeemed.headers
    .getSetCookie()
    .find((set) => set.startsWith("__Host-shelfkit_session="))
    ?.split(";")[0];
  if (cookie === undefined) {
    throw new Error(
      `accepting the invite set no cookie: ${JSON.stringify(redeemed.errors)}`
    );
  }
  return cookie;
}

/** Start a login, approve it as `cookie`'s person, and pick the key up as the CLI does. */
async function signedInCli(cookie: string): Promise<string> {
  const login = await start();
  const approved = await asBrowser(cookie, APPROVE, { code: login.userCode });
  if (approved.errors !== undefined) {
    throw new Error(`approving answered ${JSON.stringify(approved.errors)}`);
  }
  const answer = await poll(login.deviceCode);
  if (answer.status !== "approved") {
    throw new Error(`the login answered ${answer.status}`);
  }
  return answer.key;
}

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

/** The `principal` a key's viewer names. */
async function principalOf(key: string): Promise<string> {
  const answer = await graphql(VIEWER, {}, key);
  return v.parse(
    v.object({ viewer: v.object({ principal: v.string() }) }),
    answer.data
  ).viewer.principal;
}

/** The status a request with `key` answers. */
async function statusWith(key: string, path: string): Promise<number> {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return response.status;
}

describe("a CLI login", () => {
  beforeEach(fresh);

  it("starts with a code to compare, a page to approve it on, and a device code only the CLI holds", async () => {
    const login = await start();
    expect(login.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
    expect(login.verificationUrl).toBe(`${ORIGIN}/cli/${login.userCode}`);
    expect({
      deviceCode: login.deviceCode.startsWith(
        `${login.userCode.replace("-", "")}.`
      ),
      expiresIn: login.expiresIn,
      interval: login.interval,
    }).toStrictEqual({
      deviceCode: true,
      expiresIn: 600,
      interval: 2,
    });
    await expect(poll(login.deviceCode)).resolves.toStrictEqual({
      status: "pending",
    });
  });

  it("hands the approved key to the CLI once, and the key signs it in as the owner", async () => {
    const cookie = await ownerCookie();
    const login = await start("ada's laptop\u0007\n");
    const preview = await asBrowser(cookie, PREVIEW, {
      code: login.userCode.toLowerCase(),
    });
    const approved = await asBrowser(cookie, APPROVE, { code: login.userCode });
    expect({
      approved: approved.data,
      preview: preview.data,
    }).toStrictEqual({
      approved: {
        approveCliLogin: {
          device: "ada's laptop",
          name: "CLI on ada's laptop",
        },
      },
      preview: {
        cliLogin: {
          code: login.userCode,
          device: "ada's laptop",
          expiresAt: login.expiresAt,
        },
      },
    });
    const first = await poll(login.deviceCode);
    const key = "key" in first ? first.key : "";
    expect(key).toMatch(/^skc_owner_[A-Za-z0-9_-]{43}$/u);
    const second = await poll(login.deviceCode);
    const viewer = await graphql(VIEWER, {}, key);
    // Approved once: the page no longer offers it.
    const again = await asBrowser(cookie, APPROVE, { code: login.userCode });
    expect({
      again: again.errors?.[0]?.extensions?.code,
      second,
      viewer: viewer.data,
    }).toStrictEqual({
      again: "CLI_LOGIN_REFUSED",
      second: { status: "expired" },
      viewer: {
        viewer: {
          authenticated: true,
          name: null,
          owner: true,
          principal: null,
        },
      },
    });
  });

  it("is listed with the account's CLI keys, and revoking the key signs the CLI out everywhere", async () => {
    const cookie = await ownerCookie();
    await push("acme", shelfOf("acme", false));
    const key = await signedInCli(cookie);
    const listed = await asBrowser(
      cookie,
      "{ cliKeys { id name prefix lastUsedAt } }"
    );
    const { cliKeys: keys } = v.parse(
      v.object({
        cliKeys: v.array(
          v.object({ id: v.string(), name: v.string(), prefix: v.string() })
        ),
      }),
      listed.data
    );
    expect(keys.map(({ name, prefix }) => ({ name, prefix }))).toStrictEqual([
      {
        name: "CLI on ada-laptop",
        prefix: `${key.slice(0, "skc_owner_".length + 4)}…`,
      },
    ]);
    const versions = "/apm/v1/packages/acme/base/versions";
    await expect(statusWith(key, versions)).resolves.not.toBe(401);
    const revoked = await asBrowser(
      cookie,
      "mutation ($id: ID!) { revokeCliKey(id: $id) }",
      {
        id: keys[0]?.id,
      }
    );
    const viewer = await graphql(VIEWER, {}, key);
    expect({
      registry: await statusWith(key, versions),
      revoked: revoked.data,
      viewer: viewer.status,
    }).toStrictEqual({
      registry: 401,
      revoked: { revokeCliKey: true },
      viewer: 401,
    });
  });

  it("ends when denied: the CLI learns it once and holds nothing", async () => {
    const cookie = await ownerCookie();
    const login = await start();
    const denied = await asBrowser(cookie, DENY, { code: login.userCode });
    expect(denied.data).toStrictEqual({ denyCliLogin: true });
    await expect(poll(login.deviceCode)).resolves.toStrictEqual({
      status: "denied",
    });
    await expect(poll(login.deviceCode)).resolves.toStrictEqual({
      status: "expired",
    });
    const approved = await asBrowser(cookie, APPROVE, { code: login.userCode });
    expect(approved.errors?.[0]?.extensions?.code).toBe("CLI_LOGIN_REFUSED");
  });

  it("expires after its time, approved or not, and its object keeps nothing", async () => {
    const cookie = await ownerCookie();
    const login = await start();
    const code = login.userCode.replace("-", "");
    const stub = env.CLI_LOGIN.get(env.CLI_LOGIN.idFromName(code));
    const age = async () => {
      await runInDurableObject(stub, (_instance: CliLoginIndex, state) => {
        const stored = v.parse(
          v.record(v.string(), v.unknown()),
          state.storage.kv.get("login")
        );
        state.storage.kv.put("login", { ...stored, expiresAt: 1 });
      });
    };
    await age();
    const preview = await asBrowser(cookie, PREVIEW, { code: login.userCode });
    const approved = await asBrowser(cookie, APPROVE, { code: login.userCode });
    expect({
      approved: approved.errors?.[0]?.extensions?.code,
      polled: await poll(login.deviceCode),
      preview: preview.data,
    }).toStrictEqual({
      approved: "CLI_LOGIN_REFUSED",
      polled: { status: "expired" },
      preview: { cliLogin: null },
    });
    await runInDurableObject(stub, (_instance: CliLoginIndex, state) => {
      expect([...state.storage.kv.list()]).toStrictEqual([]);
    });

    // Approved, but the CLI never came back for the key before expiry: the key is revoked with the login.
    const late = await start();
    await asBrowser(cookie, APPROVE, { code: late.userCode });
    const lateStub = env.CLI_LOGIN.get(
      env.CLI_LOGIN.idFromName(late.userCode.replace("-", ""))
    );
    await runInDurableObject(
      lateStub,
      async (instance: CliLoginIndex, state) => {
        const stored = v.parse(
          v.record(v.string(), v.unknown()),
          state.storage.kv.get("login")
        );
        state.storage.kv.put("login", { ...stored, expiresAt: 1 });
        await instance.alarm();
      }
    );
    const keys = await asBrowser(cookie, "{ cliKeys { id } }");
    expect(keys.data).toStrictEqual({ cliKeys: [] });
  });

  it("answers a wrong secret, an unknown code, and nonsense as expired, and leaves the login waiting", async () => {
    const login = await start();
    const [code = ""] = login.deviceCode.split(".");
    for (const deviceCode of [
      `${code}.${"A".repeat(43)}`,
      `ABCDEFGH.${"A".repeat(43)}`,
      "nonsense",
      "",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one guess after another.
      await expect(poll(deviceCode)).resolves.toStrictEqual({
        status: "expired",
      });
    }
    await expect(poll(login.deviceCode)).resolves.toStrictEqual({
      status: "pending",
    });
  });

  it("is approved only by a browser signed in by its cookie, never by a key or from another origin", async () => {
    const login = await start();
    const anonymous = await graphql(APPROVE, { code: login.userCode });
    const ownerKey = await graphql(
      APPROVE,
      { code: login.userCode },
      TEST_OWNER_KEY
    );
    const cliKey = await graphql(
      APPROVE,
      { code: login.userCode },
      await signedInCli(await ownerCookie())
    );
    expect(
      [anonymous, ownerKey, cliKey].map(
        (answer) => answer.errors?.[0]?.extensions?.code
      )
    ).toStrictEqual(["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
    const foreign = await graphql(
      APPROVE,
      { code: login.userCode },
      undefined,
      {
        cookie: await ownerCookie(),
        origin: "https://elsewhere.test",
      }
    );
    expect({
      foreign: foreign.status,
      polled: await poll(login.deviceCode),
    }).toStrictEqual({ foreign: 403, polled: { status: "pending" } });
  });

  it("is refused as a GET, or a body that is not JSON", async () => {
    const get = await exports.default.fetch(`${ORIGIN}/auth/cli/start`);
    const form = await exports.default.fetch(`${ORIGIN}/auth/cli/start`, {
      body: "device=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    expect([get.status, form.status]).toStrictEqual([405, 415]);
  });
});

describe("an invited person's CLI", () => {
  beforeEach(fresh);

  it("holds no more than the person's grants, and loses them when the grant goes", async () => {
    await push("acme", shelfOf("acme", false));
    await push("other", shelfOf("other", false));
    const cookie = await invitedPerson("acme", ["read"]);
    const key = await signedInCli(cookie);
    const viewer = await graphql(VIEWER, {}, key);
    expect({
      key: /^skc_p[0-9a-f]{32}_/u.test(key),
      viewer: viewer.data,
    }).toMatchObject({
      key: true,
      viewer: { viewer: { authenticated: true, name: "Ada", owner: false } },
    });
    const shelves = async () => {
      const answer = await graphql(
        '{ acme: shelf(id: "acme") { id } other: shelf(id: "other") { id } }',
        {},
        key
      );
      return answer.data;
    };
    await expect(shelves()).resolves.toStrictEqual({
      acme: { id: "acme" },
      other: null,
    });
    // A read grant writes nothing, through the key as through the browser.
    const upload = await exports.default.fetch(
      `${ORIGIN}/raw/acme/objects/${"0".repeat(64)}`,
      { body: "", headers: { authorization: `Bearer ${key}` }, method: "PUT" }
    );
    const created = await graphql(
      `
        mutation {
          createKey(shelf: "acme", name: "x", scopes: ["read"]) {
            secret
          }
        }
      `,
      {},
      key
    );
    expect({
      created: created.errors?.[0]?.extensions?.code,
      upload: upload.status,
    }).toStrictEqual({ created: "FORBIDDEN", upload: 403 });
    const principal = await principalOf(key);
    await graphql(
      `
        mutation ($principal: ID!) {
          revokeAccess(shelf: "acme", principal: $principal)
        }
      `,
      { principal },
      TEST_OWNER_KEY
    );
    await expect(shelves()).resolves.toStrictEqual({ acme: null, other: null });
  });

  it("is signed out when the owner removes the person", async () => {
    await push("acme", shelfOf("acme", false));
    const cookie = await invitedPerson("acme", ["read"]);
    const key = await signedInCli(cookie);
    const principal = await principalOf(key);
    const removed = await graphql(
      `
        mutation ($principal: ID!) {
          removePerson(shelf: "acme", principal: $principal)
        }
      `,
      { principal },
      TEST_OWNER_KEY
    );
    const viewer = await graphql(VIEWER, {}, key);
    expect({ removed: removed.data, viewer: viewer.status }).toStrictEqual({
      removed: { removePerson: true },
      viewer: 401,
    });
  });
});
