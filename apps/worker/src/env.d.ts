/**
 * The Worker's secrets, which `wrangler types` cannot see. Set them with `wrangler secret put`; `moon run worker:setup`
 * sets every one but `GITHUB_TOKEN` and the `SHELFKIT_SECRET_*` values.
 *
 * - `OWNER_KEY_HASH`: the lowercase hex SHA-256 of the owner key. The key itself is shown once by setup and kept
 *   nowhere on the service.
 * - `OWNER_GITHUB_ID`: the numeric id of the GitHub account that owns the deployment. Signing in with it in the
 *   browser is signing in as the owner.
 * - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: the deployment's own GitHub App (or OAuth App), for signing in with
 *   GitHub. The app requests no permissions; it only identifies who signs in.
 * - `SESSION_SECRET`: the HMAC key that signs the browser's session cookie. Rotating it signs every browser out.
 * - `GITHUB_TOKEN`: optional, for indexing a private repository through GitHub's REST API.
 * - `SHELFKIT_SECRET_<NAME>`: the value of a secret an item references as `{ "secret": "<NAME>" }`, used only when the
 *   shelf lists `<NAME>` among its secret names (`src/secrets.ts`).
 */
declare namespace Cloudflare {
  interface Env {
    readonly OWNER_KEY_HASH?: string;
    readonly OWNER_GITHUB_ID?: string;
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: string;
    readonly SESSION_SECRET?: string;
    readonly GITHUB_TOKEN?: string;
  }
}

interface Env {
  readonly OWNER_KEY_HASH?: string;
  readonly OWNER_GITHUB_ID?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly SESSION_SECRET?: string;
  readonly GITHUB_TOKEN?: string;
}
