/**
 * Where the specs' stand-in GitHub listens (`fake-github-server.ts`), and the configuration the Workers under test
 * are given: a session secret for both, and GitHub sign-in through the stand-in for the opt-in one. Test values only.
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

/** A test value only: the Workers under test sign their session cookies with it. */
export const SESSION_VARS: readonly string[] = [
  "SESSION_SECRET:e2e-session-secret-0123456789abcdef",
];

/** The Worker vars that enable GitHub sign-in, through the stand-in, as `--var` arguments: the opt-in Worker only. */
export const GITHUB_VARS: readonly string[] = [
  `GITHUB_URL:${FAKE_GITHUB_WEB}`,
  `GITHUB_API_URL:${FAKE_GITHUB_API}`,
  `GITHUB_CLIENT_ID:${FAKE_CLIENT.id}`,
  `GITHUB_CLIENT_SECRET:${FAKE_CLIENT.secret}`,
  `OWNER_GITHUB_ID:${FAKE_ACCOUNTS.owner.id}`,
];
