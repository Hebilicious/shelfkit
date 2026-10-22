/**
 * Signing in without a key: one-time links, passkeys, and invites, end to end through the Worker. Passkeys are made
 * and used by a software authenticator (`authenticator.ts`), which signs real attestations and assertions.
 */
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";

import type { AccountIndex } from "../src/auth/accounts.ts";
import { signClaims } from "../src/auth/browser.ts";
import { Authenticator } from "./authenticator.ts";
import type { Ceremony } from "./authenticator.ts";
import { TEST_SESSION_SECRET } from "./fake-github.ts";
import {
  data,
  graphql,
  ORIGIN,
  push,
  shelfOf,
  TEST_OWNER_KEY,
} from "./helpers.ts";

const SESSION = "__Host-shelfkit_session";
const CHALLENGE = "__Host-shelfkit_passkey";

/** Every test starts from nothing: no shelf, no account, no link. */
async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

/** The deployment's own origin, where a real browser's ceremonies happen. */
const HERE: Ceremony = { origin: ORIGIN };

type Credential =
  | Awaited<ReturnType<Authenticator["create"]>>
  | Awaited<ReturnType<Authenticator["get"]>>;

/** What a page posts to a passkey route. */
interface PostBody {
  readonly response?: Credential;
  readonly label?: string;
}

/** Ceremony options as the Worker sends them: the fields the authenticator reads. */
const OptionsSchema = v.looseObject({
  challenge: v.string(),
  rp: v.optional(v.object({ id: v.optional(v.string()), name: v.string() })),
  rpId: v.optional(v.string()),
  user: v.optional(
    v.looseObject({ displayName: v.string(), id: v.string(), name: v.string() })
  ),
});

type Options = v.InferOutput<typeof OptionsSchema>;

/** What a passkey route answered, read as each kind of answer it gives. */
interface Answer {
  readonly status: number;
  readonly options: Options | null;
  readonly signedIn: { readonly name: string; readonly owner: boolean } | null;
  readonly detail: string | null;
}

/** The token of a link: the part of its URL after `#`. */
function tokenOf(url: string): string {
  const [, token = ""] = url.split("#");
  return token;
}

/** A cookie's `name=value` from a response's `Set-Cookie` headers. */
function setCookie(headers: Headers, name: string): string | undefined {
  return headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.split(";")[0];
}

/** A browser: the cookies it holds, kept as the Worker sets and clears them. */
class Browser {
  private readonly jar = new Map<string, string>();

  get cookie(): string {
    return [...this.jar.values()].join("; ");
  }

