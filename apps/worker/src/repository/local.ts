/**
 * A Git repository the Worker keeps in R2 and serves itself, the engine reading and writing the protocol
 * (`crates/git`'s `serve`). Two kinds use it:
 *
 * - Every shelf's repository in local mode. Artifacts has no local simulator, and Wrangler says it never will, so a
 *   deployment without the `ARTIFACTS` binding is a `ShelfRepository` here. The rest is as it is with Artifacts: the
 *   Git route relays a client's exchange here, a write the Worker makes is a push here, and the shelf's object indexes
 *   the head of `main`.
 * - Every published profile's repository, in every mode (`src/packages.ts`), under `packages/`.
 *
 * Under `<prefix><name>/` in `BLOBS`: `refs`, every reference and its commit as JSON; `objects/<id>`, each
 * object's body, its kind in the custom metadata; and `decoded/<id>`, a tree's entries or a commit's fields as the
 * engine read them. A push stores its objects first and moves its references last, with R2's conditional write, so a
 * reader never follows a reference to an object that is not there, and two pushes cannot both move a branch from the
 * same commit.
 */
import type {
  GitKind,
  GitObject,
  GitReport,
  GitService,
  GitUploadRequest,
} from "@shelfkit/engine";
import * as v from "valibot";

import { engine } from "../engine.ts";
import { REPOSITORY_BRANCH } from "./model.ts";
import type {
  GitExchange,
  Pushed,
  RepositoryEntry,
  RepositoryHead,
  ShelfRepository,
} from "./model.ts";

/** Where shelves' repositories live in the bucket, in local mode. */
export const REPOSITORIES_PREFIX = "repositories/";
const ZERO = "0".repeat(40);
const MAIN = `refs/heads/${REPOSITORY_BRANCH}`;

/** The most entries a shelf's repository may hold, as with Artifacts. */
const MAX_ENTRIES = 5000;

/** How often a push re-reads the references when another push moved them first. */
const REF_ATTEMPTS = 5;

const RefsSchema = v.record(v.string(), v.string());

const DecodedSchema = v.variant("kind", [
  v.object({
    entries: v.array(
      v.object({
        id: v.string(),
        mode: v.picklist(["100644", "100755", "120000", "160000", "40000"]),
        name: v.string(),
      })
    ),
    kind: v.literal("tree"),
  }),
  v.object({
    kind: v.literal("commit"),
    message: v.string(),
    parents: v.array(v.string()),
    tree: v.string(),
  }),
]);

type Decoded = v.InferOutput<typeof DecodedSchema>;
type DecodedTree = Extract<Decoded, { kind: "tree" }>;
type DecodedCommit = Extract<Decoded, { kind: "commit" }>;

const KindSchema = v.picklist(["blob", "tree", "commit", "tag"]);

/** A repository's references, and the version of them a conditional write must match. */
interface Refs {
  readonly refs: Readonly<Record<string, string>>;
  readonly etag: string;
}

/** The body of an object a received pack holds. */
function bodyOf(object: GitObject): Uint8Array {
  return "contents" in object ? object.contents : object.body;
}

/** What a tree or a commit decodes to, stored beside its body; null for a blob or a tag. */
function decodedOf(object: GitObject): Decoded | null {
  if (object.kind === "tree") {
    return { entries: [...object.entries], kind: "tree" };
  }
  if (object.kind === "commit") {
    const { message, parents, tree } = object;
    return { kind: "commit", message, parents: [...parents], tree };
  }
  return null;
}

/** The ids an object names: a tree's entries, but not a gitlink's commit; a commit's tree and parents. */
function referencesOf(object: GitObject): string[] {
  if (object.kind === "tree") {
    return object.entries
      .filter((entry) => entry.mode !== "160000")
      .map((entry) => entry.id);
  }
  if (object.kind === "commit") {
    return [object.tree, ...object.parents];
  }
  return [];
}

/** A request's body, inflated when the client compressed it (Git compresses a large `git-upload-pack` request). */
async function bytesOf(request: GitExchange): Promise<Uint8Array> {
  const { body } = new Response(request.body);
  const stream =
    body !== null && request.headers.get("content-encoding") === "gzip"
      ? body.pipeThrough(new DecompressionStream("gzip"))
      : body;
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function gitResponse(body: Uint8Array, type: string): Response {
  return new Response(Uint8Array.from(body), {
    headers: { "cache-control": "no-cache", "content-type": type },
  });
}

function badRequest(message: string): Response {
  return new Response(message, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 400,
  });
}

export class LocalRepository implements ShelfRepository {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;

