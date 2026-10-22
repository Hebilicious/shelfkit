/**
 * Signing in with GitHub, for the browser, when the deployment enables it (`moon run worker:setup -- --github-sign-in`):
 * `GET /auth/github/start` and `GET /auth/github/callback`. Passkeys and one-time links are the default
 * (`passkeys.ts`, `links.ts`); this is the opt-in alternative, and a GitHub account signs in as the principal
 * `github:<numeric id>`, or as the owner when it is `OWNER_GITHUB_ID`.
 *
 * The deployment has its own GitHub App (or OAuth App), created by `moon run worker:setup`, that requests no
 * permissions: it only tells the Worker who signed in. The flow is OAuth's authorization code flow with PKCE:
 *
 * 1. `start` makes a random `state` and PKCE verifier, keeps both in a short-lived, signed, `HttpOnly` cookie bound to
 *    this browser, and redirects to GitHub's authorize page with the state and the verifier's S256 challenge.
 * 2. GitHub redirects back to `callback` with a code and the state. The state must match the cookie's, so another
 *    site cannot complete a sign-in in this browser. The code is exchanged, with the verifier, for a GitHub token;
 *    the token is used once, for `GET /user`, then revoked and dropped. It is never stored and never logged.
 * 3. The response sets the session cookie (`browser.ts`), which names the account by its numeric id, and redirects to
 *    where the sign-in started.
 *
 * Every failure redirects to `/sign-in?error=<code>`, which the SPA explains: `unconfigured`, `denied`, `state`, or
 * `github`. GitHub's addresses are the Worker vars `GITHUB_URL` and `GITHUB_API_URL`, github.com unless a test points
 * them at a stand-in.
 */
import * as v from "valibot";

import {
  base64url,
  readCookie,
  sessionCookie,
  signClaims,
  signSession,
  verifyClaims,
} from "./browser.ts";
import { sameHash } from "./keys.ts";

/** The cookie that carries a sign-in in progress from `start` to `callback`. */
export const STATE_COOKIE = "__Host-shelfkit_oauth";

/** How long a sign-in may take at GitHub: 10 minutes. */
const STATE_SECONDS = 10 * 60;

export const START_PATH = "/auth/github/start";
export const CALLBACK_PATH = "/auth/github/callback";

/** Why a sign-in failed, as `/sign-in?error=` names it. */
export type SignInError = "unconfigured" | "denied" | "state" | "github";

const StateSchema = v.strictObject({
  exp: v.pipe(v.number(), v.integer()),
  next: v.string(),
  state: v.string(),
  verifier: v.string(),
});

const TokenSchema = v.object({
  access_token: v.pipe(v.string(), v.minLength(1)),
});

const UserSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(1)),
  login: v.pipe(v.string(), v.minLength(1), v.maxLength(39)),
});

interface GitHubConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sessionSecret: string;
  readonly web: string;
  readonly api: string;
}

function configOf(env: Env): GitHubConfig | null {
  const clientId = env.GITHUB_CLIENT_ID ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? "";
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (clientId === "" || clientSecret === "" || sessionSecret === "") {
    return null;
  }
  const web: string = env.GITHUB_URL;
  const api: string = env.GITHUB_API_URL;
  return {
    api: api.replace(/\/+$/u, ""),
    clientId,
    clientSecret,
    sessionSecret,
    web: web.replace(/\/+$/u, ""),
  };
}

/** Whether the deployment signs people in with GitHub: it has the app's client id and secret, and a session secret. */
export function githubSignInEnabled(env: Env): boolean {
  return configOf(env) !== null;
}

/** Characters `next` may never hold: controls, space, and `\`, which browsers read as `/` or drop from a URL. */
// oxlint-disable-next-line eslint/no-control-regex -- matching control characters is the point: `next` may hold none.
const UNSAFE_PATH = /[\u0000-\u0020\u007F\\]/u;

