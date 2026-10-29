/**
 * A stand-in for Cloudflare Artifacts, for tests only. Wrangler never simulates Artifacts, so the tests answer the
 * `ARTIFACTS` binding, and the Git remotes of its repositories, with this. Its state lives in the test deployment's R2
 * under `fake-artifacts/`, so `reset()` from `cloudflare:test` clears it with the shelves it belongs to.
 *
 * It keeps what the Worker uses: repositories with refs and decoded objects, tokens with a scope and an expiry, and
 * Git's smart HTTP for pushing (read with the engine's `gitReceive`) and for the ref advertisement. It does not serve
 * a pack to a clone: `git-upload-pack` answers with the request it was sent, so a test can see what was relayed.
 */
import type { GitObject } from "@shelfkit/engine";
import { env } from "cloudflare:workers";

import { engine } from "../src/engine.ts";

/** The origin of every stand-in repository's Git remote. */
export const FAKE_REMOTE = "https://artifacts.test";

const PREFIX = "fake-artifacts/";
const ZERO = "0".repeat(40);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REMOTE_PATH =
  /^\/git\/(?<name>[^/]+)\.git\/(?<rest>info\/refs|git-upload-pack|git-receive-pack)$/u;

interface Token {
  readonly id: string;
  readonly plaintext: string;
  readonly scope: "read" | "write";
  readonly createdAt: string;
  readonly expiresAt: string;
  revoked: boolean;
}

interface Repository {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  readonly readOnly: boolean;
  readonly source: string | null;
  refs: Record<string, string>;
  tokens: Token[];
}

type StoredObject =
  | { readonly kind: "blob"; readonly contents: string }
  | {
      readonly kind: "tree";
      readonly entries: readonly {
        readonly name: string;
        readonly mode: string;
        readonly id: string;
      }[];
    }
  | {
      readonly kind: "commit";
      readonly tree: string;
      readonly parents: readonly string[];
      readonly author: { readonly name: string; readonly email: string };
      readonly committer: { readonly name: string; readonly email: string };
      readonly authoredAt: number;
      readonly committedAt: number;
      readonly message: string;
    };

/** A public repository `import()` may read, by URL: its files, by path. */
export type Upstream = Readonly<Record<string, string>>;

/** The binding, and what a test reads back from it. */
export interface FakeArtifacts extends Artifacts {
  /** Public repositories `import()` may read, by URL. */
  readonly upstreams: Map<string, Upstream>;
  /** Every Git request a remote answered, newest last. */
  readonly requests: { method: string; path: string; headers: Headers }[];
  /** The Git remotes: `https://artifacts.test/git/<name>.git/...`. */
  readonly fetch: typeof fetch;
}

function artifactsError(code: ArtifactsErrorCode, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    name: "ArtifactsError",
    numericCode: 0,
  });
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes));
}

