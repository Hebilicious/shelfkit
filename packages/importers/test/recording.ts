/**
 * Recorded HTTP for the adapter tests. Each fixture in `fixtures/http/` holds the answers the real APIs gave to
 * read-only requests, keyed by URL for a GET and by method, URL, and body otherwise, so the tests run offline and
 * deterministically. `shelfkit doctor`'s tests (`crates/compiler/tests/curation.rs`) replay the same files.
 *
 * To record again, run one test file at a time with `SHELFKIT_RECORD=1` (several files share a fixture): requests
 * go to the network, and each fixture keeps what it had and gains or refreshes what was asked of it. Recording only
 * ever sends what the adapters send, which is GETs and GraphQL queries. GitHub allows 60 anonymous API requests an
 * hour; set `SHELFKIT_RECORD_GITHUB_TOKEN` (for example to `$(gh auth token)`) to record past that. The token goes to
 * api.github.com only and is never stored. Nothing in the gate records.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as v from "valibot";

import { byCodePoint, JsonSchema } from "../src/http.ts";
import type { Json } from "../src/http.ts";
import type { AdapterContext } from "../src/index.ts";

const AnswerSchema = v.object({
  base64: v.optional(v.string()),
  contentType: v.optional(v.string()),
  json: v.optional(JsonSchema),
  status: v.number(),
  text: v.optional(v.string()),
});

type Answer = v.InferOutput<typeof AnswerSchema>;

const FixtureSchema = v.object({
  recorded: v.string(),
  responses: v.record(v.string(), AnswerSchema),
});

const DIRECTORY = path.join(import.meta.dirname, "fixtures", "http");

export const recording = process.env.SHELFKIT_RECORD === "1";

function urlOf(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }
  return input instanceof URL ? input.href : input;
}

function keyOf(input: RequestInfo | URL, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = v.is(v.string(), init?.body) ? init.body : "";
  return method === "GET" ? urlOf(input) : `${method} ${urlOf(input)} ${body}`;
}

function respond(answer: Answer): Response {
  const init: ResponseInit = { status: answer.status };
  if (answer.contentType !== undefined) {
    init.headers = { "content-type": answer.contentType };
  }
  if (answer.json !== undefined) {
    return Response.json(answer.json, init);
  }
  if (answer.base64 !== undefined) {
    return new Response(Buffer.from(answer.base64, "base64"), init);
  }
  return new Response(answer.text ?? "", init);
}

const LICENCE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/iu;

const RepoSchema = v.object({
  default_branch: v.string(),
  license: v.nullish(v.object({ spdx_id: v.nullish(v.string()) })),
});

const TreeSchema = v.object({
  sha: v.string(),
  tree: v.array(
    v.object({
      path: v.string(),
      sha: v.string(),
      size: v.optional(v.number()),
      type: v.string(),
    })
  ),
  truncated: v.optional(v.boolean()),
});

/** A one-level listing's entries worth keeping: directories, licence files, and files another request named. */
function kept(
  json: v.InferOutput<typeof TreeSchema>,
  recursive: boolean,
  requested: readonly string[]
): Json {
  const tree = json.tree
    .filter(
      (entry) =>
        recursive ||
        entry.type === "tree" ||
        LICENCE.test(entry.path) ||
        requested.some((other) => other.includes(`/${entry.path}`))
    )
    .map((entry): Json =>
      entry.size === undefined
        ? { path: entry.path, sha: entry.sha, type: entry.type }
        : {
            path: entry.path,
            sha: entry.sha,
            size: entry.size,
            type: entry.type,
          }
    );
  return json.truncated === undefined
    ? { sha: json.sha, tree }
    : { sha: json.sha, tree, truncated: json.truncated };
}

/**
 * Keep a recorded GitHub answer to what the adapters read, so fixtures stay small: a repository's default branch
 * and licence, a commit's SHA, and, in a one-level directory listing, its directories, its licence files, and the
 * files some other request named. A recursive listing (one artifact's directory) is kept whole.
 */
function trimmed(url: string, json: Json, requested: readonly string[]): Json {
  if (!url.startsWith("https://api.github.com/repos/")) {
    return json;
  }
  const repo = v.safeParse(RepoSchema, json);
  if (/\/repos\/[^/]+\/[^/]+$/u.test(url) && repo.success) {
    const spdx = repo.output.license?.spdx_id ?? null;
    return {
      default_branch: repo.output.default_branch,
      license: repo.output.license ? { spdx_id: spdx } : null,
    };
  }
  const commit = v.safeParse(v.object({ sha: v.string() }), json);
  if (url.includes("/commits/") && commit.success) {
    return { sha: commit.output.sha };
  }
  const tree = v.safeParse(TreeSchema, json);
  if (url.includes("/git/trees/") && tree.success) {
    return kept(tree.output, url.endsWith("?recursive=1"), requested);
  }
  return json;
}

