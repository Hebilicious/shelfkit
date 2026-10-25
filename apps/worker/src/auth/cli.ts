/**
 * Signing the CLI in through the browser: `shelfkit login <url>` without pasting a key (`docs/PRD.md` section 10.3).
 *
 * 1. The CLI posts `/auth/cli/start` with a name for its device. The Worker answers with a **user code** (8
 *    characters, shown as `ABCD-EFGH`), a **device code** (`<user code>.<secret>`), the page to approve it on
 *    (`/cli/ABCD-EFGH`), and how often to poll. The pending login lives in its own Durable Object, named by the user
 *    code (`cli-logins.ts`), which keeps only the secret's hash, for `CLI_LOGIN_SECONDS`.
 * 2. The CLI opens the page. A browser signed in there (by its cookie, never a key) sees the device name and the code
 *    and, once its person checks the code matches the one in their terminal, approves or denies it over GraphQL.
 *    Approving makes a CLI key (`skc_...`) that acts as that person, kept by its hash in their account object.
 * 3. The CLI posts `/auth/cli/poll` with the device code until the login is approved (the answer carries the key,
 *    once), denied, or expired. A wrong secret is answered as an expired code, so the poll says nothing more about a
 *    code than the CLI that started it may know.
 *
 * Both routes are plain `POST`s of `application/json`, read no cookie, and answer `no-store`. Each is rate limited by
 * the client's address before it reads the body (`limits.ts`): an address over its limit is answered `429` with
 * `Retry-After`, and the CLI waits that long before it polls again.
 */
import * as v from "valibot";

import { problem } from "../http.ts";
import { sha256Hex } from "../storage/objects.ts";
import { base64url } from "./browser.ts";
import type { CliLoginPoll } from "./cli-logins.ts";
import { displayPrefix, newCliKey } from "./keys.ts";
import { clientAddress, overLimit, tooManyRequests } from "./limits.ts";
import { accountStub } from "./principals.ts";
import type { Person } from "./session.ts";

/** How long a login waits for approval: 10 minutes. */
export const CLI_LOGIN_SECONDS = 10 * 60;

/** How often the CLI polls, in seconds. */
export const CLI_POLL_SECONDS = 2;

/** The user code's alphabet: capitals and digits without `I`, `O`, `0`, and `1`, which read alike. 32, so a byte's low 5 bits pick one evenly. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const CODE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`, "u");
const SECRET = /^[A-Za-z0-9_-]{43}$/u;

/** A user code as people type it (any case, with or without its dash or spaces), as the 8 characters, or `null`. */
export function normalizeUserCode(text: string): string | null {
  const code = text.replaceAll(/[\s-]/gu, "").toUpperCase();
  return CODE.test(code) ? code : null;
}

/** A user code as it is shown: `ABCD-EFGH`. */
export function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // oxlint-disable-next-line eslint/no-bitwise -- the low 5 bits of a byte pick one of 32 characters evenly.
  return [...bytes].map((byte) => ALPHABET[byte & 31] ?? "").join("");
}

/** A pending login's object. */
export function cliLoginStub(env: Env, code: string) {
  return env.CLI_LOGIN.get(env.CLI_LOGIN.idFromName(code));
}

/** A device name as the approval page shows it: printable, one line, at most 64 characters. */
function deviceName(text: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- control characters are exactly what is removed.
  const cleaned = text.replaceAll(/[\u0000-\u001F\u007F-\u009F]/gu, " ");
  return cleaned.replaceAll(/\s+/gu, " ").trim().slice(0, 64) || "a computer";
}

const StartSchema = v.object({
  device: v.optional(v.pipe(v.string(), v.maxLength(256)), ""),
});

const PollSchema = v.object({
  deviceCode: v.pipe(v.string(), v.maxLength(128)),
});

/** Why a request to these routes is refused before it is read, or `null`. */
function refusal(request: Request): Response | null {
  if (request.method !== "POST") {
    return problem(405, "Method Not Allowed", "use POST", { allow: "POST" });
  }
  const media = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  return media === "application/json"
    ? null
    : problem(415, "Unsupported Media Type", "send application/json");
}

