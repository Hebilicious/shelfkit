/**
 * Recorded HTTP for the adapter tests. Each fixture in `fixtures/http/` holds the answers the real APIs gave to
 * read-only requests, keyed by method and URL (and a POST's body), so the tests run offline and deterministically.
 *
 * To record again, run the tests with `SHELFKIT_RECORD=1`: requests go to the network, and each fixture file is
 * rewritten with what was asked of it. Recording only ever sends what the adapters send, which is GETs and GraphQL
 * queries. Nothing in the gate records. GitHub allows 60 anonymous API requests an hour; set
 * `SHELFKIT_RECORD_GITHUB_TOKEN` (for example to `$(gh auth token)`) to record past that.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface Answer {
  readonly status: number;
  readonly contentType?: string;
  readonly json?: unknown;
  readonly text?: string;
  readonly base64?: string;
}

interface Fixture {
  readonly recorded: string;
  readonly responses: Record<string, Answer>;
}

function byCodePoint(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

const DIRECTORY = join(import.meta.dirname, "fixtures", "http");

export const recording = process.env.SHELFKIT_RECORD === "1";

function keyOf(input: RequestInfo | URL, init?: RequestInit): string {
  const url = input instanceof Request ? input.url : String(input);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  return method === "GET"
    ? url
    : `${method} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function respond(answer: Answer): Response {
  const headers =
    answer.contentType === undefined
      ? undefined
      : { "content-type": answer.contentType };
  if (answer.json !== undefined) {
    return new Response(JSON.stringify(answer.json), {
      headers,
      status: answer.status,
    });
  }
  if (answer.base64 !== undefined) {
    return new Response(Buffer.from(answer.base64, "base64"), {
      headers,
      status: answer.status,
    });
  }
  return new Response(answer.text ?? "", { headers, status: answer.status });
}

/** The license of a file name, as `isLicenceFile` reads it. */
const LICENCE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/iu;

/**
 * Keep a recorded GitHub answer to what the adapters read, so fixtures stay small: a repository's default branch
 * and licence, a commit's SHA, and, in a one-level directory listing, its directories, its licence files, and the
 * files some other request named. A recursive listing (one artifact's directory) is kept whole.
 */
function trim(
  url: string,
  json: unknown,
  requested: readonly string[]
): unknown {
  if (
    !url.startsWith("https://api.github.com/repos/") ||
    typeof json !== "object" ||
    json === null
  ) {
    return json;
  }
  const value = json as Record<string, unknown>;
  if (/\/repos\/[^/]+\/[^/]+$/u.test(url)) {
    const license = value.license as { spdx_id?: unknown } | null | undefined;
    return {
      default_branch: value.default_branch,
      license:
        license === null || license === undefined
          ? null
          : { spdx_id: license.spdx_id },
    };
  }
  if (url.includes("/commits/")) {
    return { sha: value.sha };
  }
  if (url.includes("/git/trees/") && Array.isArray(value.tree)) {
    const recursive = url.endsWith("?recursive=1");
    const tree = (
      value.tree as { path: string; sha: string; size?: number; type: string }[]
    )
      .filter(
        (entry) =>
          recursive ||
          entry.type === "tree" ||
          LICENCE.test(entry.path) ||
          requested.some((other) => other.includes(`/${entry.path}`))
      )
      .map((entry) => ({
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        type: entry.type,
      }));
    return { sha: value.sha, tree, truncated: value.truncated };
  }
  return json;
}

/** What a recorded `fetch` gives a test: the stand-in, and the keys it was asked for. */
export interface Recorded {
  readonly fetch: typeof fetch;
  readonly requests: string[];
  /** Write the fixture back when recording; a no-op otherwise. */
  readonly save: () => void;
}

/**
 * A `fetch` over the fixture `name`. A request the fixture does not hold fails the test loudly, naming the request,
 * rather than answering a 404 that would read as "upstream is gone".
 */
export function recorded(name: string): Recorded {
  const file = join(DIRECTORY, `${name}.json`);
  const fixture: Fixture = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Fixture)
    : { recorded: "", responses: {} };
  const responses: Record<string, Answer> = recording
    ? {}
    : { ...fixture.responses };
  const requests: string[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const key = keyOf(input, init);
    requests.push(key);
    if (!recording) {
      const answer = responses[key];
      if (answer === undefined) {
        throw new Error(`not recorded in ${name}.json: ${key}`);
      }
      return respond(answer);
    }
    // Recording may borrow a GitHub token for the rate limit; it is sent to api.github.com only and never stored.
    const token = process.env.SHELFKIT_RECORD_GITHUB_TOKEN;
    const url = input instanceof Request ? input.url : String(input);
    const authorized =
      token !== undefined && url.startsWith("https://api.github.com/")
        ? {
            ...init,
            headers: {
              ...(init?.headers as Record<string, string>),
              authorization: `Bearer ${token}`,
            },
          }
        : init;
    const response = await fetch(input, authorized);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? undefined;
    let answer: Answer = { contentType, status: response.status };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (contentType?.includes("json") === true) {
      try {
        answer = { ...answer, json: JSON.parse(text) as unknown };
      } catch {
        answer = { ...answer, text };
      }
    } else if (
      new TextEncoder().encode(text).length === bytes.length &&
      !text.includes("�")
    ) {
      answer = { ...answer, text };
    } else {
      answer = { ...answer, base64: toBase64(bytes) };
    }
    responses[key] = answer;
    return respond(answer);
  };

  return {
    fetch: fetcher,
    requests,
    save: () => {
      if (!recording) {
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      const keys = Object.keys(responses);
      const sorted = Object.fromEntries(
        Object.entries(responses)
          .toSorted(([a], [b]) => byCodePoint(a, b))
          .map(([key, answer]) => [
            key,
            answer.json === undefined
              ? answer
              : { ...answer, json: trim(key, answer.json, keys) },
          ])
      );
      writeFileSync(
        file,
        `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), responses: sorted }, null, 2)}\n`
      );
    },
  };
}

/** An adapter context over a recorded `fetch`, with no secrets and a fixed clock. */
export function contextOf(fetcher: typeof fetch): {
  fetch: typeof fetch;
  now: () => string;
  secret: (name: string) => string | undefined;
} {
  return {
    fetch: fetcher,
    now: () => "2026-10-19T00:00:00Z",
    secret: () => undefined,
  };
}