/**
 * Content that imports as a link (it has no licence that permits a copy) is not committed here either: of these
 * files, a recording keeps only the YAML frontmatter, which is all the adapter reads of them.
 */
const LINK_ONLY_CONTENT = [
  "/anthropics/skills/",
  "/ComposioHQ/awesome-claude-skills/",
];

/** Whether a recorded URL is the SKILL.md of an artifact that imports as a link. */
function linkOnlySkill(url: string): boolean {
  return (
    url.startsWith("https://raw.githubusercontent.com/") &&
    url.endsWith("/SKILL.md") &&
    LINK_ONLY_CONTENT.some((repo) => url.includes(repo)) &&
    (url.includes("/doc-coauthoring/") ||
      url.includes("/domain-name-brainstormer/") ||
      url.includes("/skills/docx/"))
  );
}

/** A SKILL.md cut to its frontmatter. */
function frontmatterOnly(text: string): string {
  const end = text.indexOf("\n---", 4);
  return end === -1 ? "" : `${text.slice(0, end + 4)}\n`;
}

/** What a fixture keeps of an answer. */
function stored(key: string, answer: Answer, keys: readonly string[]): Answer {
  if (answer.json !== undefined) {
    return { ...answer, json: trimmed(key, answer.json, keys) };
  }
  if (linkOnlySkill(key) && answer.text !== undefined) {
    return { ...answer, text: frontmatterOnly(answer.text) };
  }
  return answer;
}

/** What a recorded `fetch` gives a test: the stand-in, and the keys it was asked for. */
export interface Recorded {
  readonly fetch: typeof fetch;
  readonly requests: string[];
  /** Write the fixture back when recording; a no-op otherwise. */
  readonly save: () => void;
}

/** The answer to record for a live response. */
async function answerOf(response: Response): Promise<Answer> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? undefined;
  const text = new TextDecoder("utf-8").decode(bytes);
  if (contentType?.includes("json") === true) {
    try {
      // BOUNDARY: a live answer is untyped until JsonSchema reads it.
      const json = v.parse(JsonSchema, JSON.parse(text));
      return { contentType, json, status: response.status };
    } catch {
      return { contentType, status: response.status, text };
    }
  }
  const textual =
    new TextEncoder().encode(text).length === bytes.length &&
    !text.includes("\uFFFD");
  return textual
    ? { contentType, status: response.status, text }
    : {
        base64: Buffer.from(bytes).toString("base64"),
        contentType,
        status: response.status,
      };
}

/** Send a request to the network for recording, with the GitHub token only for api.github.com. */
async function live(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const token = process.env.SHELFKIT_RECORD_GITHUB_TOKEN;
  if (
    token === undefined ||
    !urlOf(input).startsWith("https://api.github.com/")
  ) {
    return await fetch(input, init);
  }
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetch(input, { ...init, headers });
}

/**
 * A `fetch` over the fixture `name`. A request the fixture does not hold fails the test loudly, naming the request,
 * rather than answering a 404 that would read as "upstream is gone".
 */
export function recorded(name: string): Recorded {
  const file = path.join(DIRECTORY, `${name}.json`);
  const fixture = existsSync(file)
    ? v.parse(FixtureSchema, JSON.parse(readFileSync(file, "utf-8")))
    : { recorded: "", responses: {} };
  const responses = new Map(Object.entries(fixture.responses));
  const requests: string[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const key = keyOf(input, init);
    requests.push(key);
    if (!recording) {
      const answer = responses.get(key);
      if (answer === undefined) {
        throw new Error(`not recorded in ${name}.json: ${key}`);
      }
      return respond(answer);
    }
    const answer = await answerOf(await live(input, init));
    responses.set(key, answer);
    return respond(answer);
  };

  return {
    fetch: fetcher,
    requests,
    save: () => {
      if (!recording) {
        return;
      }
      const keys = [...responses.keys()];
      const sorted = [...responses.entries()]
        .toSorted(([a], [b]) => byCodePoint(a, b))
        .map(([key, answer]): [string, Answer] => [
          key,
          stored(key, answer, keys),
        ]);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), responses: Object.fromEntries(sorted) }, null, 2)}\n`
      );
    },
  };
}

/** An adapter context over a recorded `fetch`, with no secrets and a fixed clock. */
export function contextOf(fetcher: typeof fetch): AdapterContext {
  const secrets = new Map<string, string>();
  return {
    fetch: fetcher,
    now: () => "2026-10-19T00:00:00Z",
    secret: (name) => secrets.get(name),
  };
}
