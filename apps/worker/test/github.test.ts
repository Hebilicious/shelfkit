/**
 * Signing the browser in with GitHub, end to end: `/auth/github/start`, the stand-in GitHub's authorize page, and
 * `/auth/github/callback`, then the session cookie on GraphQL and `/raw`. The Worker's outbound `fetch` to GitHub is
 * answered by `FakeGitHub`; everything else is the real Worker.
 */
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signSession } from "../src/auth/browser.ts";
import { githubRoute } from "../src/auth/github.ts";
import {
  FAKE_ACCOUNTS,
  FakeGitHub,
  TEST_GITHUB,
  TEST_SESSION_SECRET,
} from "./fake-github.ts";
import {
  createKey,
  data,
  graphql,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

let github = new FakeGitHub(TEST_GITHUB.web, TEST_GITHUB.api);

/** Every test starts from nothing, with the Worker's outbound `fetch` to GitHub answered by a fresh stand-in. */
function standInGitHub(): void {
  beforeEach(fresh);
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
  github = new FakeGitHub(TEST_GITHUB.web, TEST_GITHUB.api);
  const platform = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return github.handles(request.url)
      ? await github.fetch(request)
      : await platform(request);
  });
}

/** A cookie's `name=value` from a response's `Set-Cookie` headers, with its attributes. */
function setCookie(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`));
}

function cookiePair(cookie: string | undefined): string {
  return (cookie ?? "").split(";")[0] ?? "";
}

const SESSION = "__Host-shelfkit_session";
const STATE = "__Host-shelfkit_oauth";

async function visit(url: string, cookie?: string): Promise<Response> {
  const response = await exports.default.fetch(url, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: "manual",
  });
  await response.arrayBuffer();
  return response;
}

/** `/auth/github/start`: GitHub's authorize URL, and the state cookie it binds the sign-in to. */
async function start(next = "/") {
  const started = await visit(
    `${ORIGIN}/auth/github/start?next=${encodeURIComponent(next)}`
  );
  expect(started.status).toBe(302);
  return {
    authorize: new URL(started.headers.get("location") ?? ""),
    stateCookie: setCookie(started, STATE),
  };
}

/** The whole flow as `login`: the callback's response. */
async function signInAs(login: string, next = "/") {
  const { authorize, stateCookie } = await start(next);
  const callback = github.approve(authorize, login);
  const finished = await visit(callback, cookiePair(stateCookie));
  return { callback, finished, stateCookie };
}

/** The session cookie a complete sign-in as `login` sets, as a `Cookie` header. */
async function sessionAs(login: string): Promise<string> {
  const { finished } = await signInAs(login);
  const cookie = setCookie(finished, SESSION);
  expect(cookie).toBeDefined();
  return cookiePair(cookie);
}

const ViewerSchema = v.object({
  shelves: v.array(v.object({ id: v.string() })),
  viewer: v.object({
    authenticated: v.boolean(),
    githubId: v.nullable(v.string()),
    login: v.nullable(v.string()),
    owner: v.boolean(),
  }),
});

const VIEWER =
  "{ viewer { authenticated owner login githubId } shelves { id } }";

/** GraphQL as the browser sends it: the cookie, from this origin. */
async function asBrowser(
  cookie: string,
  query: string,
  variables: Parameters<typeof graphql>[1] = {}
) {
  return await graphql(query, variables, undefined, { cookie, origin: ORIGIN });
}

async function viewerOf(cookie: string) {
  const answer = await asBrowser(cookie, VIEWER);
  return v.parse(ViewerSchema, answer.data);
}

describe("signing in with GitHub", () => {
  standInGitHub();

  it("starts at GitHub's authorize page with a state and an S256 PKCE challenge, bound to a Lax, HttpOnly cookie", async () => {
    const { authorize, stateCookie } = await start();
    const challenge = /^[A-Za-z0-9_-]{43}$/u;
    expect({
      at: `${authorize.origin}${authorize.pathname}`,
      challenge: challenge.test(
        authorize.searchParams.get("code_challenge") ?? ""
      ),
      method: authorize.searchParams.get("code_challenge_method"),
      redirect: authorize.searchParams.get("redirect_uri"),
      scope: authorize.searchParams.get("scope"),
      state: challenge.test(authorize.searchParams.get("state") ?? ""),
    }).toStrictEqual({
      at: `${TEST_GITHUB.web}/login/oauth/authorize`,
      challenge: true,
      method: "S256",
      redirect: `${ORIGIN}/auth/github/callback`,
      scope: null,
      state: true,
    });
    expect(stateCookie).toMatch(
      /^__Host-shelfkit_oauth=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/u
    );
  });

  it("signs the owner's account in as the owner, with a Strict, HttpOnly session cookie, and returns to where it started", async () => {
    const { finished } = await signInAs(
      FAKE_ACCOUNTS.owner.login,
      "/shelves/acme/prompts"
    );
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe("/shelves/acme/prompts");
    const session = setCookie(finished, SESSION);
    expect(session).toMatch(
      /^__Host-shelfkit_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/u
    );
    expect(setCookie(finished, STATE)).toContain("Max-Age=0");

    await push("acme", shelfOf("acme", false));
    const viewer = await viewerOf(cookiePair(session));
    expect(viewer).toStrictEqual({
      shelves: [{ id: "acme" }],
      viewer: {
        authenticated: true,
        githubId: String(FAKE_ACCOUNTS.owner.id),
        login: FAKE_ACCOUNTS.owner.login,
        owner: true,
      },
    });
  });

  it("never keeps the GitHub token: it is revoked once read, and the cookie holds only the account", async () => {
    const before = await env.BLOBS.list();
    const { finished } = await signInAs(FAKE_ACCOUNTS.ada.login);
    const tokens = [...github.tokens.entries()];
    expect(tokens).toHaveLength(1);
    const [token, issued] = tokens[0] ?? ["", { revoked: false }];
    expect(issued.revoked).toBeTruthy();

    const cookie = cookiePair(setCookie(finished, SESSION));
    expect(cookie).not.toContain(token);
    const [payload] = cookie.slice(`${SESSION}=`.length).split(".");
    const claims: unknown = JSON.parse(
      atob((payload ?? "").replaceAll("-", "+").replaceAll("_", "/"))
    );
    expect(Object.keys(claims ?? {}).toSorted()).toStrictEqual([
      "exp",
      "login",
      "sub",
      "v",
    ]);
    // Signing in writes nothing to storage.
    const after = await env.BLOBS.list();
    expect(after.objects).toStrictEqual(before.objects);
  });

  it("refuses a callback whose state is not the one this browser started with", async () => {
    const first = await start();
    const second = await start();
    // The code and state of one sign-in, arriving in a browser that started another: another site's sign-in.
    const callback = github.approve(first.authorize, FAKE_ACCOUNTS.ada.login);
    const finished = await visit(callback, cookiePair(second.stateCookie));
    expect(finished.headers.get("location")).toBe("/sign-in?error=state");
    expect(setCookie(finished, SESSION)).toBeUndefined();
  });

  it("refuses a callback with no state cookie, or a forged one", async () => {
    const { authorize } = await start();
    const callback = github.approve(authorize, FAKE_ACCOUNTS.ada.login);
    const bare = await visit(callback);
    expect(bare.headers.get("location")).toBe("/sign-in?error=state");
    const forged = await visit(callback, `${STATE}=e30.AAAA`);
    expect(forged.headers.get("location")).toBe("/sign-in?error=state");
    expect(setCookie(forged, SESSION)).toBeUndefined();
  });

  it("refuses a code issued for another PKCE challenge", async () => {
    const first = await start();
    const second = await start();
    // The second sign-in's state, with a code issued against the first one's challenge: an injected code.
    const injected = new URL(first.authorize);
    injected.searchParams.set(
      "state",
      second.authorize.searchParams.get("state") ?? ""
    );
    const callback = github.approve(injected, FAKE_ACCOUNTS.ada.login);
    const finished = await visit(callback, cookiePair(second.stateCookie));
    expect(finished.headers.get("location")).toBe("/sign-in?error=github");
    expect(setCookie(finished, SESSION)).toBeUndefined();
  });

  it("refuses a code used a second time", async () => {
    const { callback, finished, stateCookie } = await signInAs(
      FAKE_ACCOUNTS.ada.login
    );
    expect(setCookie(finished, SESSION)).toBeDefined();
    const replayed = await visit(callback, cookiePair(stateCookie));
    expect(replayed.headers.get("location")).toBe("/sign-in?error=github");
    expect(setCookie(replayed, SESSION)).toBeUndefined();
  });

  it("says so when the person refuses at GitHub", async () => {
    const { authorize, stateCookie } = await start();
    const cancel = new URL(`${TEST_GITHUB.web}/login/oauth/cancel`);
    cancel.searchParams.set(
      "redirect_uri",
      authorize.searchParams.get("redirect_uri") ?? ""
    );
    cancel.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const back = await github.fetch(new Request(cancel));
    const finished = await visit(
      back.headers.get("location") ?? "",
      cookiePair(stateCookie)
    );
    expect(finished.headers.get("location")).toBe("/sign-in?error=denied");
  });

  it("returns only to a path on this origin", async () => {
    for (const next of [
      "//evil.example/x",
      "https://evil.example",
      "/\\evil",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one sign-in after another.
      const { finished } = await signInAs(FAKE_ACCOUNTS.ada.login, next);
      expect(finished.headers.get("location")).toBe("/");
    }
  });

  it("says the deployment is not set up when it has no GitHub client", async () => {
    const answer = await githubRoute(
      new Request(`${ORIGIN}/auth/github/start`),
      { ...env, GITHUB_CLIENT_SECRET: "" }
    );
    expect(answer.headers.get("location")).toBe("/sign-in?error=unconfigured");
  });
});

describe("the session cookie", () => {
  standInGitHub();

  it("that was tampered with, expired, or signed with another secret is anonymous, and cleared", async () => {
    const good = await sessionAs(FAKE_ACCOUNTS.ada.login);
    const [payload, signature] = good.slice(`${SESSION}=`.length).split(".");
    const owner = btoa(
      JSON.stringify({
        exp: 4_000_000_000,
        login: "shelf-owner",
        sub: String(FAKE_ACCOUNTS.owner.id),
        v: 1,
      })
    ).replace(/=+$/u, "");
    const expired = await signSession(
      TEST_SESSION_SECRET,
      { id: String(FAKE_ACCOUNTS.owner.id), login: "shelf-owner" },
      Date.now() - 31 * 24 * 60 * 60 * 1000
    );
    const rotated = await signSession("another-secret", {
      id: String(FAKE_ACCOUNTS.owner.id),
      login: "shelf-owner",
    });
    for (const token of [
      `${owner}.${signature}`,
      `${payload}.${signature}x`,
      expired,
      rotated,
      "garbage",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one cookie after another.
      const answer = await asBrowser(`${SESSION}=${token}`, VIEWER);
      expect(
        v.parse(ViewerSchema, answer.data).viewer.authenticated
      ).toBeFalsy();
      expect(answer.headers.get("set-cookie")).toContain("Max-Age=0");
    }
  });

  it("is cleared by signOut", async () => {
    const cookie = await sessionAs(FAKE_ACCOUNTS.owner.login);
    const signedOut = await asBrowser(cookie, "mutation { signOut }");
    expect(signedOut.headers.get("set-cookie")).toMatch(
      /^__Host-shelfkit_session=; .*Max-Age=0$/u
    );
  });

  it("authenticates no POST from another origin", async () => {
    const cookie = await sessionAs(FAKE_ACCOUNTS.owner.login);
    const answer = await graphql("mutation { signOut }", {}, undefined, {
      cookie,
      origin: "https://evil.example",
    });
    expect(answer.status).toBe(403);
  });

  it("reads the owner's private shelf's objects on /raw, as the engine preview does", async () => {
    await push("acme", shelfOf("acme", false));
    const manifest = new TextEncoder().encode(
      `${JSON.stringify({ name: "acme", registry: { namespace: "acme", public: false } }, null, 2)}\n`
    );
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", manifest)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const path = `${ORIGIN}/raw/acme/objects/${digest}`;
    const anonymous = await visit(path);
    expect(anonymous.status).toBe(401);
    const owner = await visit(path, await sessionAs(FAKE_ACCOUNTS.owner.login));
    expect(owner.status).toBe(200);
  });
});

const GrantSchema = v.object({
  grantAccess: v.object({
    githubId: v.string(),
    login: v.string(),
    scopes: v.array(v.string()),
  }),
});

const GRANT = `mutation Grant($shelf: ID!, $login: String!, $scopes: [String!]!) {
  grantAccess(shelf: $shelf, login: $login, scopes: $scopes) { githubId login scopes }
}`;

/** The error the owner's grant of `scopes` on `acme` to `login` is refused with. */
async function refusal(login: string, scopes: readonly string[]) {
  const answer = await graphql(
    GRANT,
    { login, scopes, shelf: "acme" },
    TEST_OWNER_KEY
  );
  return answer.errors?.[0];
}

const SHELF = `query Shelf($shelf: ID!) {
  shelf(id: $shelf) { id viewerAccess { read write owner member } }
}`;

const ShelfSchema = v.object({
  shelf: v.nullable(
    v.object({
      id: v.string(),
      viewerAccess: v.object({
        member: v.boolean(),
        owner: v.boolean(),
        read: v.boolean(),
        write: v.boolean(),
      }),
    })
  ),
});

describe("a GitHub account that is not the owner", () => {
  standInGitHub();

  it("without a grant is signed in and holds nothing: no shelves, no private shelf, no writes", async () => {
    await push("acme", shelfOf("acme", false));
    const cookie = await sessionAs(FAKE_ACCOUNTS.ada.login);
    await expect(viewerOf(cookie)).resolves.toStrictEqual({
      shelves: [],
      viewer: {
        authenticated: true,
        githubId: String(FAKE_ACCOUNTS.ada.id),
        login: "ada",
        owner: false,
      },
    });
    const shelf = await asBrowser(cookie, SHELF, { shelf: "acme" });
    expect(shelf.data).toStrictEqual({ shelf: null });
    const write = await asBrowser(
      cookie,
      `mutation { setVisibility(shelf: "acme", public: true) { ok } }`
    );
    expect(write.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  it("holds what the owner grants it, on that shelf only", async () => {
    await push("acme", shelfOf("acme", false));
    await push("other", shelfOf("other", false));
    const cookie = await sessionAs(FAKE_ACCOUNTS.ada.login);
    const granted = await data(GrantSchema, GRANT, {
      login: "ADA",
      scopes: ["read", "publish:acme/*"],
      shelf: "acme",
    });
    expect(granted.grantAccess).toStrictEqual({
      githubId: String(FAKE_ACCOUNTS.ada.id),
      login: "ada",
      scopes: ["read", "publish:acme/*"],
    });
    const reached = await viewerOf(cookie);
    expect(reached.shelves).toStrictEqual([{ id: "acme" }]);
    const answer = await asBrowser(cookie, SHELF, { shelf: "acme" });
    expect(v.parse(ShelfSchema, answer.data).shelf?.viewerAccess).toStrictEqual(
      {
        member: true,
        owner: false,
        read: true,
        write: true,
      }
    );
    const other = await asBrowser(cookie, SHELF, { shelf: "other" });
    expect(other.data).toStrictEqual({ shelf: null });
  });

  it("holds no ownership through a grant: it manages no keys and no grants", async () => {
    await push("acme", shelfOf("acme", false));
    const cookie = await sessionAs(FAKE_ACCOUNTS.ada.login);
    await data(GrantSchema, GRANT, {
      login: "ada",
      scopes: ["read", "publish:acme/*"],
      shelf: "acme",
    });
    const keys = await asBrowser(
      cookie,
      `mutation { createKey(shelf: "acme", name: "x", scopes: ["read"]) { secret } }`
    );
    const regrant = await asBrowser(cookie, GRANT, {
      login: "grace",
      scopes: ["read"],
      shelf: "acme",
    });
    // Favourites are its own, kept under the account.
    const favourite = await asBrowser(
      cookie,
      `mutation { setFavourite(shelf: "acme", item: "nothing", favourite: true) }`
    );
    expect({
      favourite: favourite.errors,
      keys: keys.errors?.[0]?.extensions?.code,
      regrant: regrant.errors?.[0]?.extensions?.code,
    }).toStrictEqual({
      favourite: undefined,
      keys: "FORBIDDEN",
      regrant: "FORBIDDEN",
    });
  });

  it("loses a revoked grant at its next request", async () => {
    await push("acme", shelfOf("acme", false));
    const cookie = await sessionAs(FAKE_ACCOUNTS.ada.login);
    await data(GrantSchema, GRANT, {
      login: "ada",
      scopes: ["read"],
      shelf: "acme",
    });
    const before = await asBrowser(cookie, SHELF, { shelf: "acme" });
    expect(v.parse(ShelfSchema, before.data).shelf?.id).toBe("acme");
    const revoked = await data(
      v.object({ revokeAccess: v.boolean() }),
      "mutation Revoke($shelf: ID!, $id: ID!) { revokeAccess(shelf: $shelf, githubId: $id) }",
      { id: String(FAKE_ACCOUNTS.ada.id), shelf: "acme" }
    );
    expect(revoked.revokeAccess).toBeTruthy();
    const after = await asBrowser(cookie, SHELF, { shelf: "acme" });
    expect(after.data).toStrictEqual({ shelf: null });
    const gone = await viewerOf(cookie);
    expect(gone.shelves).toStrictEqual([]);
  });

  it("is granted only scopes on that shelf, only by its login on GitHub, and never the owner", async () => {
    await push("acme", shelfOf("acme", false));
    const wrongShelf = await refusal("ada", ["read:other/web"]);
    expect(wrongShelf?.extensions?.code).toBe("BAD_USER_INPUT");
    const unknown = await refusal("nobody-here", ["read"]);
    expect(unknown?.message).toContain("GitHub has no account");
    const owner = await refusal("shelf-owner", ["read"]);
    expect(owner?.message).toContain("owns this deployment");
  });

  it("is listed for the owner, and not for a key", async () => {
    await push("acme", shelfOf("acme", false));
    await data(GrantSchema, GRANT, {
      login: "grace",
      scopes: ["read"],
      shelf: "acme",
    });
    const listed = await data(
      v.object({
        shelf: v.object({
          grants: v.array(
            v.object({ login: v.string(), scopes: v.array(v.string()) })
          ),
        }),
      }),
      `{ shelf(id: "acme") { grants { login scopes } } }`
    );
    expect(listed.shelf.grants).toStrictEqual([
      { login: "grace", scopes: ["read"] },
    ]);
    const key = await createKey("acme", ["read"]);
    const asKey = await graphql(
      `
        {
          shelf(id: "acme") {
            grants {
              login
            }
          }
        }
      `,
      {},
      key.secret
    );
    expect(asKey.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
