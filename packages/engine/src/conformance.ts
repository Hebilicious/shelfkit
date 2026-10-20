/**
 * The registry conformance suite runner: `crates/registry/conformance/cases.json` against any host that answers HTTP.
 *
 * The Rust runner (`crates/registry/src/conformance.rs`) runs the same file against the library and against
 * `shelfkit serve`; this one is for TypeScript hosts, the Worker first. The format is documented in the Rust module.
 * Each scenario gets a fresh registry from `start`, serving one shelf under the suite's `owner`, public or not, with
 * the scenario's keys.
 */
import * as v from "valibot";

const HeaderMapSchema = v.record(v.string(), v.nullable(v.string()));

const StepSchema = v.strictObject({
  expect: v.strictObject({
    body: v.optional(v.strictObject({ archive: v.string() })),
    headers: v.optional(HeaderMapSchema),
    json: v.optional(v.lazy(() => JsonSchema)),
    problem: v.optional(v.boolean()),
    status: v.number(),
  }),
  name: v.string(),
  request: v.strictObject({
    auth: v.optional(
      v.union([
        v.strictObject({ bearer: v.string() }),
        v.strictObject({ basic: v.string() }),
        v.strictObject({ raw: v.string() }),
      ])
    ),
    body: v.optional(v.strictObject({ archive: v.string() })),
    headers: v.optional(v.record(v.string(), v.string())),
    method: v.string(),
    path: v.string(),
  }),
});

const ScenarioSchema = v.strictObject({
  keys: v.array(
    v.strictObject({
      key: v.string(),
      name: v.string(),
      scopes: v.array(v.string()),
    })
  ),
  name: v.string(),
  public: v.boolean(),
  steps: v.array(StepSchema),
});

export const SuiteSchema = v.strictObject({
  $comment: v.optional(v.array(v.string())),
  archives: v.record(
    v.string(),
    v.strictObject({ digest: v.string(), file: v.string() })
  ),
  owner: v.string(),
  scenarios: v.array(ScenarioSchema),
});

export type Suite = v.InferOutput<typeof SuiteSchema>;
export type Scenario = v.InferOutput<typeof ScenarioSchema>;
type Step = v.InferOutput<typeof StepSchema>;

export interface ConformanceRequest {
  readonly method: string;
  /** Relative to the registry's base URL. */
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: Uint8Array;
}

export interface ConformanceResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface Started {
  readonly send: (
    request: ConformanceRequest
  ) => Promise<ConformanceResponse> | ConformanceResponse;
  readonly stop?: () => Promise<void> | void;
}

/** What a token stands for, per archive. */
interface Facts {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly rfc3230: string;
}

/** Run every scenario and return every failure as `scenario / step: what differed`. */
export async function runConformance(
  suite: Suite,
  archives: ReadonlyMap<string, Uint8Array>,
  start: (scenario: Scenario) => Promise<Started> | Started
): Promise<string[]> {
  const entries = await Promise.all(
    [...archives].map(async ([name, bytes]) => {
      const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
      );
      const hex = [...hash].map((byte) => byte.toString(16).padStart(2, "0"));
      const found: Facts = {
        bytes,
        digest: `sha256:${hex.join("")}`,
        rfc3230: `sha256=${toBase64(hash)}`,
      };
      return [name, found] as const;
    })
  );
  const facts = new Map<string, Facts>(entries);
  const failures: string[] = [];
  // Scenarios and their steps run in order: each step depends on the registry state the ones before it left.
  for (const scenario of suite.scenarios) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one scenario's registry at a time, in order.
    const host = await start(scenario);
    try {
      for (const step of scenario.steps) {
        const label = `${scenario.name} / ${step.name}`;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- a step reads the state the previous step left.
          const response = await host.send(request(scenario, step, facts));
          for (const problem of check(step, response, facts)) {
            failures.push(`${label}: ${problem}`);
          }
        } catch (error) {
          failures.push(`${label}: ${String(error)}`);
        }
      }
    } finally {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a scenario's registry stops before the next starts.
      await host.stop?.();
    }
  }
  return failures;
}

function request(
  scenario: Scenario,
  step: Step,
  facts: ReadonlyMap<string, Facts>
): ConformanceRequest {
  const headers: [string, string][] = Object.entries(
    step.request.headers ?? {}
  ).map(([name, value]) => [name, tokenText(value, facts)]);
  const key = (name: string) => {
    const found = scenario.keys.find((entry) => entry.name === name);
    if (found === undefined) {
      throw new Error(`the scenario has no key \`${name}\``);
    }
    return found.key;
  };
  const { auth } = step.request;
  if (auth !== undefined) {
    if ("bearer" in auth) {
      headers.push(["Authorization", `Bearer ${key(auth.bearer)}`]);
    } else if ("basic" in auth) {
      const credentials = new TextEncoder().encode(
        `conformance:${key(auth.basic)}`
      );
      headers.push(["Authorization", `Basic ${toBase64(credentials)}`]);
    } else {
      headers.push(["Authorization", auth.raw]);
    }
  }
  const name = step.request.body?.archive;
  return {
    body: name === undefined ? undefined : fact(name, facts).bytes,
    headers,
    method: step.request.method,
    path: step.request.path,
  };
}

