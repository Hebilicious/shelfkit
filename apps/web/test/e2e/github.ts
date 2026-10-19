/**
 * Where the specs' stand-in GitHub listens (`fake-github-server.ts`), and the configuration the Worker under test is
 * given to sign in through it. Test values only.
 */
import {
  FAKE_ACCOUNTS,
  FAKE_CLIENT,
} from "../../../worker/test/fake-github.ts";
import { FAKE_GITHUB_PORT } from "./ports.ts";

export { FAKE_ACCOUNTS } from "../../../worker/test/fake-github.ts";

export { FAKE_GITHUB_PORT } from "./ports.ts";
export const FAKE_GITHUB_WEB = `http://127.0.0.1:${FAKE_GITHUB_PORT}`;
export const FAKE_GITHUB_API = `${FAKE_GITHUB_WEB}/api`;

/** A test value only: the Worker under test signs its session cookies with it. */
const SESSION_SECRET = "e2e-session-secret-0123456789abcdef";

/** The Worker vars that make `wrangler dev` sign in through the stand-in, as `--var` arguments. */
export const GITHUB_VARS: readonly string[] = [
  `GITHUB_URL:${FAKE_GITHUB_WEB}`,
  `GITHUB_API_URL:${FAKE_GITHUB_API}`,
  `GITHUB_CLIENT_ID:${FAKE_CLIENT.id}`,
  `GITHUB_CLIENT_SECRET:${FAKE_CLIENT.secret}`,
  `SESSION_SECRET:${SESSION_SECRET}`,
  `OWNER_GITHUB_ID:${FAKE_ACCOUNTS.owner.id}`,
];
