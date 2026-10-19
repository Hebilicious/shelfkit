/**
 * The stand-in GitHub the Playwright specs sign in through, as a local server: `FakeGitHub`
 * (`apps/worker/test/fake-github.ts`) behind Node's HTTP server. `playwright.config.ts` starts it and points the
 * Worker's `GITHUB_URL` and `GITHUB_API_URL` at it. It listens on `127.0.0.1`, while the SPA is served from
 * `localhost`, so coming back from it is a cross-site navigation, as coming back from github.com is.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";

import { FakeGitHub } from "../../../worker/test/fake-github.ts";
import {
  FAKE_GITHUB_API,
  FAKE_GITHUB_PORT,
  FAKE_GITHUB_WEB,
} from "./github.ts";
import { BASE_URL } from "./ports.ts";

// The app is registered with the Worker under test's callback only, as setup registers a deployment's.
const github = new FakeGitHub(FAKE_GITHUB_WEB, FAKE_GITHUB_API, [
  `${BASE_URL}/auth/github/callback`,
]);

/** Answer one request with the stand-in. */
async function answer(
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<void> {
  if (incoming.url === "/_ready") {
    outgoing.writeHead(204).end();
    return;
  }
  const body = new Uint8Array(await buffer(incoming));
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const request = new Request(`${FAKE_GITHUB_WEB}${incoming.url ?? "/"}`, {
    body: body.byteLength === 0 ? undefined : body,
    headers,
    method: incoming.method ?? "GET",
  });
  const response = await github.fetch(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(new Uint8Array(await response.arrayBuffer()));
}

/** Answer, or say what went wrong: a stand-in that fails must fail the spec visibly, not hang it. */
async function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse
): Promise<void> {
  try {
    await answer(incoming, outgoing);
  } catch (error) {
    outgoing.writeHead(500).end(String(error));
  }
}

const server = createServer((incoming, outgoing) => {
  void serve(incoming, outgoing);
});

server.listen(FAKE_GITHUB_PORT, "127.0.0.1");
