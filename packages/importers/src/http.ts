/**
 * Reading third-party HTTP APIs through the adapter's `fetch`. Every failure names the URL it came from, because an
 * import that fails without saying where is an import nobody can fix.
 */

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

/** Request headers: a bearer token only when the caller has one. */
export function headers(
  accept: string,
  token?: string
): Record<string, string> {
  const out: Record<string, string> = {
    accept,
    "user-agent": "shelfkit-importer",
  };
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

/** GET a JSON document. A 404 or 410 is `null`, because "not there" is an answer drift needs; any other failure throws. */
export async function getJson(
  fetcher: typeof fetch,
  url: string,
  token?: string
): Promise<unknown> {
  const response = await send(fetcher, url, {
    headers: headers("application/json", token),
  });
  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (!response.ok) {
    throw new HttpError(
      url,
      response.status,
      `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new HttpError(url, response.status, "the answer is not JSON");
  }
}

/** GET bytes. A 404 or 410 is `null`. */
export async function getBytes(
  fetcher: typeof fetch,
  url: string,
  token?: string
): Promise<Uint8Array | null> {
  const response = await send(fetcher, url, {
    headers: headers("*/*", token),
  });
  if (response.status === 404 || response.status === 410) {
    return null;
  }
  if (!response.ok) {
    throw new HttpError(url, response.status, `HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** POST a GraphQL query and answer its `data`; GraphQL errors throw with their messages. */
export async function graphql(
  fetcher: typeof fetch,
  url: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
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
  const body = (await response.json()) as {
    data?: Record<string, unknown> | null;
    errors?: { message: string }[];
  };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new HttpError(
      url,
      response.status,
      body.errors.map((error) => error.message).join("; ")
    );
  }
  return body.data ?? {};
}

/** A file's contents for `ImportedFile`: UTF-8 text when the bytes are UTF-8, base64 otherwise. */
export function fileContents(bytes: Uint8Array): {
  contents: string;
  encoding: "utf-8" | "base64";
} {
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

/** Lowercase hex SHA-256 of some bytes. */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The bytes of an `ImportedFile`. */
export function fileBytes(file: {
  contents: string;
  encoding: "utf-8" | "base64";
}): Uint8Array {
  if (file.encoding === "utf-8") {
    return new TextEncoder().encode(file.contents);
  }
  return Uint8Array.from(
    atob(file.contents),
    (char) => char.codePointAt(0) ?? 0
  );
}

/**
 * JSON with every object's keys sorted and no whitespace: the form an upstream document is hashed in, so the hosted
 * importer and `shelfkit doctor` (serde_json, whose maps sort their keys) compute the same digest.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, element]) => element !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, element]) => `${JSON.stringify(key)}:${canonicalJson(element)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Order strings by code point, as the shelf loader orders paths; `localeCompare` would fold case. */
export function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