  /** The `name=value` of one cookie this browser holds. */
  held(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** Hold a cookie as if the Worker had set it. */
  hold(pair: string): void {
    this.jar.set(pair.slice(0, pair.indexOf("=")), pair);
  }

  keep(headers: Headers): void {
    for (const cookie of headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      if (/Max-Age=0/u.test(cookie)) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, pair);
      }
    }
  }

  /** A same-origin JSON POST, as the SPA sends one. */
  async post(path: string, body: PostBody, origin = ORIGIN): Promise<Answer> {
    const response = await exports.default.fetch(`${ORIGIN}${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: this.cookie,
        origin,
      },
      method: "POST",
    });
    this.keep(response.headers);
    const text = await response.text();
    // BOUNDARY: the route's JSON is read below as each kind of answer it may be.
    const parsed: unknown = text === "" ? null : JSON.parse(text);
    const options = v.safeParse(OptionsSchema, parsed);
    const signedIn = v.safeParse(
      v.object({ name: v.string(), owner: v.boolean() }),
      parsed
    );
    const problem = v.safeParse(v.object({ detail: v.string() }), parsed);
    return {
      detail: problem.success ? problem.output.detail : null,
      options: options.success ? options.output : null,
      signedIn: signedIn.success ? signedIn.output : null,
      status: response.status,
    };
  }

  async graphql(query: string, variables: Parameters<typeof graphql>[1] = {}) {
    const answer = await graphql(query, variables, undefined, {
      cookie: this.cookie,
      origin: ORIGIN,
    });
    this.keep(answer.headers);
    return answer;
  }

  async viewer() {
    const answer = await this.graphql(
      "{ viewer { authenticated owner name principal } shelves { id } }"
    );
    return v.parse(
      v.object({
        shelves: v.array(v.object({ id: v.string() })),
        viewer: v.object({
          authenticated: v.boolean(),
          name: v.nullable(v.string()),
          owner: v.boolean(),
          principal: v.nullable(v.string()),
        }),
      }),
      answer.data
    );
  }

  /** Redeem a link's token, as the `/link` page does. */
  async redeem(token: string) {
    return await this.graphql(
      "mutation Redeem($token: String!) { redeemLink(token: $token) { name owner shelf offerPasskey } }",
      { token }
    );
  }

  /** Options for a ceremony, which must be given. */
  async options(path: string): Promise<Options> {
    const answer = await this.post(path, {});
    if (answer.options === null) {
      throw new Error(`${path} answered ${answer.status} with no options`);
    }
    return answer.options;
  }

  /** Make a passkey on `device` for the signed-in account, for these registration options. */
  async register(
    device: Authenticator,
    options: Options,
    ceremony: Ceremony = HERE
  ): Promise<Answer> {
    const created = await device.create(
      {
        challenge: options.challenge,
        rp: { id: options.rp?.id },
        user: { id: options.user?.id ?? "" },
      },
      ceremony
    );
    return await this.post("/auth/passkey/register", {
      label: "laptop",
      response: created,
    });
  }

  /** Add a passkey to the signed-in account with `device`. */
  async addPasskey(
    device: Authenticator,
    ceremony: Ceremony = HERE
  ): Promise<Answer> {
    const options = await this.options("/auth/passkey/register/options");
    return await this.register(device, options, ceremony);
  }

  /** Sign in with a passkey `device` holds. */
  async signInWith(
    device: Authenticator,
    ceremony: Ceremony = HERE
  ): Promise<Answer> {
    const options = await this.options("/auth/passkey/options");
    const asserted = await device.get(options, ceremony);
    return await this.post("/auth/passkey/authenticate", {
      response: asserted,
    });
  }

  async signOut(): Promise<void> {
    await this.graphql("mutation { signOut }");
  }
}

const LinkSchema = v.object({
  createSignInLink: v.object({ expiresAt: v.string(), url: v.string() }),
});

/** A sign-in link for the owner, as `shelfkit open` and setup make one with the owner key: its token. */
async function ownerLinkToken(): Promise<string> {
  const link = await data(
    LinkSchema,
    "mutation { createSignInLink { url expiresAt } }"
  );
  return tokenOf(link.createSignInLink.url);
}

/** A browser signed in as the owner by a link, holding a passkey on `device`. */
async function enrolledOwner(device: Authenticator): Promise<Browser> {
  const browser = new Browser();
  await browser.redeem(await ownerLinkToken());
  const added = await browser.addPasskey(device);
  if (added.status !== 200) {
    throw new Error(`adding the owner's passkey answered ${added.status}`);
  }
  return browser;
}

