/**
 * A stand-in GitHub for signing in, for tests only: the Worker tests answer its outbound `fetch` with it, and the
 * Playwright specs run it as a local server (`apps/web/test/e2e/fake-github-server.ts`). The Worker reaches it only
 * because the test configurations point `GITHUB_URL` and `GITHUB_API_URL` at it; production code has no branch for it.
 *
 * It does what the Worker relies on GitHub to do, strictly:
 * - `GET /login/oauth/authorize` lists its accounts to sign in as (and a way to refuse), and requires an S256 PKCE
 *   challenge;
 * - `POST /login/oauth/access_token` answers a code once only, for its client, its redirect URI, and the verifier
 *   whose challenge it was issued with, and otherwise `{ "error": "bad_verification_code" }` as GitHub does;
 * - `GET /user` with a live token, `GET /users/{login}`, and `DELETE /applications/{client_id}/token` to revoke one.
 */
import * as v from "valibot";

/** A GitHub account the stand-in knows. */
export interface FakeAccount {
  readonly id: number;
  readonly login: string;
}

/** The accounts every test configuration uses. `owner` is the deployment's owner (`OWNER_GITHUB_ID`). */
export const FAKE_ACCOUNTS = {
  ada: { id: 1002, login: "ada" },
  grace: { id: 1003, login: "grace" },
  owner: { id: 1001, login: "shelf-owner" },
} as const satisfies Record<string, FakeAccount>;

/** Looking this login up answers as GitHub does once its rate limit has run out. */
export const RATE_LIMITED_LOGIN = "rate-limited";

/** The client the Worker under test is configured with. Test values only. */
export const FAKE_CLIENT = {
  id: "Iv1.testclient",
  secret: "test-client-secret",
} as const;

/** Where the Worker tests' stand-in answers: `vitest.config.ts` points `GITHUB_URL` and `GITHUB_API_URL` here. */
export const TEST_GITHUB = {
  api: "https://api.github.test",
  web: "https://github.test",
} as const;

/** The session signing secret the Worker under test is configured with. A test value only. */
export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

interface IssuedCode {
  readonly account: FakeAccount;
  readonly redirectUri: string;
  readonly challenge: string;
  used: boolean;
}

