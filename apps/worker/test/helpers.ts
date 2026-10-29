/**
 * Talking to the Worker under test the way a client does: over HTTP, through its default export; Git included. Its
 * Artifacts binding is Miniflare's local simulator, which the helpers at the end reach directly, around the Worker.
 */
import { env, exports } from "cloudflare:workers";
import * as v from "valibot";

import { engine } from "../src/engine.ts";
import { shelfRepository } from "../src/repository/index.ts";
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

/** What a push answered once the shelf's object had indexed it: the snapshot it made, or why there is none. */
export interface Pushed {
  readonly ok: boolean;
  readonly errors: readonly {
    readonly message: string;
    readonly path: string;
  }[];
  readonly snapshot: { readonly digest: string } | null;
  /** The commit pushed; null when the push was refused before it reached the repository. */
  readonly commit: string | null;
}

const system = { job: "repository.sync", kind: "system" } as const;

/** HTTP Basic, as a Git client's credential helper sends a key: any user name, the key as the password. */
export function basic(key: string): string {
  return `Basic ${btoa(`git:${key}`)}`;
}

/** The commit `main` is at in the shelf's repository, read from the push advertisement as `git push` reads it. */
async function branchHead(
  shelf: string,
  key: string
): Promise<{ readonly head: string | null } | { readonly refused: Response }> {
  const response = await exports.default.fetch(
    `${ORIGIN}/git/${shelf}.git/info/refs?service=git-receive-pack`,
    { headers: { authorization: basic(key) } }
  );
  if (!response.ok) {
    return { refused: response };
  }
  const advertised = new TextDecoder().decode(await response.arrayBuffer());
  return {
    head:
      /(?<id>[0-9a-f]{40}) refs\/heads\/main/u.exec(advertised)?.groups?.id ??
      null,
  };
}

const SnapshotSchema = v.object({
  shelf: v.nullable(
    v.object({ snapshot: v.nullable(v.object({ digest: v.string() })) })
  ),
});

/** A push the Git route refused before it reached the repository: no key, or not one that may write. */
async function refusedBy(response: Response): Promise<Pushed> {
  return {
    commit: null,
    errors: [{ message: await response.text(), path: "<shelf>" }],
    ok: false,
    snapshot: null,
  };
}

/**
 * Push a shelf as `git push` does: one commit of exactly `files`, on top of whatever `main` is at, through
 * `/git/{shelf}.git` with `key`. The route indexes the push before it answers; this then syncs once more, as the
 * `repository.sync` job would, to answer with the snapshot the push made or the errors that refused it.
 */
export async function push(
  shelf: string,
  files: Readonly<Record<string, string | Uint8Array<ArrayBuffer>>>,
  key: string = TEST_OWNER_KEY
): Promise<Pushed> {
  const found = await branchHead(shelf, key);
  if ("refused" in found) {
    return await refusedBy(found.refused);
  }
  const shelfEngine = await engine();
  const planned = shelfEngine.gitCommit({
    author: {
      email: "dev@example.com",
      name: "Dev",
      offset: 0,
      time: 1_700_000_000,
    },
    base: [],
    files: Object.entries(files).map(([path, contents]) => ({
      contents,
      path,
    })),
    message: "a push from a Git client",
    parent: found.head ?? undefined,
  });
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  const { commit, request, tree } = planned.value;
  // `git commit` makes no commit of the tree its parent already has, so neither does this.
  const head = await shelfRepository(env).head(shelf);
  if (request !== null && tree !== head?.tree) {
    const response = await exports.default.fetch(
      `${ORIGIN}/git/${shelf}.git/git-receive-pack`,
      {
        body: Uint8Array.from(request),
        headers: {
          authorization: basic(key),
          "content-type": "application/x-git-receive-pack-request",
        },
        method: "POST",
      }
    );
    if (!response.ok) {
      return await refusedBy(response);
    }
    const report = shelfEngine.gitReport(
      new Uint8Array(await response.arrayBuffer())
    );
    if (
      !report.ok ||
      !report.value.unpack.ok ||
      report.value.refs.some((ref) => !ref.ok)
    ) {
      throw new Error(
        `the repository refused the push: ${JSON.stringify(report)}`
      );
    }
  }
  const synced = await env.SHELF.get(
    env.SHELF.idFromName(shelf)
  ).syncRepository(system, shelf);
  if (synced.status === "refused") {
    return { commit, errors: synced.errors, ok: false, snapshot: null };
  }
  const indexed = await data(
    SnapshotSchema,
    "query Snapshot($shelf: ID!) { shelf(id: $shelf) { snapshot { digest } } }",
    { shelf }
  );
  return {
    commit: tree === head?.tree ? head.commit : commit,
    errors: [],
    ok: true,
    snapshot: indexed.shelf?.snapshot ?? null,
  };
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

/** Run `use` with an Artifacts repository's capability from the test deployment's binding, released afterwards. */
export async function withArtifactsRepo<T>(
  name: string,
  use: (repo: ArtifactsRepo) => Promise<T>
): Promise<T> {
  const repo = await env.ARTIFACTS.get(name);
  try {
    return await use(repo);
  } finally {
    repo[Symbol.dispose]();
  }
}

/**
 * Push one commit of exactly `files` straight to an Artifacts repository's Git remote with a token of its own, around
 * the Worker, as an operator with an Artifacts token would: on top of `parent`, or as a root commit. Planned with the
 * engine and sent with `fetch`, so no Git binary is needed. Returns the commit.
 */
export async function pushToRemote(
  remote: string,
  token: string,
  files: Readonly<Record<string, string>>,
  parent: string | null
): Promise<string> {
  const shelfEngine = await engine();
  const planned = shelfEngine.gitCommit({
    author: {
      email: "ops@example.com",
      name: "Ops",
      offset: 0,
      time: 1_700_000_000,
    },
    base: [],
    files: Object.entries(files).map(([path, contents]) => ({
      contents,
      path,
    })),
    message: "around the Worker",
    parent: parent ?? undefined,
  });
  if (!planned.ok || planned.value.request === null) {
    throw new Error(`nothing to push: ${JSON.stringify(planned)}`);
  }
  const response = await fetch(`${remote}/git-receive-pack`, {
    body: Uint8Array.from(planned.value.request),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-git-receive-pack-request",
    },
    method: "POST",
  });
  const report = shelfEngine.gitReport(
    new Uint8Array(await response.arrayBuffer())
  );
  if (
    !response.ok ||
    !report.ok ||
    !report.value.unpack.ok ||
    report.value.refs.some((ref) => !ref.ok)
  ) {
    throw new Error(
      `the remote refused the push (${response.status}): ${JSON.stringify(report)}`
    );
  }
  return planned.value.commit;
}
