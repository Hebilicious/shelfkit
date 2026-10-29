/**
 * Rate limits on signing the CLI in through the browser (`docs/PRD.md` section 10.3), counted by the Workers Rate
 * Limiting bindings `wrangler.jsonc` declares, for production and again for Previews. The numbers here are the
 * bindings' own, and a test holds the two in step: the binding counts, and this file says how long to wait.
 *
 * - **Starting** a login, per client address: 10 a minute. A person needs one login, and each costs a Durable Object
 *   that lives 10 minutes; ten leave room for a few people behind one address and a mistyped retry or two.
 * - **Polling**, per client address: 20 every 10 seconds. A CLI polls every `CLI_POLL_SECONDS` (2), 5 polls in a
 *   window, so four CLIs signing in at once behind one address poll at full speed; a fifth waits its turn.
 * - **Looking a code up** on the approval page, approving it, or denying it, per account: 20 a minute. A person
 *   handling one login makes two or three of these; the limit caps how fast a signed-in session can try codes.
 *
 * The client address is `CF-Connecting-IP`, which Cloudflare's edge sets on every request it forwards (and Miniflare
 * sets under `wrangler dev`). A request without one, which only a test or another Worker sends, counts against a
 * single shared address.
 */
import { problem } from "../http.ts";

/** Each limiter's `simple` settings in `wrangler.jsonc`: at most `limit` calls per key every `period` seconds. */
export const CLI_RATE_LIMITS = {
  CLI_APPROVAL_LIMIT: { limit: 20, period: 60 },
  CLI_POLL_LIMIT: { limit: 20, period: 10 },
  CLI_START_LIMIT: { limit: 10, period: 60 },
} as const;

export type CliRateLimit = keyof typeof CLI_RATE_LIMITS;

/** The address a request came from, the key the start and poll limits count by. */
export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Count one call against `name` for `key`: `null` while it is within the limit, else the seconds to wait. */
export async function overLimit(
  env: Env,
  name: CliRateLimit,
  key: string
): Promise<number | null> {
  const { success } = await env[name].limit({ key });
  return success ? null : CLI_RATE_LIMITS[name].period;
}

/** `429`, as an RFC 7807 problem, with the seconds to wait in `Retry-After`. */
export function tooManyRequests(seconds: number, detail: string): Response {
  return problem(429, "Too Many Requests", detail, {
    "cache-control": "no-store",
    "retry-after": String(seconds),
  });
}