interface IssuedToken {
  readonly account: FakeAccount;
  revoked: boolean;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function randomText(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export class FakeGitHub {
  readonly web: string;
  readonly api: string;
  readonly accounts: readonly FakeAccount[];
  /** The callback URLs the app is registered with: GitHub redirects to no other. */
  readonly callbacks: readonly string[];
  /** The `Authorization` header of every `GET /users/{login}`, so a test can check how the Worker asked. */
  readonly lookups: (string | null)[] = [];
  /** Every token issued, by value, so a test can check what became of it. */
  readonly tokens = new Map<string, IssuedToken>();
  private readonly codes = new Map<string, IssuedCode>();

  constructor(
    web: string,
    api: string,
    callbacks: readonly string[],
    accounts: readonly FakeAccount[] = Object.values(FAKE_ACCOUNTS)
  ) {
    this.web = web.replace(/\/+$/u, "");
    this.api = api.replace(/\/+$/u, "");
    this.callbacks = callbacks;
    this.accounts = accounts;
  }

  /** Whether a request is addressed to the stand-in. */
  handles(url: string): boolean {
    return url.startsWith(`${this.web}/`) || url.startsWith(`${this.api}/`);
  }

  async fetch(request: Request): Promise<Response> {
    const { url } = request;
    // The API may live under the web address (`/api`), so it is matched first.
    if (url.startsWith(`${this.api}/`)) {
      return await this.apiRoute(
        request,
        new URL(url),
        url.slice(this.api.length)
      );
    }
    if (url.startsWith(`${this.web}/`)) {
      return await this.webRoute(
        request,
        new URL(url),
        url.slice(this.web.length)
      );
    }
    return new Response("not the stand-in GitHub", { status: 502 });
  }

  /** Approve an authorize request as `login`, as clicking its link does: the URL GitHub redirects back to. */
  approve(authorize: URL, login: string): string {
    const params = authorize.searchParams;
    const account = this.accounts.find((found) => found.login === login);
    const redirectUri = params.get("redirect_uri") ?? "";
    const challenge = params.get("code_challenge") ?? "";
    if (
      account === undefined ||
      params.get("client_id") !== FAKE_CLIENT.id ||
      !this.callbacks.includes(redirectUri) ||
      params.get("code_challenge_method") !== "S256" ||
      challenge === ""
    ) {
      throw new Error(
        `the stand-in GitHub refuses this authorize request: ${authorize.search}`
      );
    }
    const code = randomText();
    this.codes.set(code, { account, challenge, redirectUri, used: false });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state") ?? "");
    return back.toString();
  }

  private async webRoute(
    request: Request,
    url: URL,
    path: string
  ): Promise<Response> {
    const [route = ""] = path.split("?");
    if (
      route.startsWith("/login/oauth/") &&
      url.searchParams.has("redirect_uri") &&
      !this.callbacks.includes(url.searchParams.get("redirect_uri") ?? "")
    ) {
      // GitHub's own answer to a redirect_uri the app is not registered with.
      return new Response(
        "The redirect_uri is not associated with this application.",
        { status: 400 }
      );
    }
    if (request.method === "GET" && route === "/login/oauth/authorize") {
      return this.authorizePage(url);
    }
    if (request.method === "GET" && route === "/login/oauth/approve") {
      const login = url.searchParams.get("as") ?? "";
      const authorize = new URL(`${this.web}/login/oauth/authorize`);
      authorize.search = url.search;
      authorize.searchParams.delete("as");
      return Response.redirect(this.approve(authorize, login), 302);
    }
    if (request.method === "GET" && route === "/login/oauth/cancel") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return Response.redirect(back.toString(), 302);
    }
    if (request.method === "POST" && route === "/login/oauth/access_token") {
      return await this.exchange(request);
    }
    return new Response("Not Found", { status: 404 });
  }

  private authorizePage(url: URL): Response {
    const links = this.accounts
      .map((account) => {
        const approve = new URL(`${this.web}/login/oauth/approve`);
        approve.search = url.search;
        approve.searchParams.set("as", account.login);
        return `<li><a href="${escapeHtml(approve.toString())}">Authorize as @${escapeHtml(account.login)}</a></li>`;
      })
      .join("");
    const cancel = new URL(`${this.web}/login/oauth/cancel`);
    cancel.searchParams.set(
      "redirect_uri",
      url.searchParams.get("redirect_uri") ?? ""
    );
    cancel.searchParams.set("state", url.searchParams.get("state") ?? "");
    return new Response(
      `<!doctype html><html><head><title>Stand-in GitHub</title></head><body><h1>Authorize ShelfKit</h1><ul>${links}</ul><a href="${escapeHtml(cancel.toString())}">Cancel</a></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  private async exchange(request: Request): Promise<Response> {
    const form = new URLSearchParams(
      new TextDecoder().decode(await request.arrayBuffer())
    );
    const refused = Response.json({ error: "bad_verification_code" });
    if (
      form.get("client_id") !== FAKE_CLIENT.id ||
      form.get("client_secret") !== FAKE_CLIENT.secret
    ) {
      return Response.json({ error: "incorrect_client_credentials" });
    }
    const code = this.codes.get(form.get("code") ?? "");
    if (code === undefined || code.used) {
      return refused;
    }
    // A code is spent by its first exchange, whatever the outcome, as GitHub's is.
    code.used = true;
    const verifier = form.get("code_verifier") ?? "";
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier)
        )
      )
    );
    if (
      challenge !== code.challenge ||
      form.get("redirect_uri") !== code.redirectUri
    ) {
      return refused;
    }
    const token = `gho_${randomText()}`;
    this.tokens.set(token, { account: code.account, revoked: false });
    return Response.json({
      access_token: token,
      scope: "",
      token_type: "bearer",
    });
  }

  private async apiRoute(
    request: Request,
    url: URL,
    path: string
  ): Promise<Response> {
    const [route = ""] = path.split("?");
    if (request.method === "GET" && route === "/user") {
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer /u,
        ""
      );
      const issued = this.tokens.get(token);
      return issued === undefined || issued.revoked
        ? Response.json({ message: "Bad credentials" }, { status: 401 })
        : Response.json({ id: issued.account.id, login: issued.account.login });
    }
    const user = /^\/users\/(?<login>[^/]+)$/u.exec(route)?.groups?.login;
    if (request.method === "GET" && user !== undefined) {
      this.lookups.push(request.headers.get("authorization"));
      // A login that stands for GitHub's primary rate limit having run out.
      if (user === RATE_LIMITED_LOGIN) {
        return Response.json(
          { message: "API rate limit exceeded" },
          {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "4102444800",
            },
            status: 403,
          }
        );
      }
      const account = this.accounts.find(
        (found) =>
          found.login.toLowerCase() === decodeURIComponent(user).toLowerCase()
      );
      return account === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({ id: account.id, login: account.login });
    }
    if (
      request.method === "DELETE" &&
      route === `/applications/${FAKE_CLIENT.id}/token`
    ) {
      if (
        request.headers.get("authorization") !==
        `Basic ${btoa(`${FAKE_CLIENT.id}:${FAKE_CLIENT.secret}`)}`
      ) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      const body = v.safeParse(
        v.object({ access_token: v.string() }),
        await request.json()
      );
      const issued = body.success
        ? this.tokens.get(body.output.access_token)
        : undefined;
      if (issued === undefined) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      issued.revoked = true;
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { message: `Not Found: ${url.pathname}` },
      { status: 404 }
    );
  }
}
