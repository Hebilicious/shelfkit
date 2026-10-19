/**
 * How a secret an item references resolves. An item never holds a credential: a value that is secret is written
 * `{ "secret": "NAME" }` (`SecretValueSchema`), and a literal that looks like a credential fails the load. On the hosted
 * service the rule is:
 *
 * 1. `NAME` must be one of the shelf's secret names (Settings, `putSecretName`), so a shelf reaches only the secrets
 *    its owner listed for it.
 * 2. The value is the Worker secret `SHELFKIT_SECRET_<NAME>`, set with `wrangler secret put SHELFKIT_SECRET_<NAME>`.
 *    Values never pass through GraphQL, MCP, or the shelf's database.
 * 3. Anything else resolves to nothing, and the caller (the MCP relay, issue #6) refuses to call the server rather
 *    than call it without its credential.
 */

/** The Worker secret that holds the value of the secret name `name`. */
export function secretBinding(name: string): string {
  return `SHELFKIT_SECRET_${name}`;
}

/**
 * A secret reference's value, or `undefined` when the shelf does not list `name` or the Worker has no value.
 * BOUNDARY: a binding read by name is untyped until this checks that it is a non-empty string.
 */
export function resolveSecret(
  env: Env,
  shelfSecretNames: readonly string[],
  name: string
): string | undefined {
  if (!shelfSecretNames.includes(name)) {
    return undefined;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(
    env,
    secretBinding(name)
  )?.value;
  return typeof value === "string" && value !== "" ? value : undefined;
}