/**
 * A path on this origin to return to, or `/`: never another origin, so the redirect cannot be pointed elsewhere.
 * `next` must be a path; it is resolved against `origin` and must stay there, and only its path, query, and fragment
 * are kept. A value with a control character, a space, or a backslash is refused outright, since a browser would
 * strip or rewrite them (`/<TAB>/evil` is `//evil`), and a `Location` with one would not be sent at all.
 */
export function localPath(next: string | null, origin: string): string {
  if (next === null || !next.startsWith("/") || UNSAFE_PATH.test(next)) {
    return "/";
  }
  let resolved: URL;
  try {
    resolved = new URL(next, origin);
  } catch {
    return "/";
  }
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  if (
    resolved.origin !== origin ||
    path.startsWith("//") ||
    path.startsWith("/auth/")
  ) {
    return "/";
  }
  return path;
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The PKCE S256 challenge of a verifier: base64url of its SHA-256. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

function stateCookie(value: string, maxAge: number): string {
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
    "referrer-policy": "no-referrer",
  });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { headers, status: 302 });
}

function failed(error: SignInError): Response {
  return redirect(`/sign-in?error=${error}`, [stateCookie("", 0)]);
}

/** `/auth/github/*`. */
export async function githubRoute(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") {
    return new Response(null, { headers: { allow: "GET" }, status: 405 });
  }
  const config = configOf(env);
  if (url.pathname === START_PATH) {
    return config === null ? failed("unconfigured") : await start(url, config);
  }
  if (url.pathname === CALLBACK_PATH) {
    return config === null
      ? failed("unconfigured")
      : await finish(request, url, config);
  }
  return new Response(null, { status: 404 });
}

async function start(url: URL, config: GitHubConfig): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken();
  const pending = await signClaims(config.sessionSecret, {
    exp: Math.floor(Date.now() / 1000) + STATE_SECONDS,
    next: localPath(url.searchParams.get("next"), url.origin),
    state,
    verifier,
  });
  const authorize = new URL(`${config.web}/login/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    redirect_uri: `${url.origin}${CALLBACK_PATH}`,
    state,
  }).toString();
  return redirect(authorize.toString(), [stateCookie(pending, STATE_SECONDS)]);
}

async function finish(
  request: Request,
  url: URL,
  config: GitHubConfig
): Promise<Response> {
  const held = readCookie(request.headers.get("cookie"), STATE_COOKIE);
  const pending = v.safeParse(
    StateSchema,
    held === undefined ? null : await verifyClaims(config.sessionSecret, held)
  );
  const returned = url.searchParams.get("state");
  if (
    !pending.success ||
    pending.output.exp <= Math.floor(Date.now() / 1000) ||
    returned === null ||
    !sameHash(returned, pending.output.state)
  ) {
    return failed("state");
  }
  if (url.searchParams.has("error")) {
    return failed("denied");
  }
  const code = url.searchParams.get("code");
  if (code === null || code === "") {
    return failed("github");
  }
  const identity = await identify(config, {
    code,
    redirectUri: `${url.origin}${CALLBACK_PATH}`,
    verifier: pending.output.verifier,
  });
  if (identity === null) {
    return failed("github");
  }
  const session = await signSession(config.sessionSecret, {
    id: `github:${identity.id}`,
    name: `@${identity.login}`,
  });
  // Checked again on the way out, so no `next` reaches a `Location` header unchecked.
  return redirect(localPath(pending.output.next, url.origin), [
    stateCookie("", 0),
    sessionCookie(session),
  ]);
}

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "shelfkit",
  "x-github-api-version": "2022-11-28",
};

/**
 * Exchange the code for a token, read who it belongs to, and revoke it. The token lives only in this function.
 * `null` when GitHub refuses the code (wrong, used, or expired), the verifier, or the token.
 */
async function identify(
  config: GitHubConfig,
  grant: {
    readonly code: string;
    readonly redirectUri: string;
    readonly verifier: string;
  }
): Promise<{ readonly id: string; readonly login: string } | null> {
  let token: string;
  try {
    const exchanged = await fetch(`${config.web}/login/oauth/access_token`, {
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: grant.redirectUri,
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "shelfkit",
      },
      method: "POST",
    });
    // GitHub answers a refused code with `200` and `{ "error": ... }`, which the schema refuses.
    const parsed = v.safeParse(TokenSchema, await exchanged.json());
    if (!exchanged.ok || !parsed.success) {
      return null;
    }
    token = parsed.output.access_token;
  } catch {
    return null;
  }
  try {
    const answer = await fetch(`${config.api}/user`, {
      headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
    });
    const user = v.safeParse(
      UserSchema,
      answer.ok ? await answer.json() : null
    );
    return user.success
      ? { id: String(user.output.id), login: user.output.login }
      : null;
  } catch {
    return null;
  } finally {
    await revoke(config, token);
  }
}

/** Revoke the token: the Worker has what it needed from it. A failure leaves a token nobody holds, so it is ignored. */
async function revoke(config: GitHubConfig, token: string): Promise<void> {
  try {
    const answer = await fetch(
      `${config.api}/applications/${encodeURIComponent(config.clientId)}/token`,
      {
        body: JSON.stringify({ access_token: token }),
        headers: {
          ...API_HEADERS,
          authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
          "content-type": "application/json",
        },
        method: "DELETE",
      }
    );
    await answer.body?.cancel();
  } catch {
    // Not revoked; the token was never stored, and expires on GitHub's schedule.
  }
}

/** GitHub refused to look an account up because a rate limit ran out. */
export class GitHubRateLimitedError extends Error {
  readonly resetAt: string | null;

  constructor(resetAt: string | null) {
    super(
      resetAt === null
        ? "GitHub's API rate limit for looking up accounts is used up for now; try again in a few minutes"
        : `GitHub's API rate limit for looking up accounts is used up until ${resetAt}; try again then`
    );
    this.name = "GitHubRateLimitedError";
    this.resetAt = resetAt;
  }
}