function check(
  step: Step,
  response: ConformanceResponse,
  facts: ReadonlyMap<string, Facts>
): string[] {
  const { expect } = step;
  const text = new TextDecoder().decode(response.body);
  if (response.status !== expect.status) {
    return [
      `status ${response.status} instead of ${expect.status} (body: ${text})`,
    ];
  }
  const parsed = parseJson(text);
  return [
    ...checkHeaders(expect.headers ?? {}, response.headers, facts),
    ...checkJson(expect.json, parsed, text, facts),
    ...(expect.problem === true ? checkProblem(response, parsed, text) : []),
    ...checkBody(expect.body?.archive, response.body, facts),
  ];
}

function checkHeaders(
  expected: Readonly<Record<string, string | null>>,
  headers: Headers,
  facts: ReadonlyMap<string, Facts>
): string[] {
  const problems: string[] = [];
  for (const [name, wanted] of Object.entries(expected)) {
    const actual = headers.get(name);
    if (wanted === null || actual === null) {
      if (wanted !== actual) {
        problems.push(
          `header ${name} is ${actual === null ? "missing" : `\`${actual}\``}, expected ${wanted === null ? "absent" : `\`${wanted}\``}`
        );
      }
      continue;
    }
    const value = tokenText(wanted, facts);
    const media = actual.split(";")[0]?.trim();
    if (value !== "$any" && actual !== value && media !== value) {
      problems.push(`header ${name} is \`${actual}\`, expected \`${value}\``);
    }
  }
  return problems;
}

function checkJson(
  expected: Json | undefined,
  parsed: Json | undefined,
  text: string,
  facts: ReadonlyMap<string, Facts>
): string[] {
  if (expected === undefined) {
    return [];
  }
  if (parsed === undefined) {
    return [`the body is not JSON: ${text}`];
  }
  const problems: string[] = [];
  matchJson(expected, parsed, "$", facts, problems);
  return problems;
}

function checkProblem(
  response: ConformanceResponse,
  parsed: Json | undefined,
  text: string
): string[] {
  const problems: string[] = [];
  const media = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (media !== "application/problem+json") {
    problems.push(`a problem's Content-Type is ${String(media)}`);
  }
  const body = isJsonObject(parsed) ? parsed : {};
  const title = v.safeParse(v.string(), body.title);
  if (!title.success || body.status !== response.status) {
    problems.push(
      `a problem needs a string \`title\` and \`status\` ${response.status}: ${text}`
    );
  }
  return problems;
}

function checkBody(
  archive: string | undefined,
  body: Uint8Array,
  facts: ReadonlyMap<string, Facts>
): string[] {
  if (archive === undefined) {
    return [];
  }
  return sameBytes(fact(archive, facts).bytes, body)
    ? []
    : [`the body is not the bytes of \`${archive}\` (${body.length} bytes)`];
}

function matchJson(
  expected: Json,
  actual: Json | undefined,
  at: string,
  facts: ReadonlyMap<string, Facts>,
  problems: string[]
): void {
  const token = v.safeParse(TokenSchema, expected);
  if (token.success) {
    if (token.output === "$any") {
      return;
    }
    const wanted = token.output.startsWith("$size:")
      ? fact(token.output.slice("$size:".length), facts).bytes.length
      : tokenText(token.output, facts);
    if (wanted !== actual) {
      problems.push(
        `${at} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`
      );
    }
    return;
  }
  if (isJsonArray(expected)) {
    if (!isJsonArray(actual) || actual.length !== expected.length) {
      problems.push(
        `${at} is ${JSON.stringify(actual)}, expected ${expected.length} elements`
      );
      return;
    }
    for (const [index, item] of expected.entries()) {
      matchJson(item, actual[index], `${at}[${index}]`, facts, problems);
    }
    return;
  }
  if (isJsonObject(expected)) {
    if (!isJsonObject(actual)) {
      problems.push(`${at} is ${JSON.stringify(actual)}, expected an object`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      const found = actual[key];
      if (found === undefined) {
        problems.push(`${at}.${key} is missing`);
      } else {
        matchJson(value, found, `${at}.${key}`, facts, problems);
      }
    }
    return;
  }
  if (expected !== actual) {
    problems.push(
      `${at} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    );
  }
}

/** A token's text (`$digest:`, `$etag:`, `$rfc3230:`, `$size:`), or the string itself when it is no token. */
function tokenText(token: string, facts: ReadonlyMap<string, Facts>): string {
  const groups = /^\$(?<kind>digest|etag|rfc3230|size):(?<name>.+)$/u.exec(
    token
  )?.groups;
  if (groups?.kind === undefined || groups.name === undefined) {
    return token;
  }
  const found = fact(groups.name, facts);
  if (groups.kind === "digest") {
    return found.digest;
  }
  if (groups.kind === "etag") {
    return `"${found.digest}"`;
  }
  if (groups.kind === "rfc3230") {
    return found.rfc3230;
  }
  return String(found.bytes.length);
}

function fact(name: string, facts: ReadonlyMap<string, Facts>): Facts {
  const found = facts.get(name);
  if (found === undefined) {
    throw new Error(`no archive \`${name}\``);
  }
  return found;
}

/** JSON: what the suite's `json` expectations and a response body are. */
type Json = string | number | boolean | null | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json;
}

const JsonSchema: v.GenericSchema<Json> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(JsonSchema),
    v.record(v.string(), JsonSchema),
  ])
);

/** A string token in a `json` expectation. */
const TokenSchema = v.pipe(v.string(), v.startsWith("$"));

function parseJson(text: string): Json | undefined {
  try {
    const parsed = v.safeParse(JsonSchema, JSON.parse(text));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

function isJsonArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

function isJsonObject(value: Json | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    v.is(v.record(v.string(), v.unknown()), value)
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}
