/**
 * How a secret an item or a source references resolves. Nothing in a shelf holds a credential: a value that is secret
 * is written `{ "secret": "NAME" }` in an item (`SecretValueSchema`), or `"secret": "NAME"` on a source, and a literal
 * that looks like a credential fails the load. On the hosted service the rule is:
 *
 * 1. `NAME` must be one of the shelf's secret names, each bound by the owner to one origin (`putSecretName(name,
 *    origin)`; only the owner creates or changes one).
 * 2. The value is released only to a destination whose origin is that origin. So a key that may edit an item cannot
 *    point a `{ "secret": "X" }` header at a server of its own and have the value sent there.
 * 3. The value is the Worker secret `SHELFKIT_SECRET_<NAME>`, set with `wrangler secret put SHELFKIT_SECRET_<NAME>`.
 *    Values never pass through GraphQL, MCP, or the shelf's database.
 * 4. Anything else resolves to nothing, and the caller refuses to call the destination rather than call it without
 *    its credential.
 *
 * The MCP relay (issue #6) gets resolved headers from the shelf's object (`relayHeaders`), and an import adapter gets
 * `AdapterContext.secret`, bound to its source's URL (`src/jobs/consumer.ts`).
 */

/** A secret name and the one origin its value may be sent to; `null` for none yet, which releases it nowhere. */
export interface SecretBindingRecord {
  readonly name: string;
  readonly origin: string | null;
}

/** The Worker secret that holds the value of the secret name `name`. */
export function secretBinding(name: string): string {
  return `SHELFKIT_SECRET_${name}`;
}

/**
 * The origin of a URL a secret may be bound to or sent to: `https://host[:port]`, or `null` for anything else (plain
 * http, a URL that does not parse).
 */
export function secretOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The value of `name` for a request to `destination`, or `undefined` when the shelf does not list `name`, the name is
 * bound to another origin (or none), or the Worker has no value.
 * BOUNDARY: a binding read by name is untyped until this checks that it is a non-empty string.
 */
export function resolveSecret(
  env: Env,
  bindings: readonly SecretBindingRecord[],
  name: string,
  destination: string
): string | undefined {
  const bound = bindings.find((binding) => binding.name === name);
  const origin = secretOrigin(destination);
  if (
    bound?.origin === null ||
    bound?.origin === undefined ||
    origin === null ||
    origin !== bound.origin
  ) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(
    env,
    secretBinding(name)
  )?.value;
  return typeof value === "string" && value !== "" ? value : undefined;
}