/**
 * `GET {GITHUB_API_URL}/users/{login}`: a GitHub account by login, for a grant. `null` when there is none.
 *
 * Asked with the app's client id and secret as Basic credentials: GitHub documents that for OAuth apps, with 5,000
 * requests an hour per app instead of 60 an hour per IP address, which a Worker shares with everyone on Cloudflare's
 * addresses. GitHub does not document it for GitHub Apps; if it refuses the credentials (`401`), the lookup is made
 * anonymously. A rate limit that runs out is `GitHubRateLimitedError`.
 */
export async function lookUpAccount(
  env: Env,
  login: string
): Promise<{ readonly id: string; readonly login: string } | null> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login)) {
    return null;
  }
  const api: string = env.GITHUB_API_URL;
  const address = `${api.replace(/\/+$/u, "")}/users/${encodeURIComponent(login)}`;
  const clientId = env.GITHUB_CLIENT_ID ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET ?? "";
  let answer =
    clientId === "" || clientSecret === ""
      ? await fetch(address, { headers: API_HEADERS })
      : await fetch(address, {
          headers: {
            ...API_HEADERS,
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          },
        });
  if (answer.status === 401) {
    await answer.body?.cancel();
    answer = await fetch(address, { headers: API_HEADERS });
  }
  if (!answer.ok) {
    await answer.body?.cancel();
  }
  if (answer.status === 403 || answer.status === 429) {
    const reset = Number(answer.headers.get("x-ratelimit-reset") ?? "");
    throw new GitHubRateLimitedError(
      Number.isFinite(reset) && reset > 0
        ? new Date(reset * 1000).toISOString()
        : null
    );
  }
  if (answer.status === 404) {
    return null;
  }
  if (!answer.ok) {
    throw new Error(
      `GitHub answered ${answer.status} for the account \`${login}\``
    );
  }
  const user = v.parse(UserSchema, await answer.json());
  return { id: String(user.id), login: user.login };
}
