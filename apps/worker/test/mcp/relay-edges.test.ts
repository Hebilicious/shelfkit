/**
 * The relay's hard cases, against `https://edge.example` (`edges.ts`): an upstream that echoes the credential it was
 * sent, answers that are not MCP, a call that must not run twice, and listings that are slow, repeated, or too big.
 * Every one ends in a tool result or a listing, never in a `500`, and never with the credential in it.
 */
import { capabilities } from "@shelfkit/schema";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../../src/auth/index.ts";
import { redact, secretForms } from "../../src/mcp/redact.ts";
import { createKey, push, shelfOf } from "../helpers.ts";
import { call, rpc, textOf, toolNames } from "./client.ts";
import { Upstreams } from "./upstreams.ts";

const owner: Session = { keyId: "owner", kind: "owner" };
const READING_TOOLS: readonly string[] = capabilities
  .map((capability) => capability.id)
  .filter((id) => id !== "shelf.report");

/** The value the test Worker holds for `LINEAR_API_KEY`. */
const TOKEN = "test-linear-token";
const LEAKS = new RegExp(`${TOKEN}|${btoa(TOKEN)}`, "u");

const ITEMS = [
  "echo",
  "bad",
  "broken",
  "generic",
  "dupe",
  "slow",
  "huge",
] as const;

/** The shelf `edge`: one hosted item per path of the stand-in, each sent the credential. */
const EDGE_SHELF = shelfOf(
  "edge",
  false,
  Object.fromEntries(
    ITEMS.map((id) => [
      `items/mcp/${id}/item.json`,
      `${JSON.stringify({
        flavour: "hosted",
        headers: { Authorization: { secret: "LINEAR_API_KEY" } },
        id,
        kind: "mcp",
        title: id,
        url: `https://edge.example/${id}`,
      })}\n`,
    ])
  )
);

async function keyFor(...items: (typeof ITEMS)[number][]): Promise<string> {
  const key = await createKey(
    "edge",
    items.map((item) => `mcp:edge/${item}`)
  );
  return key.secret;
}

describe("redaction", () => {
  it("knows a credential as written, after its scheme, and in base64", () => {
    const basic = `Basic ${btoa("user:pa55word")}`;
    expect(secretForms(["Bearer s3cr3t-token"])).toStrictEqual(
      expect.arrayContaining([
        "Bearer s3cr3t-token",
        "s3cr3t-token",
        btoa("s3cr3t-token"),
      ])
    );
    expect(secretForms([basic])).toStrictEqual(
      expect.arrayContaining([basic, "user:pa55word", "pa55word"])
    );
  });

  it("removes every form from strings and keys at any depth", () => {
    const forms = secretForms(["Bearer s3cr3t-token"]);
    const redacted = redact(
      v.looseObject({}),
      {
        list: ["has s3cr3t-token inside", { "s3cr3t-token": 1 }],
        text: `Bearer s3cr3t-token and ${btoa("s3cr3t-token")}`,
      },
      forms
    );
    expect(JSON.stringify(redacted)).not.toMatch(
      /s3cr3t-token|czNjcjN0LXRva2Vu/u
    );
    expect(redacted).toMatchObject({ list: [expect.any(String), {}] });
  });
});

describe("the relay at its edges", () => {
  let upstreams = new Upstreams();

  beforeEach(async () => {
    await reset();
    await abortAllDurableObjects();
    const pushed = await push("edge", EDGE_SHELF);
    if (pushed.errors.length > 0) {
      throw new Error(
        `the shelf did not push: ${JSON.stringify(pushed.errors)}`
      );
    }
    await env.SHELF.get(env.SHELF.idFromName("edge")).putSecretName(
      owner,
      "edge",
      "LINEAR_API_KEY",
      "https://edge.example"
    );
    upstreams = new Upstreams();
    vi.spyOn(globalThis, "fetch").mockImplementation(upstreams.fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never returns a credential an upstream echoes, in an error, a result, or a listing", async () => {
    const key = await keyFor("echo");
    const failed = await call("echo__error", {}, key);
    const answered = await call("echo__content", {}, key);
    const listed = await rpc("tools/list", {}, key);
    // The upstream did receive it: the echo is real, and only the relay's answer is clean.
    expect(
      upstreams.to("https://edge.example").at(-1)?.headers.authorization
    ).toBe(TOKEN);
    expect(failed.result?.isError).toBeTruthy();
    expect(failed.reply.text).not.toMatch(LEAKS);
    expect(answered.reply.text).not.toMatch(LEAKS);
    expect(listed.text).not.toMatch(LEAKS);
  });

  it("answers an upstream result that is not a tool result with a refusal, not a 500", async () => {
    const key = await keyFor("bad");
    const { reply, result } = await call("bad__tool", {}, key);
    expect(reply.status).toBe(200);
    expect(result?.isError).toBeTruthy();
    expect(result === undefined ? null : textOf(result)).toMatchObject({
      kind: "unavailable",
    });
  });

  it("answers an event stream that fails before its answer with a refusal, not a 500", async () => {
    const key = await keyFor("broken");
    const { reply, result } = await call("broken__tool", {}, key);
    expect(reply.status).toBe(200);
    expect(result?.isError).toBeTruthy();
  });

  it("never replays a call that reached the upstream and got a JSON-RPC answer", async () => {
    const key = await keyFor("generic");
    const generic = await call("generic__generic", {}, key);
    const invalid = await call("generic__invalid", {}, key);
    const sent = upstreams
      .to("https://edge.example")
      .map((received) => received.rpc);
    expect(generic.result?.isError).toBeTruthy();
    expect(invalid.result?.isError).toBeTruthy();
    expect(sent).toStrictEqual(["tools/call", "tools/call"]);
  });

  it("lists a tool an upstream lists twice once", async () => {
    const key = await keyFor("dupe");
    await expect(toolNames(key)).resolves.toStrictEqual(["dupe__x", "dupe__y"]);
  });

  it("bounds the relayed listing, and lists ShelfKit's own tools and the other items' without the slow one", async () => {
    const key = await createKey("edge", [
      "read",
      "mcp:edge/slow",
      "mcp:edge/dupe",
    ]);
    // The slow server would hold the listing for the relay's 30 s per-request deadline; the test's timeout, well
    // below that and well above the 5 s listing deadline, is the hang guard.
    const names = await toolNames(key.secret);
    expect(names).toStrictEqual([...READING_TOOLS, "dupe__x", "dupe__y"]);
  }, 20_000);

  it("caps what one request buffers from relayed servers: an item over the budget lists nothing", async () => {
    const key = await keyFor("huge", "dupe");
    await expect(toolNames(key)).resolves.toStrictEqual(["dupe__x", "dupe__y"]);
  });
});
