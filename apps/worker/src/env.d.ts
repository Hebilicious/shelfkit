/**
 * The Worker's secrets, which `wrangler types` cannot see. Set them with `wrangler secret put`; `moon run worker:setup`
 * sets `OWNER_KEY_HASH`.
 *
 * - `OWNER_KEY_HASH`: the lowercase hex SHA-256 of the owner key. The key itself is shown once by setup and kept
 *   nowhere on the service.
 * - `GITHUB_TOKEN`: optional, for indexing a private repository through GitHub's REST API.
 * - `SHELFKIT_SECRET_<NAME>`: the value of a secret an item references as `{ "secret": "<NAME>" }`, used only when the
 *   shelf lists `<NAME>` among its secret names (`src/secrets.ts`).
 */
declare namespace Cloudflare {
  interface Env {
    readonly OWNER_KEY_HASH?: string;
    readonly GITHUB_TOKEN?: string;
  }
}

interface Env {
  readonly OWNER_KEY_HASH?: string;
  readonly GITHUB_TOKEN?: string;
}