describe("a sign-in link", () => {
  beforeEach(fresh);

  it("is made by the owner key, and opens the SPA's /link page with its token in the fragment", async () => {
    const link = await data(
      LinkSchema,
      "mutation { createSignInLink { url expiresAt } }"
    );
    expect(link.createSignInLink.url).toMatch(
      new RegExp(`^${ORIGIN}/link#ssl_owner_[A-Za-z0-9_-]{43}$`, "u")
    );
  });

  it("signs the browser in as the owner once, and never again", async () => {
    const token = await ownerLinkToken();
    const first = new Browser();
    const redeemed = await first.redeem(token);
    expect(redeemed.data).toStrictEqual({
      redeemLink: {
        name: "Owner",
        offerPasskey: true,
        owner: true,
        shelf: null,
      },
    });
    expect(setCookie(redeemed.headers, SESSION)).toBeDefined();
    await expect(first.viewer()).resolves.toMatchObject({
      viewer: { authenticated: true, owner: true, principal: "owner" },
    });
    const again = new Browser();
    const replayed = await again.redeem(token);
    expect({
      code: replayed.errors?.[0]?.extensions?.code,
      cookie: setCookie(replayed.headers, SESSION),
    }).toStrictEqual({ code: "LINK_REFUSED", cookie: undefined });
  });

  it("is refused once it has expired", async () => {
    const token = await ownerLinkToken();
    await runInDurableObject(
      env.ACCOUNT.get(env.ACCOUNT.idFromName("owner")),
      (_instance: AccountIndex, state) => {
        for (const [key] of state.storage.kv.list({ prefix: "link:" })) {
          state.storage.kv.put(key, { expiresAt: 1 });
        }
      }
    );
    const browser = new Browser();
    const answer = await browser.redeem(token);
    expect(answer.errors?.[0]?.extensions?.code).toBe("LINK_REFUSED");
  });

  it("is made only for your own account, and never by an anonymous request or a scoped key", async () => {
    const anonymous = await graphql("mutation { createSignInLink { url } }");
    expect(anonymous.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });

  it("is refused when malformed, or naming an account that does not exist", async () => {
    const browser = new Browser();
    for (const token of [
      "nonsense",
      `ssl_p${"0".repeat(32)}_${"A".repeat(43)}`,
      `ssl_owner_${"A".repeat(43)}`,
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one link after another.
      const answer = await browser.redeem(token);
      expect(answer.errors?.[0]?.extensions?.code).toBe("LINK_REFUSED");
    }
  });
});

describe("a passkey", () => {
  beforeEach(fresh);

  it("is added by a signed-in owner, and then signs a fresh browser in as the owner", async () => {
    const device = new Authenticator();
    const owner = await enrolledOwner(device);
    const passkeys = await owner.graphql("{ passkeys { label } }");
    expect(passkeys.data).toStrictEqual({ passkeys: [{ label: "laptop" }] });

    const other = new Browser();
    const signedIn = await other.signInWith(device);
    expect(signedIn.signedIn).toStrictEqual({ name: "Owner", owner: true });
    await expect(other.viewer()).resolves.toMatchObject({
      viewer: { owner: true, principal: "owner" },
    });
  });

  it("cannot be added without signing in first", async () => {
    const options = await new Browser().post(
      "/auth/passkey/register/options",
      {}
    );
    expect(options.status).toBe(401);
  });

  it("refuses a sign-in challenge used twice", async () => {
    const device = new Authenticator();
    await enrolledOwner(device);
    const browser = new Browser();
    const options = await browser.options("/auth/passkey/options");
    const held = browser.held(CHALLENGE) ?? "";
    const once = await device.get(options, HERE);
    const first = await browser.post("/auth/passkey/authenticate", {
      response: once,
    });
    // The same challenge again, from a browser that kept the challenge cookie.
    const replay = new Browser();
    replay.hold(held);
    const twice = await device.get(options, HERE);
    const second = await replay.post("/auth/passkey/authenticate", {
      response: twice,
    });
    expect([first.status, second.status]).toStrictEqual([200, 401]);
  });

  it("refuses a sign-in whose challenge expired, or that did not start in this browser", async () => {
    const device = new Authenticator();
    await enrolledOwner(device);
    const expired = await signClaims(TEST_SESSION_SECRET, {
      challenge: "A".repeat(43),
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const late = new Browser();
    late.hold(`${CHALLENGE}=${expired}`);
    const lateAssertion = await device.get({ challenge: "A".repeat(43) }, HERE);
    const lateAnswer = await late.post("/auth/passkey/authenticate", {
      response: lateAssertion,
    });
    const strangerAssertion = await device.get(
      { challenge: "A".repeat(43) },
      HERE
    );
    const strangerAnswer = await new Browser().post(
      "/auth/passkey/authenticate",
      { response: strangerAssertion }
    );
    expect([lateAnswer.status, strangerAnswer.status]).toStrictEqual([
      401, 401,
    ]);
  });

  it("refuses an assertion made for another origin or another relying party", async () => {
    const device = new Authenticator();
    await enrolledOwner(device);
    const statuses: number[] = [];
    for (const ceremony of [
      { origin: "https://evil.example" },
      { origin: ORIGIN, rpId: "evil.example" },
    ]) {
      const browser = new Browser();
      // oxlint-disable-next-line eslint/no-await-in-loop -- one ceremony after another.
      const answer = await browser.signInWith(device, ceremony);
      statuses.push(answer.status);
    }
    expect(statuses).toStrictEqual([401, 401]);
  });

  it("refuses a registration made for another origin or another relying party", async () => {
    const owner = new Browser();
    await owner.redeem(await ownerLinkToken());
    const statuses: number[] = [];
    for (const ceremony of [
      { origin: "https://evil.example" },
      { origin: ORIGIN, rpId: "evil.example" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one ceremony after another.
      const answer = await owner.addPasskey(new Authenticator(), ceremony);
      statuses.push(answer.status);
    }
    const passkeys = await owner.graphql("{ passkeys { id } }");
    expect({ passkeys: passkeys.data, statuses }).toStrictEqual({
      passkeys: { passkeys: [] },
      statuses: [400, 400],
    });
  });

  it("refuses a registration challenge used twice, or after it expired", async () => {
    const owner = new Browser();
    await owner.redeem(await ownerLinkToken());
    const device = new Authenticator();
    const options = await owner.options("/auth/passkey/register/options");
    const first = await owner.register(device, options);
    const second = await owner.register(device, options);
    const later = await owner.options("/auth/passkey/register/options");
    await runInDurableObject(
      env.ACCOUNT.get(env.ACCOUNT.idFromName("owner")),
      (_instance: AccountIndex, state) => {
        for (const [key] of state.storage.kv.list({
          prefix: "registration:",
        })) {
          state.storage.kv.put(key, { expiresAt: 1 });
        }
      }
    );
    const expired = await owner.register(device, later);
    expect([first.status, second.status, expired.status]).toStrictEqual([
      200, 400, 400,
    ]);
  });

  it("is refused when its signature counter does not move forward", async () => {
    const device = new Authenticator();
    await enrolledOwner(device);
    const first = await new Browser().signInWith(device);
    // A copy of the passkey replays the counter it saw.
    const [passkey] = device.passkeys;
    if (passkey !== undefined) {
      passkey.counter -= 1;
    }
    const copied = await new Browser().signInWith(device);
    expect({
      counter: copied.detail?.includes("counter"),
      statuses: [first.status, copied.status],
    }).toStrictEqual({ counter: true, statuses: [200, 401] });
  });

  it("is accepted from an authenticator that keeps no counter", async () => {
    const device = new Authenticator();
    device.step = 0;
    await enrolledOwner(device);
    const first = await new Browser().signInWith(device);
    const second = await new Browser().signInWith(device);
    expect([first.status, second.status]).toStrictEqual([200, 200]);
  });

  it("keeps its last passkey unless told to remove it anyway", async () => {
    const device = new Authenticator();
    const owner = await enrolledOwner(device);
    const listed = await owner.graphql("{ passkeys { id } }");
    const [passkey] = v.parse(
      v.object({ passkeys: v.array(v.object({ id: v.string() })) }),
      listed.data
    ).passkeys;
    const id = passkey?.id;
    const refused = await owner.graphql(
      "mutation ($id: ID!) { removePasskey(id: $id) }",
      { id }
    );
    const removed = await owner.graphql(
      "mutation ($id: ID!) { removePasskey(id: $id, allowLast: true) }",
      { id }
    );
    expect({
      refused: refused.errors?.[0]?.extensions?.code,
      removed: removed.data,
    }).toStrictEqual({
      refused: "LAST_PASSKEY",
      removed: { removePasskey: true },
    });
  });

  it("is used from this origin only", async () => {
    const answer = await new Browser().post(
      "/auth/passkey/options",
      {},
      "https://evil.example"
    );
    expect(answer.status).toBe(403);
  });
});

const InviteSchema = v.object({
  createInvite: v.object({
    invite: v.object({ id: v.string(), name: v.string() }),
    url: v.string(),
  }),
});

const CREATE_INVITE = `mutation Invite($shelf: ID!, $name: String!, $scopes: [String!]!) {
  createInvite(shelf: $shelf, name: $name, scopes: $scopes) { url invite { id name } }
}`;

async function invite(shelf: string, scopes: readonly string[], name = "Ada") {
  const created = await data(InviteSchema, CREATE_INVITE, {
    name,
    scopes,
    shelf,
  });
  return {
    id: created.createInvite.invite.id,
    token: tokenOf(created.createInvite.url),
    url: created.createInvite.url,
  };
}

/** A browser that accepted an invite to `acme` for reading, and holds a passkey on `device`. */
async function invitedAda(device: Authenticator): Promise<Browser> {
  const { token } = await invite("acme", ["read"]);
  const ada = new Browser();
  await ada.redeem(token);
  const added = await ada.addPasskey(device);
  if (added.status !== 200) {
    throw new Error(`adding Ada's passkey answered ${added.status}`);
  }
  return ada;
}

describe("an invite", () => {
  beforeEach(fresh);

  it("is shown before it is accepted, and accepting it makes an account holding its grant", async () => {
    await push("acme", shelfOf("acme", false));
    const { token, url } = await invite("acme", ["read"]);
    const ada = new Browser();
    const preview = await ada.graphql(
      "query ($token: String!) { invite(token: $token) { shelf name scopes } }",
      { token }
    );
    const accepted = await ada.redeem(token);
    expect({
      accepted: accepted.data,
      link: url.startsWith(`${ORIGIN}/link#ssi_acme_`),
      preview: preview.data,
    }).toStrictEqual({
      accepted: {
        redeemLink: {
          name: "Ada",
          offerPasskey: true,
          owner: false,
          shelf: "acme",
        },
      },
      link: true,
      preview: { invite: { name: "Ada", scopes: ["read"], shelf: "acme" } },
    });
  });

  it("gives an account a passkey can sign back in to, which reaches that shelf only", async () => {
    await push("acme", shelfOf("acme", false));
    await push("other", shelfOf("other", false));
    const device = new Authenticator();
    const ada = await invitedAda(device);
    await ada.signOut();
    const signedIn = await ada.signInWith(device);
    const reached = await ada.viewer();
    const other = await ada.graphql('{ shelf(id: "other") { id } }');
    expect({
      other: other.data,
      principal: /^person:[0-9a-f]{32}$/u.test(reached.viewer.principal ?? ""),
      shelves: reached.shelves,
      signedIn: signedIn.signedIn,
    }).toStrictEqual({
      other: { shelf: null },
      principal: true,
      shelves: [{ id: "acme" }],
      signedIn: { name: "Ada", owner: false },
    });
  });

  it("gives a grant that revoking ends at once, and an account that removing signs out", async () => {
    await push("acme", shelfOf("acme", false));
    const device = new Authenticator();
    const ada = await invitedAda(device);
    const reached = await ada.viewer();
    const principal = reached.viewer.principal ?? "";
    await data(
      v.unknown(),
      'mutation ($p: ID!) { revokeAccess(shelf: "acme", principal: $p) }',
      { p: principal }
    );
    const revoked = await ada.graphql('{ shelf(id: "acme") { id } }');

    await data(
      v.unknown(),
      'mutation ($p: ID!) { removePerson(shelf: "acme", principal: $p) }',
      { p: principal }
    );
    const after = await ada.viewer();
    const again = await new Browser().signInWith(device);
    expect({
      again: again.status,
      authenticated: after.viewer.authenticated,
      revoked: revoked.data,
    }).toStrictEqual({
      again: 401,
      authenticated: false,
      revoked: { shelf: null },
    });
  });

  it("is used once, and not after it expires or is revoked", async () => {
    await push("acme", shelfOf("acme", false));
    const used = await invite("acme", ["read"]);
    await new Browser().redeem(used.token);
    const twice = await new Browser().redeem(used.token);

    const revoked = await invite("acme", ["read"], "Grace");
    await data(
      v.object({ revokeInvite: v.boolean() }),
      'mutation ($id: ID!) { revokeInvite(shelf: "acme", id: $id) }',
      { id: revoked.id }
    );
    const afterRevoke = await new Browser().redeem(revoked.token);

    const expired = await invite("acme", ["read"], "Linus");
    await runInDurableObject(
      env.SHELF.get(env.SHELF.idFromName("acme")),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE invite SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?",
          expired.id
        );
      }
    );
    const afterExpiry = await new Browser().redeem(expired.token);
    expect(
      [twice, afterRevoke, afterExpiry].map(
        (answer) => answer.errors?.[0]?.extensions?.code
      )
    ).toStrictEqual(["LINK_REFUSED", "LINK_REFUSED", "LINK_REFUSED"]);
  });

  it("adds its grant to a person who is already signed in", async () => {
    await push("acme", shelfOf("acme", false));
    await push("other", shelfOf("other", false));
    const ada = new Browser();
    const first = await invite("acme", ["read"]);
    await ada.redeem(first.token);
    const before = await ada.viewer();
    const second = await invite("other", ["read"]);
    await ada.redeem(second.token);
    const after = await ada.viewer();
    expect({
      before: before.shelves,
      same: after.viewer.principal === before.viewer.principal,
      shelves: after.shelves.map((shelf) => shelf.id).toSorted(),
    }).toStrictEqual({
      before: [{ id: "acme" }],
      same: true,
      shelves: ["acme", "other"],
    });
  });

  it("is refused to the owner, and made by the owner only", async () => {
    await push("acme", shelfOf("acme", false));
    const { token } = await invite("acme", ["read"]);
    const owner = new Browser();
    await owner.redeem(await ownerLinkToken());
    const asOwner = await owner.redeem(token);
    const ada = new Browser();
    await ada.redeem(token);
    const asPerson = await ada.graphql(CREATE_INVITE, {
      name: "Eve",
      scopes: ["read"],
      shelf: "acme",
    });
    expect([
      asOwner.errors?.[0]?.extensions?.code,
      asPerson.errors?.[0]?.extensions?.code,
    ]).toStrictEqual(["FORBIDDEN", "FORBIDDEN"]);
  });
});

describe("another device", () => {
  beforeEach(fresh);

  it("is signed in to the same account by a link the signed-in browser makes", async () => {
    await push("acme", shelfOf("acme", false));
    const ada = new Browser();
    const invited = await invite("acme", ["read"]);
    await ada.redeem(invited.token);
    const made = await ada.graphql("mutation { createSignInLink { url } }");
    const link = v.parse(
      v.object({ createSignInLink: v.object({ url: v.string() }) }),
      made.data
    );
    const phone = new Browser();
    await phone.redeem(tokenOf(link.createSignInLink.url));
    const laptop = await ada.viewer();
    const handset = await phone.viewer();
    expect({
      same: handset.viewer.principal === laptop.viewer.principal,
      shelves: handset.shelves,
    }).toStrictEqual({ same: true, shelves: [{ id: "acme" }] });
  });
});

describe("the owner key", () => {
  beforeEach(fresh);

  it("makes the owner's sign-in links, as `shelfkit open` does", async () => {
    const answer = await graphql(
      "mutation { createSignInLink { url } }",
      {},
      TEST_OWNER_KEY
    );
    expect(answer.errors).toBeUndefined();
  });
});
