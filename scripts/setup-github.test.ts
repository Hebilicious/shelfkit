/**
 * What setup decides, checked without Wrangler, `gh`, or GitHub: `moon run root:test`.
 */
import { once } from "node:events";
import { createServer, IncomingMessage, request } from "node:http";

import { describe, expect, it } from "vitest";

import {
  appManifest,
  deployCommand,
  isAddressInfo,
  loopbackHandler,
  OWNER_LOOKUP,
  readSecretListing,
} from "./setup-github.ts";

describe("the owner's account", () => {
  it("is asked of github.com itself, whatever GH_HOST says", () => {
    expect(OWNER_LOOKUP).toStrictEqual([
      "api",
      "--hostname",
      "github.com",
      "user",
    ]);
  });
});

describe("the deploy", () => {
  it("carries no secret, so none is written to a file", () => {
    expect(
      deployCommand().filter((part) => part.startsWith("--secrets"))
    ).toStrictEqual([]);
  });
});

describe("listing the Worker's secrets", () => {
  it("reads the names, and a Worker that does not exist as having none", () => {
    expect([
      readSecretListing(
        {
          status: 0,
          stderr: "",
          stdout: '[{"name":"SESSION_SECRET","type":"secret_text"}]',
        },
        "shelfkit"
      ),
      // What Wrangler 4.134.0 prints for a Worker that does not exist, colours included.
      readSecretListing(
        {
          status: 1,
          stderr: `\u001B[31m✘ \u001B[41;31m[\u001B[41;97mERROR\u001B[41;31m]\u001B[0m \u001B[1mWorker "shelfkit" not found.\u001B[0m\n\n  If this is a new Worker, run \`wrangler deploy\` first to create it.\n`,
          stdout: "",
        },
        "shelfkit"
      ),
      // Colours inside the message, wherever a version puts them, are stripped before it is read.
      readSecretListing(
        {
          status: 1,
          stderr: 'Worker \u001B[33m"shelfkit"\u001B[0m not found.',
          stdout: "",
        },
        "shelfkit"
      ),
      // What other versions print: Cloudflare's API error code for it.
      readSecretListing(
        {
          status: 1,
          stderr: "This Worker does not exist on your account. [code: 10007]",
          stdout: "",
        },
        "shelfkit"
      ),
    ]).toStrictEqual([
      { kind: "listed", names: new Set(["SESSION_SECRET"]) },
      { kind: "no-worker" },
      { kind: "no-worker" },
      { kind: "no-worker" },
    ]);
  });

  it("stops setup on any other failure, another Worker's included, rather than replace every secret", () => {
    for (const stderr of [
      "Authentication error [code: 10000]",
      'Worker "shelfkit-staging" not found.',
    ]) {
      expect(() =>
        readSecretListing({ status: 1, stderr, stdout: "" }, "shelfkit")
      ).toThrow(/cannot tell which exist/u);
    }
  });
});

describe("the app's manifest", () => {
  it("registers a callback for every address the deployment answers on, and asks for nothing", () => {
    const manifest = appManifest(
      ["https://shelfkit.example.workers.dev", "https://shelf.example.com"],
      "http://127.0.0.1:4000/"
    );
    expect({
      callbacks: manifest.callback_urls,
      permissions: manifest.default_permissions,
      redirect: manifest.redirect_url,
    }).toStrictEqual({
      callbacks: [
        "https://shelfkit.example.workers.dev/auth/github/callback",
        "https://shelf.example.com/auth/github/callback",
      ],
      permissions: {},
      redirect: "http://127.0.0.1:4000/created",
    });
  });
});

/** Serve the loopback handler on a free port; `codes` records each code it hands over. */
async function loopback() {
  const codes: string[] = [];
  let page = "";
  const server = createServer(
    loopbackHandler({
      created: (code) => {
        codes.push(code);
      },
      deployments: ["https://shelfkit.example.workers.dev"],
      page: () => page,
      state: "the-state",
      target: "https://github.com/settings/apps/new",
    })
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = isAddressInfo(address) ? address.port : 0;
  page = `http://127.0.0.1:${port}/`;
  // `node:http`, not `fetch`, which does not let a caller choose the `Host` header.
  const get = async (
    path: string,
    host = `127.0.0.1:${port}`
  ): Promise<number> => {
    const sent = request({ headers: { host }, host: "127.0.0.1", path, port });
    const answered = once(sent, "response");
    sent.end();
    const answers: unknown[] = await answered;
    const [response] = answers;
    if (!(response instanceof IncomingMessage)) {
      return 0;
    }
    response.resume();
    await once(response, "end");
    return response.statusCode ?? 0;
  };
  return { codes, get, server };
}

describe("the loopback page", () => {
  it("answers only on its own address", async () => {
    const { get, server } = await loopback();
    try {
      await expect(
        Promise.all([get("/", "rebound.example:80"), get("/", "localhost")])
      ).resolves.toStrictEqual([421, 421]);
    } finally {
      server.close();
    }
  });

  it("serves the manifest once, and takes one callback carrying its state", async () => {
    const { codes, get, server } = await loopback();
    try {
      const statuses: number[] = [];
      for (const path of [
        "/",
        "/",
        "/created?code=forged",
        "/created?code=forged&state=wrong",
        "/created?code=real&state=the-state",
        "/created?code=again&state=the-state",
      ]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the order of the requests is the point.
        statuses.push(await get(path));
      }
      expect({ codes, statuses }).toStrictEqual({
        codes: ["real"],
        statuses: [200, 410, 400, 400, 200, 400],
      });
    } finally {
      server.close();
    }
  });
});
