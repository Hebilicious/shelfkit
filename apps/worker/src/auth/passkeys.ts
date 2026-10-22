/**
 * Passkeys, the default way a browser signs in: `POST /auth/passkey/...`, JSON in and out.
 *
 * - `options` and `authenticate`: sign in. The options carry a fresh challenge, which this browser holds in a signed,
 *   `HttpOnly` cookie for `CHALLENGE_SECONDS`; the assertion names its account by the passkey's user handle (the
 *   principal), and that account's object checks the signature, the origin, the relying party, and the counter, and
 *   spends the challenge.
 * - `register/options` and `register`: add a passkey to the signed-in account (the owner, or an invited person). The
 *   challenge is kept by the account's object, for one use.
 *
 * The relying party is the deployment as the request reached it: its hostname is the RP id, its origin the only
 * origin accepted. Every route is a same-origin `POST` of `application/json`: another site's page can neither send one
 * nor read an answer, since there is no CORS.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import * as v from "valibot";

import { problem } from "../http.ts";
import {
  PrincipalSchema,
  readCookie,
  sessionCookie,
  signClaims,
  signSession,
  verifyClaims,
} from "./browser.ts";
import { authenticateRequest } from "./index.ts";
import { accountExists, accountStub, CHALLENGE_SECONDS } from "./principals.ts";
import type { PasskeyRecord, RelyingParty } from "./principals.ts";
import { OWNER_PRINCIPAL } from "./session.ts";
import type { Person } from "./session.ts";

/** The cookie that carries a sign-in ceremony's challenge from `options` to `authenticate`. */
export const CHALLENGE_COOKIE = "__Host-shelfkit_passkey";

const ChallengeSchema = v.strictObject({
  challenge: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,128}$/u)),
  exp: v.pipe(v.number(), v.integer()),
});

/**
 * A credential's JSON, as the browser serialises it: the fields the WebAuthn library reads, as base64url text. The
 * library checks what they hold. Client extension results are not used, so none are passed on.
 */
const AuthenticationSchema = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    authenticatorData: v.string(),
    clientDataJSON: v.string(),
    signature: v.string(),
    userHandle: v.optional(v.string()),
  }),
  type: v.literal("public-key"),
});

const AuthenticateBodySchema = v.object({ response: AuthenticationSchema });

type AuthenticateBody = v.InferOutput<typeof AuthenticateBodySchema>;

const TransportSchema = v.picklist([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const RegistrationSchema = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    attestationObject: v.string(),
    clientDataJSON: v.string(),
    transports: v.optional(v.array(TransportSchema)),
  }),
  type: v.literal("public-key"),
});

const RegisterBodySchema = v.object({
  label: v.optional(v.pipe(v.string(), v.maxLength(64)), ""),
  response: RegistrationSchema,
});

type RegisterBody = v.InferOutput<typeof RegisterBodySchema>;

function relyingParty(request: Request): RelyingParty {
  const url = new URL(request.url);
  return { id: url.hostname, origin: url.origin };
}

function challengeCookie(value: string, maxAge: number): string {
  return `${CHALLENGE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/** What these routes answer with. */
type Answer =
  | PublicKeyCredentialCreationOptionsJSON
  | PublicKeyCredentialRequestOptionsJSON
  | { readonly name: string; readonly owner: boolean }
  | { readonly passkey: PasskeyRecord };

function json(
  body: Answer,
  status = 200,
  cookies: readonly string[] = []
): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return Response.json(body, { headers, status });
}

function refused(detail: string, cookies: readonly string[] = []): Response {
  const response = problem(401, "Unauthorized", detail);
  for (const cookie of cookies) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

/** A same-origin JSON `POST`, or why not. */
function crossSite(request: Request): Response | null {
  if (request.method !== "POST") {
    return problem(405, "Method Not Allowed", "use POST", { allow: "POST" });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return problem(403, "Forbidden", "passkeys are used from this origin only");
  }
  const media = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  return media === "application/json"
    ? null
    : problem(415, "Unsupported Media Type", "send application/json");
}

/** The user handle a passkey was made with: the principal, as UTF-8 bytes in base64url. */
function principalOf(userHandle: string | undefined): string | null {
  if (userHandle === undefined) {
    return null;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(
        atob(userHandle.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.codePointAt(0) ?? 0
      )
    );
    const parsed = v.safeParse(PrincipalSchema, text);
    return parsed.success && !text.startsWith("github:") ? text : null;
  } catch {
    return null;
  }
}

/** `/auth/passkey/*`. */
export async function passkeyRoute(
  request: Request,
  env: Env
): Promise<Response> {
  const refusal = crossSite(request);
  if (refusal !== null) {
    return refusal;
  }
  const secret = env.SESSION_SECRET ?? "";
  if (secret === "") {
    return problem(
      503,
      "Service Unavailable",
      "this deployment has no SESSION_SECRET: run `moon run worker:setup`"
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "Bad Request", "the body is not JSON");
  }
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case "/auth/passkey/options": {
      return await signInOptions(request, secret);
    }
    case "/auth/passkey/authenticate": {
      const parsed = v.safeParse(AuthenticateBodySchema, body);
      return await authenticate(
        request,
        env,
        secret,
        parsed.success ? parsed.output : null
      );
    }
    case "/auth/passkey/register/options": {
      return await registrationOptions(request, env);
    }
    case "/auth/passkey/register": {
      const parsed = v.safeParse(RegisterBodySchema, body);
      return parsed.success
        ? await register(request, env, parsed.output)
        : problem(400, "Bad Request", "send { response, label }");
    }
    default: {
      return problem(404, "Not Found");
    }
  }
}

