/** Talking to the Worker under test the way a client does: over HTTP, through its default export. */
import { exports } from "cloudflare:workers";
import * as v from "valibot";

import { TEST_OWNER_KEY } from "./owner-key.ts";

export const ORIGIN = "https://shelfkit.test";
export { TEST_OWNER_KEY } from "./owner-key.ts";

const GraphQLResponseSchema = v.object({
  data: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
  errors: v.optional(
    v.array(
      v.object({
        extensions: v.optional(
          v.object({
            code: v.optional(v.string()),
            retryAfter: v.optional(v.number()),
          })
        ),
        message: v.string(),
      })
    )
  ),
});

export type GraphQLAnswer = v.InferOutput<typeof GraphQLResponseSchema> & {
  readonly status: number;
  readonly headers: Headers;
};

/**
 * POST a GraphQL operation, with `key` as a Bearer key when given. BOUNDARY: `variables` are whatever JSON the operation
 * declares; the server parses them.
 */
export async function graphql(
  query: string,
  variables: Record<string, unknown> = {},
  key?: string,
  headers: Record<string, string> = {}
): Promise<GraphQLAnswer> {
  const sent = new Headers({ "content-type": "application/json" });
  if (key !== undefined) {
    sent.set("authorization", `Bearer ${key}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    sent.set(name, value);
  }
  const response = await exports.default.fetch(`${ORIGIN}/graphql`, {
    body: JSON.stringify({ query, variables }),
    headers: sent,
    method: "POST",
  });
  const text = await response.text();
  if (response.status === 401) {
    return { headers: response.headers, status: 401 };
  }
  return {
    ...v.parse(GraphQLResponseSchema, JSON.parse(text)),
    headers: response.headers,
    status: response.status,
  };
}

/**
 * The `data` of an operation that must succeed. BOUNDARY: `variables` are whatever JSON the operation declares; the
 * server parses them.
 */
export async function data<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  query: string,
  variables: Record<string, unknown> = {},
  key: string = TEST_OWNER_KEY
): Promise<v.InferOutput<TSchema>> {
  const answer = await graphql(query, variables, key);
  if (answer.errors !== undefined && answer.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(answer.errors)}`);
  }
  return v.parse(schema, answer.data);
}

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  );
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CommitSchema = v.object({
  commitSnapshot: v.object({
    errors: v.array(v.object({ message: v.string(), path: v.string() })),
    ok: v.boolean(),
    snapshot: v.nullable(v.object({ digest: v.string() })),
  }),
});

/** Push a shelf as `shelfkit push` does: upload every file to `/raw`, then commit the snapshot. */
export async function push(
  shelf: string,
  files: Readonly<Record<string, string | Uint8Array<ArrayBuffer>>>,
  key: string = TEST_OWNER_KEY
): Promise<v.InferOutput<typeof CommitSchema>["commitSnapshot"]> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, contents]) => {
      const bytes =
        contents instanceof Uint8Array
          ? contents
          : new TextEncoder().encode(contents);
      const hash = await sha256(bytes);
      const uploaded = await exports.default.fetch(
        `${ORIGIN}/raw/${shelf}/objects/${hash}`,
        {
          body: bytes,
          headers: { authorization: `Bearer ${key}` },
          method: "PUT",
        }
      );
      if (uploaded.status !== 204) {
        throw new Error(
          `uploading ${path} answered ${uploaded.status}: ${await uploaded.text()}`
        );
      }
      return { path, sha256: hash, size: bytes.length };
    })
  );
  const found = await data(
    CommitSchema,
    `mutation Push($shelf: ID!, $files: [SnapshotFileInput!]!) {
      commitSnapshot(shelf: $shelf, files: $files) { ok errors { path message } snapshot { digest } }
    }`,
    { files: entries, shelf },
    key
  );
  return found.commitSnapshot;
}

/** A small shelf: `shelf.json` with the namespace, plus whatever files are given. */
export function shelfOf(
  namespace: string,
  isPublic: boolean,
  files: Readonly<Record<string, string>> = {}
) {
  return {
    "shelf.json": `${JSON.stringify({ name: namespace, registry: { namespace, public: isPublic } }, null, 2)}\n`,
    ...files,
  };
}

/** A shelf's files from a provided fixture, with its namespace replaced by `namespace`. */
export function fixtureShelf(
  fixture: Readonly<Record<string, string>>,
  namespace: string,
  isPublic = false
) {
  const files: Record<string, Uint8Array<ArrayBuffer> | string> = {};
  for (const [path, contents] of Object.entries(fixture)) {
    files[path] = decodeBase64(contents);
  }
  const manifest = v.parse(
    v.record(v.string(), v.unknown()),
    JSON.parse(
      new TextDecoder().decode(decodeBase64(fixture["shelf.json"] ?? ""))
    )
  );
  files["shelf.json"] =
    `${JSON.stringify({ ...manifest, registry: { namespace, public: isPublic } }, null, 2)}\n`;
  return files;
}

const KeySchema = v.object({
  createKey: v.object({
    key: v.object({ id: v.string() }),
    secret: v.string(),
  }),
});

/** Create a scoped key with the owner key. */
export async function createKey(
  shelf: string,
  scopes: readonly string[],
  name = "test"
): Promise<{ readonly id: string; readonly secret: string }> {
  const found = await data(
    KeySchema,
    `mutation Key($shelf: ID!, $name: String!, $scopes: [String!]!) {
      createKey(shelf: $shelf, name: $name, scopes: $scopes) { key { id } secret }
    }`,
    { name, scopes, shelf }
  );
  return { id: found.createKey.key.id, secret: found.createKey.secret };
}
