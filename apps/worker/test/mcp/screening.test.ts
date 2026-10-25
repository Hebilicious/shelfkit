/**
 * A call to a relayed tool is screened by the composition (`compose.ts`), every other message by AcidCat's binding.
 * `@acid-cat/core-ts` does not export the binding's message checks, so this runs the binding's whole rejection table
 * (`spec/bindings/mcp.md`, plus the revision and metadata checks) against a relayed name and against `shelf.search`,
 * and requires the two answers to be the same: status, the headers the rules name, and the JSON body (member order
 * aside). The two paths cannot drift apart.
 */
import { exports } from "cloudflare:workers";
import * as v from "valibot";
import { beforeAll, describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/mcp/wire.ts";
import { ORIGIN } from "../helpers.ts";

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };

interface Probe {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The body for a tool name, or `null` for none. */
  readonly body: (name: string) => BodyInit | null;
}

/** A call to `name`, with these params in place of the usual ones. */
function message(name: string, params?: JsonObject) {
  return JSON.stringify({
    id: 7,
    jsonrpc: "2.0",
    method: "tools/call",
    params: params ?? { _meta: META, arguments: {}, name },
  });
}

const PROBES = {
  "a GET": { body: () => null, method: "GET" },
  "a body over the limit": {
    body: (name) => message(name).padEnd(1_048_577, " "),
  },
  "a body that is not JSON": { body: (name) => `{"name":"${name}"` },
  "a body that is not UTF-8": {
    body: (name) =>
      new Uint8Array([
        ...new TextEncoder().encode(`{"name":"${name}","x":"`),
        0xff,
        ...new TextEncoder().encode(`"}`),
      ]),
  },
  "a notification": {
    body: (name) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { _meta: META, name },
      }),
  },
  "another media type": {
    body: (name) => message(name),
    headers: { "content-type": "text/plain" },
  },
  "another origin": {
    body: (name) => message(name),
    headers: { origin: "https://evil.example" },
  },
  "another revision": {
    body: (name) => message(name),
    headers: { "mcp-protocol-version": "2025-06-18" },
  },
  "metadata for another revision": {
    body: (name) =>
      message(name, {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
        name,
      }),
  },
  "no metadata": {
    body: (name) => message(name, { name }),
  },
  "no revision header": {
    body: (name) => message(name),
    headers: { "mcp-protocol-version": "" },
  },
} satisfies Readonly<Record<string, Probe>>;

/** The parts of an answer the binding's rules govern. */
async function answerTo(probe: Probe, name: string) {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-protocol-version": VERSION,
  });
  for (const [header, headerValue] of Object.entries(probe.headers ?? {})) {
    if (headerValue === "") {
      headers.delete(header);
    } else {
      headers.set(header, headerValue);
    }
  }
  const response = await exports.default.fetch(`${ORIGIN}/mcp`, {
    body: probe.body(name),
    headers,
    method: probe.method ?? "POST",
  });
  const text = await response.text();
  return {
    allow: response.headers.get("allow"),
    body: text === "" ? null : v.parse(v.unknown(), JSON.parse(text)),
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    status: response.status,
  };
}

describe("a relayed call", () => {
  // The first request loads the Worker's modules; a hook, with its longer timeout, takes that cost, not the first probe.
  beforeAll(async () => {
    const health = await exports.default.fetch(`${ORIGIN}/health`);
    await health.arrayBuffer();
  });

  it.each(Object.keys(PROBES))(
    "is answered as AcidCat answers a call to shelf.search: %s",
    async (probe) => {
      const sent: Probe = new Map<string, Probe>(Object.entries(PROBES)).get(
        probe
      ) ?? { body: () => null };
      const relayed = await answerTo(sent, "linear__list_issues");
      const own = await answerTo(sent, "shelf.search");
      expect(relayed).toStrictEqual(own);
    }
  );

  it("is rejected with the binding's statuses", async () => {
    const statuses = await Promise.all(
      Object.entries(PROBES).map(async ([probe, sent]) => {
        const answered = await answerTo(sent, "linear__list_issues");
        return [probe, answered.status] as const;
      })
    );
    expect(Object.fromEntries(statuses)).toStrictEqual({
      "a GET": 405,
      "a body over the limit": 413,
      "a body that is not JSON": 400,
      "a body that is not UTF-8": 400,
      "a notification": 200,
      "another media type": 415,
      "another origin": 403,
      "another revision": 400,
      "metadata for another revision": 400,
      "no metadata": 400,
      "no revision header": 400,
    });
  });
});