/** BOUNDARY: a request body is whatever the client sent; the schema decides. */
async function body<const TSchema extends v.GenericSchema>(
  request: Request,
  schema: TSchema
): Promise<v.InferOutput<TSchema> | null> {
  try {
    const parsed = v.safeParse(schema, await request.json());
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

/** What the CLI reads: a started login, or how one stands. */
interface Started {
  readonly deviceCode: string;
  readonly expiresAt: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly userCode: string;
  readonly verificationUrl: string;
}

function answer(value: Started | CliLoginPoll): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}

async function start(request: Request, env: Env): Promise<Response> {
  const input = await body(request, StartSchema);
  if (input === null) {
    return problem(
      400,
      "Bad Request",
      "send { device }: a name for this computer"
    );
  }
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = Math.floor(Date.now() / 1000) + CLI_LOGIN_SECONDS;
  const device = deviceName(input.device);
  const secretHash = await sha256Hex(secret);
  // A code that already names a live login is drawn again; with 32^8 codes, a second draw is all but never needed.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const code = newUserCode();
    // oxlint-disable-next-line eslint/no-await-in-loop -- each draw waits for the last to be refused.
    const begun = await cliLoginStub(env, code).begin({
      device,
      expiresAt,
      secretHash,
    });
    if (begun) {
      const shown = displayUserCode(code);
      return answer({
        deviceCode: `${code}.${secret}`,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        expiresIn: CLI_LOGIN_SECONDS,
        interval: CLI_POLL_SECONDS,
        userCode: shown,
        verificationUrl: `${new URL(request.url).origin}/cli/${shown}`,
      });
    }
  }
  return problem(503, "Service Unavailable", "no free code: try again");
}

async function poll(request: Request, env: Env): Promise<Response> {
  const input = await body(request, PollSchema);
  const [code = "", secret = ""] = input?.deviceCode.split(".") ?? [];
  if (input === null || !CODE.test(code) || !SECRET.test(secret)) {
    return answer({ status: "expired" } satisfies CliLoginPoll);
  }
  return answer(await cliLoginStub(env, code).poll(await sha256Hex(secret)));
}

/** `/auth/cli/start` and `/auth/cli/poll`. */
export async function cliLoginRoute(
  request: Request,
  env: Env
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/auth/cli/start" && pathname !== "/auth/cli/poll") {
    return problem(404, "Not Found");
  }
  const refused = refusal(request);
  if (refused !== null) {
    return refused;
  }
  const starting = pathname === "/auth/cli/start";
  const wait = await overLimit(
    env,
    starting ? "CLI_START_LIMIT" : "CLI_POLL_LIMIT",
    clientAddress(request)
  );
  if (wait !== null) {
    return tooManyRequests(
      wait,
      starting
        ? `too many CLI logins started from this address: try again in ${wait} seconds`
        : `polling too often from this address: wait ${wait} seconds, then poll every ${CLI_POLL_SECONDS} seconds`
    );
  }
  return starting ? await start(request, env) : await poll(request, env);
}

/** Why approving a login was refused. */
export type ApprovalRefusal = "not-waiting" | "account";

/**
 * Approve the login `code` as `person`: make a CLI key that acts as them, keep its hash in their account object, and
 * leave the key in the login for the CLI's one pickup. A key made for a login that is no longer waiting is revoked
 * at once, so it never outlives the attempt.
 */
export async function approveCliLogin(
  env: Env,
  code: string,
  person: Person
): Promise<
  | { readonly ok: true; readonly device: string; readonly name: string }
  | { readonly ok: false; readonly reason: ApprovalRefusal }
> {
  const login = cliLoginStub(env, code);
  const pending = await login.pending();
  if (pending === null) {
    return { ok: false, reason: "not-waiting" };
  }
  const key = newCliKey(person.id);
  if (key === null) {
    return { ok: false, reason: "account" };
  }
  const account = accountStub(env, person.id);
  const name = `CLI on ${pending.device}`;
  const created = await account.createCliKey({
    hash: await sha256Hex(key),
    name,
    person,
    prefix: displayPrefix(key),
  });
  if (created === null) {
    return { ok: false, reason: "account" };
  }
  if (
    !(await login.approve({ key, keyId: created.id, principal: person.id }))
  ) {
    await account.revokeCliKey(created.id);
    return { ok: false, reason: "not-waiting" };
  }
  return { device: pending.device, name, ok: true };
}