async function signInOptions(
  request: Request,
  secret: string
): Promise<Response> {
  const { generateAuthenticationOptions } =
    await import("@simplewebauthn/server");
  const rp = relyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    timeout: CHALLENGE_SECONDS * 1000,
    userVerification: "required",
  });
  const held = await signClaims(secret, {
    challenge: options.challenge,
    exp: Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS,
  });
  return json(options, 200, [challengeCookie(held, CHALLENGE_SECONDS)]);
}

async function authenticate(
  request: Request,
  env: Env,
  secret: string,
  body: AuthenticateBody | null
): Promise<Response> {
  const spent = challengeCookie("", 0);
  const held = readCookie(request.headers.get("cookie"), CHALLENGE_COOKIE);
  const challenge = v.safeParse(
    ChallengeSchema,
    held === undefined ? null : await verifyClaims(secret, held)
  );
  if (
    !challenge.success ||
    challenge.output.exp <= Math.floor(Date.now() / 1000)
  ) {
    return refused(
      "the sign-in took too long, or did not start in this browser",
      [spent]
    );
  }
  const principal =
    body === null ? null : principalOf(body.response.response.userHandle);
  if (
    body === null ||
    principal === null ||
    !(await accountExists(env, principal))
  ) {
    return refused("this passkey belongs to no account here", [spent]);
  }
  const credential: AuthenticationResponseJSON = {
    ...body.response,
    clientExtensionResults: {},
  };
  const outcome = await accountStub(env, principal).authenticate(
    relyingParty(request),
    credential,
    challenge.output.challenge,
    challenge.output.exp
  );
  if (!outcome.ok) {
    return refused(
      outcome.reason === "counter"
        ? "this passkey's signature counter went backwards, so it may have been copied; it is refused"
        : "the passkey was not accepted",
      [spent]
    );
  }
  const person: Person = outcome.person;
  return json(
    { name: person.name, owner: person.id === OWNER_PRINCIPAL },
    200,
    [spent, sessionCookie(await signSession(secret, person))]
  );
}

/** The signed-in account a passkey may be added to: the owner's or an invited person's, never a GitHub account. */
async function signedInAccount(
  request: Request,
  env: Env
): Promise<Person | null> {
  const { session, source } = await authenticateRequest(request, env);
  if (source !== "cookie") {
    return null;
  }
  if (session.kind === "owner" && session.person !== undefined) {
    return session.person;
  }
  return session.kind === "person" && session.person.id.startsWith("person:")
    ? session.person
    : null;
}

async function registrationOptions(
  request: Request,
  env: Env
): Promise<Response> {
  const person = await signedInAccount(request, env);
  if (person === null) {
    return refused("sign in first, with a link or a passkey");
  }
  const stub = accountStub(env, person.id);
  if (person.id === OWNER_PRINCIPAL) {
    await stub.ensure({ id: OWNER_PRINCIPAL, name: "Owner" });
  }
  const options = await stub.registrationOptions(relyingParty(request));
  return options === null ? refused("this account was removed") : json(options);
}

async function register(
  request: Request,
  env: Env,
  body: RegisterBody
): Promise<Response> {
  const person = await signedInAccount(request, env);
  if (person === null) {
    return refused("sign in first, with a link or a passkey");
  }
  const credential: RegistrationResponseJSON = {
    ...body.response,
    clientExtensionResults: {},
  };
  const outcome = await accountStub(env, person.id).register(
    relyingParty(request),
    credential,
    body.label
  );
  if (!outcome.ok) {
    return problem(
      400,
      "Bad Request",
      outcome.reason === "challenge"
        ? "the passkey took too long to make, or was made for another request; try again"
        : "the passkey was not accepted"
    );
  }
  return json({ passkey: outcome.passkey });
}