  /** Repositories under `prefix` in `bucket`, each named by the rest of its keys' path. */
  constructor(bucket: R2Bucket, prefix = REPOSITORIES_PREFIX) {
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  /** Where the repository `name` keeps `rest` in the bucket. */
  #key(name: string, rest: string): string {
    return `${this.#prefix}${name}/${rest}`;
  }

  /** Every reference of a repository and its commit, or null when there is no such repository. */
  readonly references = async (
    name: string
  ): Promise<Readonly<Record<string, string>> | null> => {
    const found = await this.#refs(name);
    return found?.refs ?? null;
  };

  async #refs(shelf: string): Promise<Refs | null> {
    const found = await this.#bucket.get(this.#key(shelf, "refs"));
    return found === null
      ? null
      : { etag: found.etag, refs: v.parse(RefsSchema, await found.json()) };
  }

  /** Create the repository, with no reference, unless it exists. */
  async #ensure(shelf: string): Promise<void> {
    if ((await this.#refs(shelf)) === null) {
      // A repository another request created first is left as it is: the write is refused, and nothing changes.
      await this.#bucket.put(this.#key(shelf, "refs"), "{}", {
        onlyIf: { etagDoesNotMatch: "*" },
      });
    }
  }

  async #decoded(shelf: string, id: string): Promise<Decoded> {
    const found = await this.#bucket.get(this.#key(shelf, `decoded/${id}`));
    if (found === null) {
      throw new Error(`the object ${id} is missing from ${shelf}'s repository`);
    }
    return v.parse(DecodedSchema, await found.json());
  }

  async #commit(shelf: string, id: string): Promise<DecodedCommit> {
    const decoded = await this.#decoded(shelf, id);
    if (decoded.kind !== "commit") {
      throw new Error(`${id} in ${shelf}'s repository is not a commit`);
    }
    return decoded;
  }

  async #tree(shelf: string, id: string): Promise<DecodedTree> {
    const decoded = await this.#decoded(shelf, id);
    if (decoded.kind !== "tree") {
      throw new Error(`${id} in ${shelf}'s repository is not a tree`);
    }
    return decoded;
  }

  async #object(
    shelf: string,
    id: string
  ): Promise<{ readonly kind: GitKind; readonly body: Uint8Array } | null> {
    const found = await this.#bucket.get(this.#key(shelf, `objects/${id}`));
    if (found === null) {
      return null;
    }
    return {
      body: new Uint8Array(await found.arrayBuffer()),
      kind: v.parse(KindSchema, found.customMetadata?.kind),
    };
  }

  async #has(shelf: string, id: string): Promise<boolean> {
    return (
      (await this.#bucket.head(this.#key(shelf, `objects/${id}`))) !== null
    );
  }

  readonly head = async (
    shelf: string,
    branch: string | null = REPOSITORY_BRANCH
  ): Promise<RepositoryHead | null> => {
    const found = await this.#refs(shelf);
    const id = found?.refs[`refs/heads/${branch ?? REPOSITORY_BRANCH}`];
    if (id === undefined) {
      return null;
    }
    const commit = await this.#commit(shelf, id);
    return { commit: id, message: commit.message, tree: commit.tree };
  };

  readonly entries = async (
    shelf: string,
    tree: string
  ): Promise<RepositoryEntry[]> => {
    const entries: RepositoryEntry[] = [];
    const walk = async (id: string, prefix: string): Promise<void> => {
      const subtrees: Promise<void>[] = [];
      const { entries: children } = await this.#tree(shelf, id);
      for (const child of children) {
        const path = `${prefix}${child.name}`;
        if (child.mode === "40000") {
          subtrees.push(walk(child.id, `${path}/`));
        } else {
          entries.push({ id: child.id, mode: child.mode, path });
        }
      }
      if (entries.length > MAX_ENTRIES) {
        throw new Error(
          `the repository has more than ${MAX_ENTRIES} files; a shelf's repository holds its shelf`
        );
      }
      await Promise.all(subtrees);
    };
    await walk(tree, "");
    return entries;
  };

  readonly blob = async (shelf: string, id: string): Promise<Uint8Array> => {
    const found = await this.#object(shelf, id);
    if (found === null) {
      throw new Error(`the blob ${id} is missing from ${shelf}'s repository`);
    }
    return found.body;
  };

  readonly push = async (
    shelf: string,
    request: Uint8Array,
    parent: string | null
  ): Promise<Pushed> => {
    await this.#ensure(shelf);
    const { unpack, refs } = await this.#receive(shelf, request);
    const refused = refs.find((ref) => !ref.ok);
    if (unpack.ok && refused === undefined && refs.length > 0) {
      return { ok: true };
    }
    const message = unpack.ok
      ? `the repository refused ${refused?.name ?? "the update"}: ${refused?.reason ?? "no reason given"}`
      : `the repository could not unpack the push: ${unpack.message}`;
    // A refused update is a conflict when the branch has moved on from `parent`: someone else pushed first.
    const head = await this.head(shelf);
    return {
      message,
      ok: false,
      reason: (head?.commit ?? null) === parent ? "failed" : "conflict",
    };
  };

  readonly exchange = async (
    shelf: string,
    request: GitExchange
  ): Promise<Response | null> => {
    if (request.scope === "write") {
      await this.#ensure(shelf);
    }
    const found = await this.#refs(shelf);
    if (found === null) {
      return null;
    }
    const shelfEngine = await engine();
    if (request.method === "GET") {
      const service: GitService =
        request.scope === "write" ? "git-receive-pack" : "git-upload-pack";
      const advertised = shelfEngine.gitAdvertise({
        head: MAIN,
        refs: Object.entries(found.refs)
          .toSorted(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, id]) => ({ id, name })),
        service,
      });
      if (!advertised.ok) {
        throw new Error(advertised.errors.map((e) => e.message).join("; "));
      }
      return gitResponse(
        advertised.value,
        `application/x-${service}-advertisement`
      );
    }
    const body = await bytesOf(request);
    if (request.scope === "write") {
      const report = await this.#receive(shelf, body);
      const written = shelfEngine.gitStatus(report);
      if (!written.ok) {
        throw new Error(written.errors.map((e) => e.message).join("; "));
      }
      return gitResponse(
        written.value,
        "application/x-git-receive-pack-result"
      );
    }
    const wanted = shelfEngine.gitUploadRequest(body);
    if (!wanted.ok) {
      return badRequest(wanted.errors.map((e) => e.message).join("; "));
    }
    return await this.#upload(shelf, wanted.value);
  };

  /**
   * Apply a receive-pack request: store every object of its pack, check that each object they name is there, then move
   * each reference whose old side is still its value. `main` is never deleted, and only branches and tags are written.
   */
  async #receive(shelf: string, body: Uint8Array): Promise<GitReport> {
    const shelfEngine = await engine();
    const received = shelfEngine.gitReceive(body);
    if (!received.ok) {
      return {
        refs: [],
        unpack: {
          message: received.errors.map((e) => e.message).join("; "),
          ok: false,
        },
      };
    }
    const { objects, updates } = received.value;
    const packed = new Set(objects.map((object) => object.id));
    const named = [...new Set(objects.flatMap((o) => referencesOf(o)))];
    const checked = await Promise.all(
      named
        .filter((id) => !packed.has(id))
        .map(async (id) => ((await this.#has(shelf, id)) ? null : id))
    );
    const missing = checked.find((id) => id !== null);
    if (missing !== undefined) {
      return {
        refs: updates.map((update) => ({
          name: update.name,
          ok: false,
          reason: "unpacker error",
        })),
        unpack: {
          message: `the pack names ${missing}, which neither it nor the repository holds`,
          ok: false,
        },
      };
    }
    await Promise.all(
      objects.map(async (object) => {
        const decoded = decodedOf(object);
        await Promise.all([
          this.#bucket.put(
            this.#key(shelf, `objects/${object.id}`),
            bodyOf(object),
            { customMetadata: { kind: object.kind } }
          ),
          decoded === null
            ? null
            : this.#bucket.put(
                this.#key(shelf, `decoded/${object.id}`),
                JSON.stringify(decoded)
              ),
        ]);
      })
    );
    for (let attempt = 0; attempt < REF_ATTEMPTS; attempt += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt re-reads what the one before lost to.
      const found = await this.#refs(shelf);
      if (found === null) {
        throw new Error(`there is no repository for ${shelf}`);
      }
      const next = new Map(Object.entries(found.refs));
      const statuses = updates.map((update): GitReport["refs"][number] => {
        const refuse = (reason: string) => ({
          name: update.name,
          ok: false as const,
          reason,
        });
        if (!/^refs\/(?:heads|tags)\//u.test(update.name)) {
          return refuse("only branches and tags are written here");
        }
        if ((found.refs[update.name] ?? ZERO) !== update.old) {
          return refuse("fetch first: the reference moved");
        }
        if (update.new === ZERO) {
          if (update.name === MAIN) {
            return refuse("the shelf's branch cannot be deleted");
          }
          next.delete(update.name);
        } else {
          next.set(update.name, update.new);
        }
        return { name: update.name, ok: true };
      });
      if (!statuses.some((status) => status.ok)) {
        return { refs: statuses, unpack: { ok: true } };
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
      const written = await this.#bucket.put(
        this.#key(shelf, "refs"),
        JSON.stringify(Object.fromEntries(next)),
        { onlyIf: { etagMatches: found.etag } }
      );
      if (written !== null) {
        return { refs: statuses, unpack: { ok: true } };
      }
    }
    return {
      refs: updates.map((update) => ({
        name: update.name,
        ok: false,
        reason: "the references kept moving; try again",
      })),
      unpack: { ok: true },
    };
  }

  /**
   * Answer a clone or a fetch: acknowledge the haves the repository holds, cut the history at the depth asked for,
   * and, once the client is done, send every object reachable from what it wants that it does not have.
   */
  async #upload(shelf: string, request: GitUploadRequest): Promise<Response> {
    const known = await Promise.all(
      request.haves.map(async (id) =>
        (await this.#has(shelf, id)) ? id : null
      )
    );
    const common = known.filter((id) => id !== null);
    const clientShallow = new Set(request.shallows);
    const has = await this.#closure(shelf, common, clientShallow);
    const depth = request.depth ?? Number.POSITIVE_INFINITY;

    const send: string[] = [];
    const shallow: string[] = [];
    const unshallow: string[] = [];
    const visited = new Set<string>();
    let level = request.wants.map((id) => id);
    for (let distance = 1; level.length > 0; distance += 1) {
      const next: string[] = [];
      for (const id of level) {
        if (visited.has(id) || (has.has(id) && !clientShallow.has(id))) {
          continue;
        }
        visited.add(id);
        // oxlint-disable-next-line eslint/no-await-in-loop -- a level of the history is read before the next.
        const commit = await this.#commit(shelf, id);
        if (!has.has(id)) {
          send.push(id);
          // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
          await this.#treeObjects(shelf, commit.tree, has, send);
        }
        if (distance >= depth && commit.parents.length > 0) {
          if (!clientShallow.has(id)) {
            shallow.push(id);
          }
          continue;
        }
        if (clientShallow.has(id)) {
          unshallow.push(id);
        }
        next.push(...commit.parents);
      }
      level = next;
    }

    const shelfEngine = await engine();
    const done = request.negotiation === "done";
    const pack = done
      ? await Promise.all(
          [...new Set(send)].map(async (id) => {
            const found = await this.#object(shelf, id);
            if (found === null) {
              throw new Error(
                `the object ${id} is missing from ${shelf}'s repository`
              );
            }
            return found;
          })
        )
      : [];
    const answered = shelfEngine.gitUploadResponse({
      common,
      deepens: request.deepens,
      negotiation: request.negotiation,
      pack,
      shallow,
      unshallow,
    });
    if (!answered.ok) {
      throw new Error(answered.errors.map((e) => e.message).join("; "));
    }
    return gitResponse(answered.value, "application/x-git-upload-pack-result");
  }

  /** Every object reachable from `commits`, their histories stopping at the client's shallow commits. */
  async #closure(
    shelf: string,
    commits: readonly string[],
    clientShallow: ReadonlySet<string>
  ): Promise<Set<string>> {
    const has = new Set<string>();
    let level = [...commits];
    while (level.length > 0) {
      const next: string[] = [];
      for (const id of level) {
        if (has.has(id)) {
          continue;
        }
        has.add(id);
        // oxlint-disable-next-line eslint/no-await-in-loop -- a level of the history is read before the next.
        const commit = await this.#commit(shelf, id);
        const objects: string[] = [];
        // oxlint-disable-next-line eslint/no-await-in-loop -- as above.
        await this.#treeObjects(shelf, commit.tree, has, objects);
        for (const object of objects) {
          has.add(object);
        }
        if (!clientShallow.has(id)) {
          next.push(...commit.parents);
        }
      }
      level = next;
    }
    return has;
  }

  /** Add `tree` and every tree and blob under it that `skip` does not hold to `into`, but no gitlink's commit. */
  async #treeObjects(
    shelf: string,
    tree: string,
    skip: ReadonlySet<string>,
    into: string[]
  ): Promise<void> {
    if (skip.has(tree)) {
      return;
    }
    into.push(tree);
    const subtrees: Promise<void>[] = [];
    const { entries } = await this.#tree(shelf, tree);
    for (const entry of entries) {
      if (entry.mode === "40000") {
        subtrees.push(this.#treeObjects(shelf, entry.id, skip, into));
      } else if (entry.mode !== "160000" && !skip.has(entry.id)) {
        into.push(entry.id);
      }
    }
    await Promise.all(subtrees);
  }
}
