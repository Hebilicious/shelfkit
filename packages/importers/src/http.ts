/**
 * Reading third-party HTTP APIs through the adapter's `fetch`. Every answer is parsed with the schema the caller
 * expects before it leaves this module, and every failure names the URL it came from, because an import that fails
 * without saying where is an import nobody can fix.
 */
import * as v from "valibot";

/** An HTTP answer that is not a success, kept with its URL. `status` 0 means the request never got an answer. */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number, detail: string) {
    super(`${url}: ${detail}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/** The headers every request sends. */
interface RequestHeaders {
  accept: string;
  "user-agent": string;
  authorization?: string;
  "content-type"?: string;
}

/** Request headers: a bearer token only when the caller has one. */
export function headers(accept: string, token?: string): RequestHeaders {
  const out: RequestHeaders = { accept, "user-agent": "shelfkit-importer" };
  if (token !== undefined && token !== "") {
    out.authorization = `Bearer ${token}`;
  }
  return out;
}

async function send(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    throw new HttpError(url, 0, `request failed: ${String(error)}`);
  }
}

/** Whether an answer means "not there": drift reads a 404 or 410 as an answer, not a failure. */
function missing(response: Response): boolean {
  return response.status === 404 || response.status === 410;
}

/** The most any one answer may hold; a larger one is refused, not read. */
export const MAX_ANSWER_BYTES = 10 * 1024 * 1024;

/** Read a body, refusing it as soon as it passes `maxBytes`. */
async function readCapped(
  url: string,
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new HttpError(
      url,
      response.status,
      `the answer is ${declared} bytes, more than the ${maxBytes} read`
    );
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk after another.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the stream is abandoned once, and the loop ends.
      await reader.cancel();
      throw new HttpError(
        url,
        response.status,
        `the answer is more than the ${maxBytes} bytes read`
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Parse a JSON body with `schema`, naming the URL when it is not JSON or not that shape. */
async function parseBody<const TSchema extends v.GenericSchema>(
  url: string,
  response: Response,
  schema: TSchema
): Promise<v.InferOutput<TSchema>> {
  const text = new TextDecoder().decode(
    await readCapped(url, response, MAX_ANSWER_BYTES)
  );
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(url, response.status, "the answer is not JSON");
  }
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) {
    throw new HttpError(
      url,
      response.status,
      `the answer is not what was expected: ${parsed.issues
        .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.output;
}

/** GET a JSON document and parse it with `schema`. A 404 or 410 is `null`; any other failure throws. */
export async function getJson<const TSchema extends v.GenericSchema>(
  fetcher: typeof fetch,
  url: string,
  schema: TSchema,
  token?: string
): Promise<v.InferOutput<TSchema> | null> {
  const response = await send(fetcher, url, {
    headers: { ...headers("application/json", token) },
  });
  if (missing(response)) {
    return null;
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new HttpError(
      url,
      response.status,
      `HTTP ${response.status}: ${detail.slice(0, 200)}`
    );
  }
  return await parseBody(url, response, schema);
}

/** How to GET bytes: the token for the request, the type to accept, and the most to read. */
export interface ByteRequest {
  readonly token?: string;
  readonly accept?: string;
  readonly maxBytes?: number;
}

/** GET bytes. A 404 or 410 is `null`; an answer larger than `maxBytes` is refused. */
export async function getBytes(
  fetcher: typeof fetch,
  url: string,
  request: ByteRequest = {}
): Promise<Uint8Array | null> {
  const response = await send(fetcher, url, {
    headers: { ...headers(request.accept ?? "*/*", request.token) },
  });
  if (missing(response)) {
    return null;
  }
  if (!response.ok) {
    throw new HttpError(url, response.status, `HTTP ${response.status}`);
  }
  return await readCapped(url, response, request.maxBytes ?? MAX_ANSWER_BYTES);
}

const GraphQLErrorsSchema = v.object({
  errors: v.optional(v.array(v.object({ message: v.string() }))),
});

/**
 * POST a GraphQL query and parse its `data` with `schema`; GraphQL errors throw with their messages.
 *
 * BOUNDARY: `variables` are whatever JSON the operation declares.
 */
export async function graphql<const TSchema extends v.GenericSchema>(
  fetcher: typeof fetch,
  url: string,
  query: string,
  variables: Readonly<Record<string, string>>,
  schema: TSchema
): Promise<v.InferOutput<TSchema>> {
  const response = await send(fetcher, url, {
    body: JSON.stringify({ query, variables }),
    headers: {
      ...headers("application/json"),
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new HttpError(url, response.status, `HTTP ${response.status}`);
  }
  const body = await parseBody(
    url,
    response,
    v.object({ ...GraphQLErrorsSchema.entries, data: v.nullish(schema) })
  );
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new HttpError(
      url,
      response.status,
      body.errors.map((error) => error.message).join("; ")
    );
  }
  if (body.data === undefined || body.data === null) {
    throw new HttpError(url, response.status, "the answer has no data");
  }
  return body.data;
}

/** A file's contents as an import carries them: UTF-8 text, or base64 for bytes that are not UTF-8. */
export interface FileContents {
  contents: string;
  encoding: "utf-8" | "base64";
}

/** Bytes as `FileContents`: UTF-8 text when the bytes are UTF-8, base64 otherwise. */
export function fileContents(bytes: Uint8Array): FileContents {
  try {
    return {
      contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    };
  } catch {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCodePoint(byte);
    }
    return { contents: btoa(binary), encoding: "base64" };
  }
}

/** The bytes of a file's contents. */
export function fileBytes(file: FileContents): Uint8Array {
  if (file.encoding === "utf-8") {
    return new TextEncoder().encode(file.contents);
  }
  return Uint8Array.from(
    atob(file.contents),
    (char) => char.codePointAt(0) ?? 0
  );
}

/** Lowercase hex SHA-256 of some bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes. */
export async function sha256OfText(text: string): Promise<string> {
  return await sha256Hex(new TextEncoder().encode(text));
}

/** Any JSON value, as an upstream document holds it. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export const JsonSchema: v.GenericSchema<Json> = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(v.lazy(() => JsonSchema)),
  v.record(
    v.string(),
    v.lazy(() => JsonSchema)
  ),
]);

/** Order strings by code point, as the shelf loader orders paths; `localeCompare` would fold case. */
export function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * JSON with every object's keys sorted and no whitespace: the form an upstream document is hashed in, so the hosted
 * importer and `shelfkit doctor` (whose `canonical_json` sorts the same way) compute the same digest.
 */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  }
  if (value !== null && v.is(v.record(v.string(), JsonSchema), value)) {
    const entries = Object.entries(value).toSorted(([a], [b]) =>
      byCodePoint(a, b)
    );
    return `{${entries.map(([key, element]) => `${JSON.stringify(key)}:${canonicalJson(element)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
