/**
 * The Worker's secrets, which `wrangler types` cannot see. Set them with `wrangler secret put`; `moon run worker:setup`
 * sets `OWNER_KEY_HASH` and `SESSION_SECRET`, and with `--github-sign-in` the three GitHub ones too.
 *
 * - `OWNER_KEY_HASH`: the lowercase hex SHA-256 of the owner key. The key itself is shown once by setup and kept
 *   nowhere on the service.
 * - `SESSION_SECRET`: the HMAC key that signs the browser's session cookie and its passkey challenges. Rotating it
 *   signs every browser out. Without it, no browser signs in.
 * - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: the deployment's own GitHub App (or OAuth App), when GitHub sign-in is
 *   enabled. The app requests no permissions; it only identifies who signs in. Without them, there is no GitHub button.
 * - `OWNER_GITHUB_ID`: with GitHub sign-in, the numeric id of the owner's GitHub account, which signs in as the owner.
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