function unbase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A pkt-line: four hex digits of length, then the data. */
function pkt(line: string): string {
  return `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
}

async function readRepository(name: string): Promise<Repository | null> {
  const found = await env.BLOBS.get(`${PREFIX}${name}/repository.json`);
  return found === null ? null : await found.json<Repository>();
}

async function mustReadRepository(name: string): Promise<Repository> {
  const found = await readRepository(name);
  if (found === null) {
    throw artifactsError("NOT_FOUND", `no repository ${name}`);
  }
  return found;
}

async function writeRepository(repository: Repository): Promise<void> {
  await env.BLOBS.put(
    `${PREFIX}${repository.name}/repository.json`,
    JSON.stringify(repository)
  );
}

async function readObject(
  name: string,
  id: string
): Promise<StoredObject | null> {
  const found = await env.BLOBS.get(`${PREFIX}${name}/objects/${id}`);
  return found === null ? null : await found.json<StoredObject>();
}

const TYPES = new Map<string, ArtifactsTreeEntryType>([
  ["100644", "blob"],
  ["100755", "exec"],
  ["120000", "symlink"],
  ["160000", "gitlink"],
  ["40000", "tree"],
]);

function tokenState(token: Token): "active" | "expired" | "revoked" {
  if (token.revoked) {
    return "revoked";
  }
  return Date.parse(token.expiresAt) < Date.now() ? "expired" : "active";
}

function remoteOf(name: string): string {
  return `${FAKE_REMOTE}/git/${name}.git`;
}

async function createToken(
  name: string,
  scope: "read" | "write",
  ttl: number
): Promise<ArtifactsCreateTokenResult> {
  if (ttl < 60 || ttl > 31_536_000) {
    throw artifactsError("INVALID_TTL", `ttl ${ttl} is out of range`);
  }
  const repository = await mustReadRepository(name);
  const token: Token = {
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    id: crypto.randomUUID(),
    plaintext: `art_fake_${crypto.randomUUID().replaceAll("-", "")}`,
    revoked: false,
    scope,
  };
  repository.tokens.push(token);
  await writeRepository(repository);
  return {
    expiresAt: token.expiresAt,
    id: token.id,
    plaintext: token.plaintext,
    scope,
  };
}

async function readTree(
  name: string,
  hash: string
): Promise<ArtifactsTreeEntry[] | null> {
  const found = await readObject(name, hash);
  if (found === null) {
    return null;
  }
  if (found.kind !== "tree") {
    throw artifactsError("INTERNAL_ERROR", `${hash} is not a tree`);
  }
  return found.entries.map((entry) => ({
    hash: entry.id,
    mode: entry.mode,
    name: entry.name,
    type: TYPES.get(entry.mode) ?? "blob",
  }));
}

async function readBlob(name: string, hash: string): Promise<Blob | null> {
  const found = await readObject(name, hash);
  return found?.kind === "blob" ? new Blob([unbase64(found.contents)]) : null;
}

async function readCommit(
  name: string,
  hash: string
): Promise<ArtifactsCommitMetadata | null> {
  const found = await readObject(name, hash);
  if (found === null) {
    return null;
  }
  if (found.kind !== "commit") {
    throw artifactsError("INTERNAL_ERROR", `${hash} is not a commit`);
  }
  return {
    author: found.author,
    authoredAt: found.authoredAt,
    committedAt: found.committedAt,
    committer: found.committer,
    hash,
    message: found.message.replace(/\n$/u, ""),
    parents: [...found.parents],
    treeHash: found.tree,
  };
}

async function log(
  name: string,
  opts: { ref?: string; limit?: number; offset?: number }
): Promise<ArtifactsCommitMetadata[]> {
  const repository = await mustReadRepository(name);
  // As Artifacts does: an imported repository lists nothing for any named ref, `HEAD` and its branch included.
  if (repository.source !== null && opts.ref !== undefined) {
    return [];
  }
  const ref = opts.ref ?? "HEAD";
  const branch = ref === "HEAD" ? repository.defaultBranch : ref;
  let id: string | undefined =
    repository.refs[`refs/heads/${branch}`] ??
    repository.refs[branch] ??
    (/^[0-9a-f]{40}$/u.test(ref) ? ref : undefined);
  const commits: ArtifactsCommitMetadata[] = [];
  const limit = Math.min(opts.limit ?? 50, 1000);
  const offset = opts.offset ?? 0;
  while (id !== undefined && commits.length < offset + limit) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the first-parent chain, one commit after another.
    const commit = await readCommit(name, id);
    if (commit === null) {
      break;
    }
    commits.push(commit);
    [id] = commit.parents;
  }
  return commits.slice(offset);
}

async function readFile(
  name: string,
  ref: string,
  path: string
): Promise<Blob | null> {
  const [head] = await log(name, { limit: 1, ref });
  let id = head?.treeHash;
  for (const part of path.split("/")) {
    if (id === undefined) {
      return null;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- each tree is found in the one before.
    const entries = await readTree(name, id);
    id = entries?.find((entry) => entry.name === part)?.hash;
  }
  return id === undefined ? null : await readBlob(name, id);
}

async function repoInfo(name: string): Promise<ArtifactsRepoInfo> {
  const repository = await mustReadRepository(name);
  return {
    createdAt: repository.createdAt,
    defaultBranch: repository.defaultBranch,
    description: repository.description,
    id: repository.id,
    lastPushAt: repository.lastPushAt,
    name: repository.name,
    readOnly: repository.readOnly,
    remote: remoteOf(repository.name),
    source: repository.source,
    updatedAt: repository.updatedAt,
  };
}

async function revokeToken(name: string, tokenOrId: string): Promise<boolean> {
  const repository = await mustReadRepository(name);
  const token = repository.tokens.find(
    (candidate) =>
      candidate.id === tokenOrId || candidate.plaintext === tokenOrId
  );
  if (token === undefined) {
    return false;
  }
  token.revoked = true;
  await writeRepository(repository);
  return true;
}

/** The repository capability `get()` answers. */
function fakeRepo(name: string): ArtifactsRepo {
  return {
    createToken: async (scope = "write", ttl = 86_400) =>
      await createToken(name, scope, ttl),
    fork: async () => {
      await mustReadRepository(name);
      throw artifactsError("INTERNAL_ERROR", "the stand-in does not fork");
    },
    info: async () => await repoInfo(name),
    listTokens: async () => {
      const repository = await mustReadRepository(name);
      return {
        tokens: repository.tokens.map((token) => ({
          createdAt: token.createdAt,
          expiresAt: token.expiresAt,
          id: token.id,
          scope: token.scope,
          state: tokenState(token),
        })),
        total: repository.tokens.length,
      };
    },
    log: async (opts = {}) => await log(name, opts),
    readBlob: async (hash) => await readBlob(name, hash),
    readCommit: async (hash) => await readCommit(name, hash),
    readFile: async ({ ref, path }) => await readFile(name, ref, path),
    readTree: async (hash) => await readTree(name, hash),
    revokeToken: async (tokenOrId) => await revokeToken(name, tokenOrId),
    [Symbol.dispose]: () => {
      // Nothing to release.
    },
  };
}

async function createRepository(
  name: string,
  opts: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  source: string | null
): Promise<ArtifactsCreateRepoResult> {
  if (!NAME.test(name)) {
    throw artifactsError("INVALID_REPO_NAME", `bad name ${name}`);
  }
  if ((await readRepository(name)) !== null) {
    throw artifactsError("ALREADY_EXISTS", `${name} exists`);
  }
  const repository: Repository = {
    createdAt: nowIso(),
    defaultBranch: opts.setDefaultBranch ?? "main",
    description: opts.description ?? null,
    id: crypto.randomUUID(),
    lastPushAt: null,
    name,
    readOnly: opts.readOnly ?? false,
    refs: {},
    source,
    tokens: [],
    updatedAt: nowIso(),
  };
  await writeRepository(repository);
  const token = await createToken(name, "write", 86_400);
  return {
    defaultBranch: repository.defaultBranch,
    description: repository.description,
    id: repository.id,
    name,
    remote: remoteOf(name),
    token: token.plaintext,
  };
}

/** A decoded object as the stand-in stores it. */
function stored(object: GitObject): StoredObject {
  if (object.kind === "tree") {
    return { entries: object.entries, kind: "tree" };
  }
  if (object.kind === "commit") {
    return {
      author: object.author,
      authoredAt: object.authoredAt,
      committedAt: object.committedAt,
      committer: object.committer,
      kind: "commit",
      message: object.message,
      parents: object.parents,
      tree: object.tree,
    };
  }
  return { contents: base64(object.contents), kind: "blob" };
}

/** Apply a `git-receive-pack` request: store its objects, move each ref whose old value still holds. */
async function receive(name: string, body: Uint8Array): Promise<string> {
  const shelfEngine = await engine();
  const received = shelfEngine.gitReceive(body);
  if (!received.ok) {
    return `${pkt(`unpack ${received.errors.map((error) => error.message).join("; ")}\n`)}0000`;
  }
  const repository = await mustReadRepository(name);
  await Promise.all(
    received.value.objects.map(async (object) => {
      await env.BLOBS.put(
        `${PREFIX}${name}/objects/${object.id}`,
        JSON.stringify(stored(object))
      );
    })
  );
  const lines = [pkt("unpack ok\n")];
  for (const update of received.value.updates) {
    const current = repository.refs[update.name] ?? ZERO;
    if (current !== update.old) {
      lines.push(pkt(`ng ${update.name} fetch first\n`));
      continue;
    }
    const refs = new Map(Object.entries(repository.refs));
    if (update.new === ZERO) {
      refs.delete(update.name);
    } else {
      refs.set(update.name, update.new);
    }
    repository.refs = Object.fromEntries(refs);
    lines.push(pkt(`ok ${update.name}\n`));
  }
  repository.lastPushAt = nowIso();
  repository.updatedAt = repository.lastPushAt;
  await writeRepository(repository);
  return `${lines.join("")}0000`;
}

function advertise(repository: Repository, service: string): Response {
  const capabilities =
    service === "git-receive-pack"
      ? "report-status delete-refs ofs-delta agent=fake-artifacts"
      : "agent=fake-artifacts";
  const lines = Object.entries(repository.refs).map(([ref, id], index) =>
    pkt(index === 0 ? `${id} ${ref}\0${capabilities}\n` : `${id} ${ref}\n`)
  );
  if (lines.length === 0) {
    lines.push(pkt(`${ZERO} capabilities^{}\0${capabilities}\n`));
  }
  return new Response(
    `${pkt(`# service=${service}\n`)}0000${lines.join("")}0000`,
    { headers: { "content-type": `application/x-${service}-advertisement` } }
  );
}

/** Refuse a request without a live token of `repository` that allows `service`; null when it has one. */
function refused(
  repository: Repository,
  request: Request,
  service: string | null
): Response | null {
  const presented = /^Bearer (?<token>.+)$/u.exec(
    request.headers.get("authorization") ?? ""
  )?.groups?.token;
  const token = repository.tokens.find(
    (candidate) => candidate.plaintext === presented
  );
  if (token === undefined || tokenState(token) !== "active") {
    return new Response("unauthorized", { status: 401 });
  }
  if (service === "git-receive-pack" && token.scope !== "write") {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

/** Answer one request to a stand-in Git remote, recording it in `requests`. */
async function serveRemote(
  request: Request,
  requests: FakeArtifacts["requests"]
): Promise<Response> {
  const url = new URL(request.url);
  const match = REMOTE_PATH.exec(url.pathname)?.groups;
  const repository =
    url.origin === FAKE_REMOTE && match?.name !== undefined
      ? await readRepository(match.name)
      : null;
  if (match === undefined || repository === null) {
    return new Response("no such repository", { status: 404 });
  }
  requests.push({
    headers: request.headers,
    method: request.method,
    path: `${url.pathname}${url.search}`,
  });
  const service =
    match.rest === "info/refs" ? url.searchParams.get("service") : match.rest;
  const refusal = refused(repository, request, service ?? null);
  if (refusal !== null) {
    return refusal;
  }
  if (match.rest === "info/refs") {
    return advertise(repository, service ?? "");
  }
  if (match.rest === "git-upload-pack") {
    return new Response(await request.arrayBuffer(), {
      headers: { "content-type": "application/x-git-upload-pack-result" },
    });
  }
  const report = await receive(
    repository.name,
    new Uint8Array(await request.arrayBuffer())
  );
  return new Response(report, {
    headers: { "content-type": "application/x-git-receive-pack-result" },
  });
}

/** Import a repository registered in `upstreams` as one commit on its branch. */
async function importUpstream(
  upstreams: ReadonlyMap<string, Upstream>,
  params: Parameters<Artifacts["import"]>[0]
): Promise<ArtifactsCreateRepoResult> {
  const files = upstreams.get(params.source.url);
  if (files === undefined) {
    throw artifactsError("NOT_FOUND", `no repository at ${params.source.url}`);
  }
  const branch = params.source.branch ?? "main";
  const created = await createRepository(
    params.target.name,
    { ...params.target.opts, setDefaultBranch: branch },
    params.source.url
  );
  const shelfEngine = await engine();
  const planned = shelfEngine.gitCommit({
    author: {
      email: "upstream@example.com",
      name: "Upstream",
      offset: 0,
      time: 0,
    },
    base: [],
    files: Object.entries(files).map(([path, contents]) => ({
      contents: new TextEncoder().encode(contents),
      path,
    })),
    message: "upstream",
    ref: `refs/heads/${branch}`,
  });
  if (!planned.ok || planned.value.request === null) {
    throw artifactsError("INTERNAL_ERROR", "the upstream is empty");
  }
  await receive(params.target.name, planned.value.request);
  return created;
}

async function listRepositories(
  limit: number
): Promise<ArtifactsRepoListResult> {
  const listed = await env.BLOBS.list({ delimiter: "/", prefix: PREFIX });
  const names = listed.delimitedPrefixes.map((prefix) =>
    prefix.slice(PREFIX.length, -1)
  );
  const repos = await Promise.all(
    names.slice(0, limit).map(async (name) => {
      const { remote: _remote, ...listedInfo } = await repoInfo(name);
      return listedInfo;
    })
  );
  return { repos, total: names.length };
}

async function deleteRepository(name: string): Promise<boolean> {
  const listed = await env.BLOBS.list({ prefix: `${PREFIX}${name}/` });
  if (listed.objects.length === 0) {
    return false;
  }
  await env.BLOBS.delete(listed.objects.map((object) => object.key));
  return true;
}

/** A new stand-in. */
export function createFakeArtifacts(): FakeArtifacts {
  const upstreams = new Map<string, Upstream>();
  const requests: FakeArtifacts["requests"] = [];
  return {
    create: async (name, opts = {}) => await createRepository(name, opts, null),
    delete: async (name) => await deleteRepository(name),
    fetch: async (input, init) =>
      await serveRemote(new Request(input, init), requests),
    get: async (name) => {
      await mustReadRepository(name);
      return fakeRepo(name);
    },
    import: async (params) => await importUpstream(upstreams, params),
    list: async (opts = {}) => await listRepositories(opts.limit ?? 100),
    requests,
    upstreams,
  };
}

/**
 * The one stand-in every test file shares, and whether the deployment under test has Artifacts: without, it keeps its
 * repositories in R2, as local mode does.
 */
export const fakeArtifacts = createFakeArtifacts();
export const repositories = { artifacts: true };
