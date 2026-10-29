/**
 * The shelf engine: ShelfKit's Rust loader, resolver, and compiler, compiled to WebAssembly, behind one typed port.
 *
 * It runs the code `shelfkit compile --dry-run --json` runs, so the composer's preview, the MCP `shelf.compile.plan`
 * tool, and the CLI cannot disagree about what a profile compiles to. A host compiles the module once and hands it over:
 * the Worker imports `@shelfkit/engine/shelfkit.wasm` as a `WebAssembly.Module`, the browser compiles it from its URL,
 * and Node reads it from disk (`@shelfkit/engine/node`).
 *
 * The module imports nothing. Its ABI is JSON in and JSON out through two buffers it owns (`crates/wasm/src/lib.rs`).
 *
 * Besides compiling, it packages a profile for a registry, and it runs the OpenAPM Registry HTTP API's decisions
 * (`crates/registry`), the same code `shelfkit serve` runs: `registry.prepare` routes a request and reads its
 * credential, the host resolves the key and loads the package's versions, and `registry.respond` decides the status,
 * headers, and body, and what to store on a publish.
 *
 * `output` is what `shelfkit compile --repo` writes into a repository, planned from a snapshot of it rather than from the
 * disk: the browser reads the repository through the File System Access API, hands the engine what it found, and writes
 * what comes back.
 *
 * `gitCommit` builds the commit and the `git-receive-pack` request body that push a shelf's files to its Git repository
 * (`crates/git`), `gitVersion` does the same for a published version, `gitReport` reads the server's answer, and
 * `gitRefs` reads the references a repository advertises, so the Worker sends bytes and decides nothing about Git's
 * encoding. They are a client's side only: Artifacts, deployed or as Miniflare's local simulator, is the server.
 */
import {
  CompilePlanSchema,
  InventorySchema,
  RecommendationSchema,
  ResolvedProfileSchema,
} from "@shelfkit/schema";
import type {
  CompilePlan,
  Inventory,
  Markers,
  ProfileSchema,
  Recommendation,
  ResolvedProfile,
} from "@shelfkit/schema";
import * as v from "valibot";

/** A profile document as written in `profiles/<id>.json`, before defaults are filled in. */
export type ProfileDocument = v.InferInput<typeof ProfileSchema>;

/** The ABI this port speaks; the module reports its own through `shelfkit_abi_version`. */
export const ABI_VERSION = 8;

export { NOTE_SEVERITY, conflictsOf } from "./conflicts.ts";
export type {
  Conflict,
  ConflictSeverity,
  Note,
  PlanOutcome,
} from "./conflicts.ts";

/** One file of a shelf, by its path relative to the shelf root. Bytes that are not UTF-8 text go as a `Uint8Array`. */
export type ShelfFile = ShelfContent | ShelfLink;

/** One file of a shelf, by its path relative to the shelf root. Bytes that are not UTF-8 text go as a `Uint8Array`. */
export interface ShelfContent {
  readonly path: string;
  readonly contents: string | Uint8Array;
}

/** A symbolic link found while reading a shelf. The loader refuses it, as it does reading the directory itself. */
export interface ShelfLink {
  readonly path: string;
  readonly symlink: true;
}

/** How to make an instance of the module. The default needs no imports; tests pass one that traps. */
export type Instantiate = (
  module: WebAssembly.Module
) => Pick<WebAssembly.Instance, "exports">;

/** A problem with the shelf or the profile, in the file it came from. */
export interface CompileError {
  readonly path: string;
  readonly message: string;
}

/** A compile that worked: the plan, and its JSON exactly as `shelfkit compile --dry-run --json` prints it. */
export interface Planned {
  readonly ok: true;
  readonly plan: CompilePlan;
  readonly text: string;
}

/** A compile that did not: every error, each in its file. */
export interface NotPlanned {
  readonly ok: false;
  readonly errors: readonly CompileError[];
}

export type PlanResult = Planned | NotPlanned;

export interface PlanOptions {
  /** The profile to compile. Defaults to the override's id, then to shelf.json's `defaultProfile`. */
  readonly profile?: string;
  /**
   * A profile document to compile in place of `profiles/<id>.json`, or one not saved yet: the composer previews an
   * edit before it is written. It is validated exactly as that file would be.
   */
  readonly overrideProfile?: ProfileDocument;
}

/** A profile packaged for a registry: `crates/compiler/src/package.rs`. */
export interface PackagedProfile {
  /** `{owner}/{repo}`: the shelf's `registry.namespace` and the profile id. */
  readonly package: string;
  readonly owner: string;
  readonly repo: string;
  /** The profile's `version`, which every profile has. */
  readonly version: string;
  readonly profileRevision: string;
  /** `sha256:<hex>` over `archive`. */
  readonly digest: string;
  readonly sizeBytes: number;
  /** The paths in the archive, sorted. */
  readonly files: readonly string[];
  /** Whether the shelf serves anonymous reads. */
  readonly public: boolean;
  /** The deterministic tar.gz, the same bytes the CLI writes. */
  readonly archive: Uint8Array;
}

export type PackageResult =
  | { readonly ok: true; readonly packaged: PackagedProfile }
  | NotPlanned;

/** How a declaration the repository's `apm.yml` already makes differently is settled: the profile's `compile.onConflict`. */
export type OnConflict = ResolvedProfile["compile"]["onConflict"];

/**
 * A repository, as much of it as `compile` looks at: `crates/compiler/src/output.rs`.
 *
 * The File System Access API shows no symbolic links (it follows them, or leaves them out), so a browser cannot see one
 * and sends no `links`; refusing to write through a link is the CLI's job, reading the disk. A host that can see links
 * (Node) names each one in `links`.
 */
export interface RepositorySnapshot {
  /** The text of the repository's `apm.yml`, when it has one. */
  readonly apmYml?: string;
  /** Every entry of `vendor/`. A plain file there is an entry with no `apmYml` and no files. */
  readonly vendor: readonly VendorEntry[];
  /** Every symbolic link at `apm.yml`, `vendor`, or under `vendor/`, by path relative to the repository. */
  readonly links?: readonly string[];
  /**
   * The root `apm.yml` and each package's `apm.yml` that exist but are not UTF-8, by path relative to the repository. The
   * CLI cannot read them either: the root one is refused, and a package with one is never ShelfKit's. Decode with
   * `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`, never lossily.
   */
  readonly undecodable?: readonly string[];
}

/** One entry of `vendor/`. */
export interface VendorEntry {
  /** Its name under `vendor/`. */
  readonly name: string;
  /** The text of its `apm.yml`, when it has one. */
  readonly apmYml?: string;
  /**
   * Every file in it, relative to it; `apm.yml` is implied by `apmYml`. Only read for a package whose `apm.yml` carries
   * `x-shelfkit-vendored-for` for the profile compiled, so a host may leave it empty for any other.
   */
  readonly files: readonly string[];
}

/** A file to write, relative to the repository. `contents` is base64 when `encoding` says so. */
export interface WriteFile {
  readonly path: string;
  readonly contents: string;
  readonly encoding: "utf-8" | "base64";
}

/** What `shelfkit compile --repo` would do to the repository. */
export interface RepositoryOutput {
  /** Every file to write, sorted by path, `apm.yml` included. */
  readonly write: readonly WriteFile[];
  /** Stale files of ShelfKit's own packages, to delete. */
  readonly remove: readonly string[];
  /**
   * Directories to remove after `remove`, deepest first: those the removals leave with no file, never `vendor/` itself.
   * Remove each only if it is empty (a non-recursive remove), as the CLI does: a snapshot cannot show an empty
   * directory inside, which keeps its parent.
   */
  readonly prune: readonly string[];
  /** Declarations the repository's `apm.yml` made differently, settled by `onConflict`. */
  readonly conflicts: readonly string[];
  /**
   * Why nothing may be written. When this is not empty, `write`, `remove`, and `prune` are. A plan file outside
   * `vendor/<package>/` (a crafted plan) is refused here.
   */
  readonly refused: readonly string[];
}

/** A response the host sends. An `archive` body is the stored bytes of that package version. */
export interface RegistryResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: RegistryBody;
}

export type RegistryBody =
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly text: string }
  | {
      readonly kind: "archive";
      /** The package's storage key: its identity, lowercase. */
      readonly package: string;
      readonly version: string;
    };

/** One published version, as `GET /versions` lists it. */
export interface VersionRecord {
  readonly version: string;
  readonly digest: string;
  readonly published_at: string;
  readonly size_bytes: number;
}

/** What a request asks for. */
export interface RegistryRoute {
  readonly operation: "list" | "download" | "publish";
  readonly package: { readonly owner: string; readonly repo: string };
  readonly version?: string;
}

/** The credential a request presented. A `key` is for the host to look up; it is never logged. */
export type PresentedCredential =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "key"; readonly key: string };

export type Prepared =
  | { readonly respond: RegistryResponse }
  | {
      readonly route: RegistryRoute;
      /** The key the host stores the package's versions and archives under. */
      readonly packageKey: string;
      /** The key the host looks the owner's shelf up by. */
      readonly ownerKey: string;
      readonly credential: PresentedCredential;
    };

/** What the host found for the credential: no credential, one it does not know, or a key and its scopes. */
export type RegistryAccess =
  | { readonly credential: "anonymous" }
  | { readonly credential: "invalid" }
  | { readonly credential: "key"; readonly scopes: readonly string[] };

/** What the host knows about the requested package. */
export interface RegistryContext {
  /** The owner's shelf, or `null` when the host has none for the owner. */
  readonly shelf: { readonly public: boolean } | null;
  /** The package's versions in publish order; empty when it does not exist. */
  readonly versions: readonly VersionRecord[];
}

export interface RespondRequest {
  readonly method: string;
  /** The whole request path, as given to `prepare`. */
  readonly path: string;
  /** The same mount as given to `prepare`. */
  readonly mount?: string;
  readonly access: RegistryAccess;
  readonly context: RegistryContext;
  readonly contentType?: string;
  readonly ifNoneMatch?: string;
  readonly body?: Uint8Array;
  /** The time a publish records, RFC 3339 UTC. */
  readonly now: string;
}

export interface RegistryOutcome {
  readonly response: RegistryResponse;
  /** On a successful publish: store the request body as this version, only if it is still absent. */
  readonly publish?: VersionRecord;
}

export interface Registry {
  /** Step 1: route a request and read its `Authorization` header. */
  readonly prepare: (request: PrepareRequest) => Prepared;
  /** Step 2: decide the response, and what to store on a publish. */
  readonly respond: (request: RespondRequest) => RegistryOutcome;
}

/**
 * The mode of an entry in a Git tree that is not a directory: a regular file, an executable, a symbolic link whose blob
 * is its target, or a gitlink (`160000`), whose id is a submodule's commit rather than a blob.
 */
export type GitMode = GitContentMode | "160000";

/** The modes of an entry that has contents: every mode but a gitlink's. */
export type GitContentMode = "100644" | "100755" | "120000";

/** Who made a commit, and when. */
export interface GitSignature {
  readonly name: string;
  readonly email: string;
  /** Unix seconds. */
  readonly time: number;
  /** Minutes east of UTC. */
  readonly offset: number;
}

/** One file of a commit: its path from the repository root, its mode, and its blob's id (40 hex digits). */
export interface GitFile {
  readonly path: string;
  readonly mode: GitMode;
  readonly id: string;
}

/**
 * One file of a new commit: a blob of the parent commit by `id` (one of `base`), or its contents. `mode` defaults to
 * `100644`. A gitlink (`160000`) is always by `id`, its submodule's commit, which need not be in `base`.
 */
export type GitNewFile =
  | { readonly path: string; readonly mode?: GitMode; readonly id: string }
  | {
      readonly path: string;
      readonly mode?: GitContentMode;
      readonly contents: string | Uint8Array;
    };

/** A commit to push: every file of the new commit, on top of every file of its parent. */
export interface GitCommitRequest {
  /** The commit `ref` points at now; absent to create `ref` with a root commit. */
  readonly parent?: string;
  /** Every file of `parent`; empty for a root commit. The server has these blobs and the trees they build. */
  readonly base: readonly GitFile[];
  /** Every file of the new commit. */
  readonly files: readonly GitNewFile[];
  /** The reference to update; `refs/heads/main` by default. */
  readonly ref?: string;
  readonly author: GitSignature;
  /** The author by default. */
  readonly committer?: GitSignature;
  readonly message: string;
}

/**
 * A version the registry published, to commit to the package's own repository: its archive's files on `main`,
 * tagged `v{version}`, on top of the version published before it (`crates/registry`'s `git` module).
 */
export interface GitVersionRequest {
  /** `owner/repo`. */
  readonly package: string;
  readonly version: string;
  /** The archive, as the registry stored it. */
  readonly archive: Uint8Array;
  /** When it was published, in Unix seconds. */
  readonly publishedAt: number;
  /** The commit `main` is at; absent for the first version. */
  readonly parent?: string;
  /** Every file of `parent`. */
  readonly base: readonly GitFile[];
}

/** What `gitCommit` planned: the commit and the receive-pack request that pushes it, or nothing to commit. */
export type GitCommitPlan = GitCommitted | GitUnchanged;

interface GitPlanned {
  /** The new root tree. */
  readonly tree: string;
  /** Every file of the new commit, in the order given, with its blob id. */
  readonly files: readonly GitFile[];
  /** How many objects the pack holds: only those the base does not. */
  readonly objects: number;
}

export interface GitCommitted extends GitPlanned {
  readonly unchanged: false;
  readonly commit: string;
  /** The body of `POST <remote>/git-receive-pack` (`application/x-git-receive-pack-request`), moving `ref` to `commit`. */
  readonly request: Uint8Array;
}

/** The files are exactly the parent's: there is no commit and nothing to push. */
export interface GitUnchanged extends GitPlanned {
  readonly unchanged: true;
  readonly commit: null;
  readonly request: null;
}

/** What the server did with a push, read from the receive-pack response. */
export interface GitReport {
  readonly unpack:
    | { readonly ok: true }
    | { readonly ok: false; readonly message: string };
  readonly refs: readonly GitRefStatus[];
}

export type GitRefStatus =
  | { readonly name: string; readonly ok: true }
  | { readonly name: string; readonly ok: false; readonly reason: string };

/** The references a repository advertises (`GET info/refs?service=<service>`), protocol v0 or v1. */
export interface GitRefs {
  /** Every reference, in the order advertised: `HEAD` first when the server lists it. */
  readonly refs: readonly GitRef[];
  /** The capabilities the advertisement's first line carried. */
  readonly capabilities: readonly string[];
}

/** One advertised reference: its full name (`refs/tags/v1.0.0`, or `HEAD`) and the object it is at. */
export interface GitRef {
  readonly name: string;
  readonly id: string;
  /** For an annotated tag, the object the tag points at. */
  readonly peeled?: string;
}

/** An engine call that answered: its parsed output. */
export interface Answered<T> {
  readonly ok: true;
  readonly value: T;
}

/** The result of a call that loads the shelf: the answer, or every error, each in its file. */
export type EngineResult<T> = Answered<T> | NotPlanned;

export interface Engine {
  /** Load the whole shelf and index it: every item with its revision, files, and coordinate, and every profile resolved. */
  readonly inventory: (files: readonly ShelfFile[]) => EngineResult<Inventory>;
  /** Load the shelf and resolve one profile, saved or not (`overrideProfile`), without compiling it. */
  readonly resolve: (
    files: readonly ShelfFile[],
    options?: PlanOptions
  ) => EngineResult<ResolvedProfile>;
  /** Recommend items and profiles for a repository's stack markers, as `shelfkit recommend` does. */
  readonly recommend: (
    files: readonly ShelfFile[],
    markers: Markers
  ) => EngineResult<Recommendation>;
  /** Load the shelf, resolve the profile, and compile it. */
  readonly planCompile: (
    files: readonly ShelfFile[],
    options?: PlanOptions
  ) => PlanResult;
  /** Load the shelf, resolve the profile, and package it for a registry. */
  readonly packageProfile: (
    files: readonly ShelfFile[],
    options?: { readonly profile?: string }
  ) => PackageResult;
  /**
   * What compiling `plan` into the repository writes and removes, as `shelfkit compile --repo` works it out. `onConflict`
   * defaults to `fail`; pass the resolved profile's `compile.onConflict` to do what the CLI does without
   * `--on-conflict`. An `apm.yml` that is not a manifest, or that conflicts under `fail`, is one error on `apm.yml`.
   */
  readonly output: (
    plan: CompilePlan,
    repo: RepositorySnapshot,
    onConflict?: OnConflict
  ) => EngineResult<RepositoryOutput>;
  /** The OpenAPM Registry HTTP API's decisions, for a host that does the I/O. */
  readonly registry: Registry;
  /**
   * Plan a commit of `files` on top of `parent`, and the receive-pack request (protocol v1, `report-status`, no
   * side-band) that pushes it. A bad path, mode, reference, or signature, or an `id` that is not in `base`, is an error
   * on its path.
   */
  readonly gitCommit: (
    request: GitCommitRequest
  ) => EngineResult<GitCommitPlan>;
  /**
   * Commit a published version to its package's repository: the receive-pack request moves `main` to the version and
   * creates its tag. An archive that does not read is an error on `<archive>`.
   */
  readonly gitVersion: (
    request: GitVersionRequest
  ) => EngineResult<GitCommitted>;
  /** Read the body of a receive-pack response. A side-band response ending in a fatal error is an error on `<remote>`. */
  readonly gitReport: (body: Uint8Array) => EngineResult<GitReport>;
  /** Read the body of a ref advertisement, the answer to `GET <remote>/info/refs?service=<service>`. */
  readonly gitRefs: (body: Uint8Array) => EngineResult<GitRefs>;
}

/** The module's exports. */
interface Abi {
  readonly memory: WebAssembly.Memory;
  readonly shelfkit_abi_version: () => number;
  readonly shelfkit_input: (length: number) => number;
  readonly shelfkit_plan: () => number;
  readonly shelfkit_package: () => number;
  readonly shelfkit_inventory: () => number;
  readonly shelfkit_resolve: () => number;
  readonly shelfkit_recommend: () => number;
  readonly shelfkit_output: () => number;
  readonly shelfkit_registry_prepare: () => number;
  readonly shelfkit_registry_respond: () => number;
  readonly shelfkit_git_commit: () => number;
  readonly shelfkit_git_version: () => number;
  readonly shelfkit_git_report: () => number;
  readonly shelfkit_git_refs: () => number;
  readonly shelfkit_output_ptr: () => number;
  readonly shelfkit_output_len: () => number;
}

/** One file as the ABI's request carries it. */
type FileRequest =
  | {
      readonly contents: string;
      readonly encoding: "utf-8" | "base64";
      readonly path: string;
    }
  | { readonly path: string; readonly symlink: true };

const FUNCTIONS = [
  "shelfkit_abi_version",
  "shelfkit_input",
  "shelfkit_plan",
  "shelfkit_package",
  "shelfkit_inventory",
  "shelfkit_resolve",
  "shelfkit_recommend",
  "shelfkit_output",
  "shelfkit_registry_prepare",
  "shelfkit_registry_respond",
  "shelfkit_git_commit",
  "shelfkit_git_version",
  "shelfkit_git_report",
  "shelfkit_git_refs",
  "shelfkit_output_ptr",
  "shelfkit_output_len",
] as const;

// BOUNDARY: a WebAssembly instance's exports are untyped until this guard has checked each one.
function isAbi(
  exports: WebAssembly.Exports
): exports is WebAssembly.Exports & Abi {
  return (
    exports.memory instanceof WebAssembly.Memory &&
    FUNCTIONS.every((name) => typeof exports[name] === "function")
  );
}

/** What `shelfkit_plan` returns. */
const PLANNED = 0;
const FAILED = 1;

const FailureSchema = v.strictObject({
  errors: v.array(v.strictObject({ message: v.string(), path: v.string() })),
});

/** An instance's exports, checked against the ABI. */
function open(instance: Pick<WebAssembly.Instance, "exports">): Abi {
  const { exports } = instance;
  if (!isAbi(exports)) {
    throw new Error(
      "this is not the ShelfKit engine module: an ABI export is missing"
    );
  }
  const version = exports.shelfkit_abi_version();
  if (version !== ABI_VERSION) {
    throw new Error(
      `the engine module speaks ABI ${version}, and this port speaks ${ABI_VERSION}`
    );
  }
  return exports;
}

const instantiateSync: Instantiate = (module) =>
  new WebAssembly.Instance(module, {});

/**
 * Instantiate the engine from a compiled module (the Worker, the browser) or from the module's bytes (Node). The module
 * needs no imports.
 *
 * A trap (a `WebAssembly.RuntimeError`, such as running out of memory) leaves an instance in no state to trust, so the
 * call that trapped throws, and the engine makes a fresh instance from the same module for the next call.
 */
export async function createEngine(
  source: WebAssembly.Module | BufferSource,
  instantiate?: Instantiate
): Promise<Engine> {
  const module =
    source instanceof WebAssembly.Module
      ? source
      : await WebAssembly.compile(source);
  const make = instantiate ?? instantiateSync;
  let abi = open(
    instantiate === undefined
      ? await WebAssembly.instantiate(module, {})
      : make(module)
  );
  const guarded =
    <A extends unknown[], R>(operation: (instance: Abi, ...args: A) => R) =>
    (...args: A): R => {
      try {
        return operation(abi, ...args);
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) {
          abi = open(make(module));
          throw new Error(
            `the engine trapped (${error.message}) and was restarted; this call was not made`,
            { cause: error }
          );
        }
        throw error;
      }
    };
  return {
    gitCommit: guarded(gitCommit),
    gitRefs: guarded((instance: Abi, body: Uint8Array) =>
      engineCall(
        instance,
        instance.shelfkit_git_refs,
        { body: toBase64(body) },
        GitRefsSchema
      )
    ),
    gitReport: guarded((instance: Abi, body: Uint8Array) =>
      engineCall(
        instance,
        instance.shelfkit_git_report,
        { body: toBase64(body) },
        GitReportSchema
      )
    ),
    gitVersion: guarded(gitVersion),
    inventory: guarded((instance: Abi, files: readonly ShelfFile[]) =>
      shelfCall(
        instance,
        instance.shelfkit_inventory,
        { files: files.map((file) => encodeFile(file)) },
        InventorySchema
      )
    ),
    output: guarded(
      (
        instance: Abi,
        plan: CompilePlan,
        repo: RepositorySnapshot,
        onConflict: OnConflict = "fail"
      ) =>
        engineCall(
          instance,
          instance.shelfkit_output,
          { onConflict, plan, repo },
          RepositoryOutputSchema
        )
    ),
    packageProfile: guarded(packageProfile),
    planCompile: guarded(
      (instance: Abi, files: readonly ShelfFile[], options: PlanOptions = {}) =>
        planCompile(instance, files, options)
    ),
    recommend: guarded(
      (instance: Abi, files: readonly ShelfFile[], markers: Markers) =>
        shelfCall(
          instance,
          instance.shelfkit_recommend,
          { files: files.map((file) => encodeFile(file)), markers },
          RecommendationSchema
        )
    ),
    registry: {
      prepare: guarded(registryPrepare),
      respond: guarded(registryRespond),
    },
    resolve: guarded(
      (instance: Abi, files: readonly ShelfFile[], options: PlanOptions = {}) =>
        shelfCall(
          instance,
          instance.shelfkit_resolve,
          {
            files: files.map((file) => encodeFile(file)),
            overrideProfile: options.overrideProfile,
            profile: options.profile,
          },
          ResolvedProfileSchema
        )
    ),
  };
}

/** What a call that loads the shelf reads: its files, plus what that call adds. */
interface ShelfRequest {
  readonly files: readonly FileRequest[];
  readonly markers?: Markers;
  readonly overrideProfile?: ProfileDocument;
  readonly profile?: string;
}

/** A call that loads the shelf: status 0 and the output, 1 and the shelf's errors, or 2 for a malformed request. */
function shelfCall<const TSchema extends v.GenericSchema>(
  abi: Abi,
  run: () => number,
  request: ShelfRequest,
  schema: TSchema
): EngineResult<v.InferOutput<TSchema>> {
  return engineCall(abi, run, request, schema);
}

/** What `shelfkit_output` reads. */
interface OutputRequest {
  readonly plan: CompilePlan;
  readonly onConflict: OnConflict;
  readonly repo: RepositorySnapshot;
}

const RepositoryOutputSchema = v.strictObject({
  conflicts: v.array(v.string()),
  prune: v.array(v.string()),
  refused: v.array(v.string()),
  remove: v.array(v.string()),
  write: v.array(
    v.strictObject({
      contents: v.string(),
      encoding: v.picklist(["utf-8", "base64"]),
      path: v.string(),
    })
  ),
});

/** Status 0 and the output, 1 and the errors, each in its file, or 2 for a malformed request, which throws. */
function engineCall<const TSchema extends v.GenericSchema>(
  abi: Abi,
  run: () => number,
  request:
    | ShelfRequest
    | OutputRequest
    | GitCommitInput
    | GitBodyInput
    | GitVersionInput,
  schema: TSchema
): EngineResult<v.InferOutput<TSchema>> {
  const status = call(abi, run, JSON.stringify(request));
  const text = readOutput(abi);
  if (status === PLANNED) {
    return { ok: true, value: v.parse(schema, JSON.parse(text)) };
  }
  const { errors } = v.parse(FailureSchema, JSON.parse(text));
  if (status !== FAILED) {
    throw new Error(
      `the engine refused the request: ${errors.map((error) => error.message).join("; ")}`
    );
  }
  return { errors, ok: false };
}

function planCompile(
  abi: Abi,
  files: readonly ShelfFile[],
  options: PlanOptions
): PlanResult {
  const request = {
    files: files.map((file) => encodeFile(file)),
    overrideProfile: options.overrideProfile,
    profile: options.profile,
  };
  const status = call(abi, abi.shelfkit_plan, JSON.stringify(request));
  const text = readOutput(abi);
  if (status === PLANNED) {
    return {
      ok: true,
      plan: v.parse(CompilePlanSchema, JSON.parse(text)),
      text,
    };
  }
  const { errors } = v.parse(FailureSchema, JSON.parse(text));
  if (status !== FAILED) {
    throw new Error(
      `the engine refused the request: ${errors.map((error) => error.message).join("; ")}`
    );
  }
  return { errors, ok: false };
}

const PackagedSchema = v.strictObject({
  archive: v.string(),
  digest: v.string(),
  files: v.array(v.string()),
  owner: v.string(),
  package: v.string(),
  profileRevision: v.string(),
  public: v.boolean(),
  repo: v.string(),
  sizeBytes: v.number(),
  version: v.string(),
});

function packageProfile(
  abi: Abi,
  files: readonly ShelfFile[],
  options: { readonly profile?: string } = {}
): PackageResult {
  const request = {
    files: files.map((file) => encodeFile(file)),
    profile: options.profile,
  };
  const status = call(abi, abi.shelfkit_package, JSON.stringify(request));
  const text = readOutput(abi);
  if (status === PLANNED) {
    const { archive, ...rest } = v.parse(PackagedSchema, JSON.parse(text));
    return { ok: true, packaged: { ...rest, archive: fromBase64(archive) } };
  }
  const { errors } = v.parse(FailureSchema, JSON.parse(text));
  if (status !== FAILED) {
    throw new Error(
      `the engine refused the request: ${errors.map((error) => error.message).join("; ")}`
    );
  }
  return { errors, ok: false };
}

const VersionRecordSchema = v.strictObject({
  digest: v.string(),
  published_at: v.string(),
  size_bytes: v.number(),
  version: v.string(),
});

const ResponseSchema = v.strictObject({
  body: v.variant("kind", [
    v.strictObject({ kind: v.literal("empty") }),
    v.strictObject({ kind: v.literal("json"), text: v.string() }),
    v.strictObject({
      kind: v.literal("archive"),
      package: v.string(),
      version: v.string(),
    }),
  ]),
  headers: v.array(v.tuple([v.string(), v.string()])),
  status: v.number(),
});

const PreparedSchema = v.union([
  v.strictObject({ respond: ResponseSchema }),
  v.strictObject({
    credential: v.variant("kind", [
      v.strictObject({ kind: v.literal("none") }),
      v.strictObject({ kind: v.literal("unreadable") }),
      v.strictObject({ key: v.string(), kind: v.literal("key") }),
    ]),
    ownerKey: v.string(),
    packageKey: v.string(),
    route: v.strictObject({
      operation: v.picklist(["list", "download", "publish"]),
      package: v.strictObject({ owner: v.string(), repo: v.string() }),
      version: v.optional(v.string()),
    }),
  }),
]);

const OutcomeSchema = v.strictObject({
  publish: v.optional(VersionRecordSchema),
  response: ResponseSchema,
});

/** What `shelfkit_registry_prepare` reads. */
interface PrepareRequest {
  readonly method: string;
  /** The whole request path, mount included. */
  readonly path: string;
  /** The path the registry's base URL adds, as `/apm`; the root by default. URLs in responses keep it. */
  readonly mount?: string;
  readonly authorization?: string;
}

/** What `shelfkit_registry_respond` reads: the request, with its body in base64. */
type RespondInput = Omit<RespondRequest, "body"> & { readonly body?: string };

/** Call a registry export, which answers 0, or 2 with the reason for a malformed request, and parse its answer. */
function registryCall<const TSchema extends v.GenericSchema>(
  abi: Abi,
  run: () => number,
  request: PrepareRequest | RespondInput,
  schema: TSchema
): v.InferOutput<TSchema> {
  const status = call(abi, run, JSON.stringify(request));
  const text = readOutput(abi);
  if (status !== PLANNED) {
    const { errors } = v.parse(FailureSchema, JSON.parse(text));
    throw new Error(
      `the engine refused the request: ${errors.map((error) => error.message).join("; ")}`
    );
  }
  return v.parse(schema, JSON.parse(text));
}

function registryPrepare(abi: Abi, request: PrepareRequest): Prepared {
  return registryCall(
    abi,
    abi.shelfkit_registry_prepare,
    request,
    PreparedSchema
  );
}

function registryRespond(abi: Abi, request: RespondRequest): RegistryOutcome {
  const { body, ...rest } = request;
  const input: RespondInput =
    body === undefined ? rest : { ...rest, body: toBase64(body) };
  return registryCall(abi, abi.shelfkit_registry_respond, input, OutcomeSchema);
}

/** One file of a commit as `shelfkit_git_commit` reads it: by id, or with its contents as text or base64. */
type GitFileRequest =
  | { readonly path: string; readonly mode?: GitMode; readonly id: string }
  | {
      readonly path: string;
      readonly mode?: GitContentMode;
      readonly contents: string;
      readonly encoding: "utf-8" | "base64";
    };

/** What `shelfkit_git_commit` reads. */
type GitCommitInput = Omit<GitCommitRequest, "files"> & {
  readonly files: readonly GitFileRequest[];
};

/** What `shelfkit_git_report` and `shelfkit_git_refs` read: the bytes, in base64. */
interface GitBodyInput {
  readonly body: string;
}

/** What `shelfkit_git_version` reads: the request, its archive in base64. */
type GitVersionInput = Omit<GitVersionRequest, "archive"> & {
  readonly archive: string;
};

const GitModeSchema = v.picklist(["100644", "100755", "120000", "160000"]);

const GitFileSchema = v.strictObject({
  id: v.string(),
  mode: GitModeSchema,
  path: v.string(),
});

const GitCommitSchema = v.union([
  v.strictObject({
    commit: v.string(),
    files: v.array(GitFileSchema),
    objects: v.number(),
    request: v.string(),
    tree: v.string(),
    unchanged: v.literal(false),
  }),
  v.strictObject({
    commit: v.null(),
    files: v.array(GitFileSchema),
    objects: v.number(),
    request: v.null(),
    tree: v.string(),
    unchanged: v.literal(true),
  }),
]);

const GitReportSchema = v.strictObject({
  refs: v.array(
    v.union([
      v.strictObject({ name: v.string(), ok: v.literal(true) }),
      v.strictObject({
        name: v.string(),
        ok: v.literal(false),
        reason: v.string(),
      }),
    ])
  ),
  unpack: v.union([
    v.strictObject({ ok: v.literal(true) }),
    v.strictObject({ message: v.string(), ok: v.literal(false) }),
  ]),
});

const GitRefsSchema = v.strictObject({
  capabilities: v.array(v.string()),
  refs: v.array(
    v.strictObject({
      id: v.string(),
      name: v.string(),
      peeled: v.optional(v.string()),
    })
  ),
});

function gitCommit(
  abi: Abi,
  request: GitCommitRequest
): EngineResult<GitCommitPlan> {
  const input: GitCommitInput = {
    ...request,
    files: request.files.map((file) => encodeGitFile(file)),
  };
  const result = engineCall(
    abi,
    abi.shelfkit_git_commit,
    input,
    GitCommitSchema
  );
  if (!result.ok) {
    return result;
  }
  const plan = result.value;
  if (plan.unchanged) {
    return { ok: true, value: plan };
  }
  return { ok: true, value: { ...plan, request: fromBase64(plan.request) } };
}

function gitVersion(
  abi: Abi,
  request: GitVersionRequest
): EngineResult<GitCommitted> {
  const result = engineCall(
    abi,
    abi.shelfkit_git_version,
    { ...request, archive: toBase64(request.archive) },
    GitCommitSchema
  );
  if (!result.ok) {
    return result;
  }
  const plan = result.value;
  if (plan.unchanged) {
    // `crates/registry` refuses an unchanged version before it plans a push.
    throw new Error(
      `the engine committed ${request.package} ${request.version} as unchanged`
    );
  }
  return { ok: true, value: { ...plan, request: fromBase64(plan.request) } };
}

function encodeGitFile(file: GitNewFile): GitFileRequest {
  if ("id" in file) {
    return file;
  }
  const { contents, ...rest } = file;
  if (contents instanceof Uint8Array) {
    return { ...rest, contents: toBase64(contents), encoding: "base64" };
  }
  return { ...rest, contents, encoding: "utf-8" };
}

function encodeFile(file: ShelfFile): FileRequest {
  if ("symlink" in file) {
    return { path: file.path, symlink: true };
  }
  if (file.contents instanceof Uint8Array) {
    return {
      contents: toBase64(file.contents),
      encoding: "base64",
      path: file.path,
    };
  }
  return { contents: file.contents, encoding: "utf-8", path: file.path };
}

/** Write the request into the module's input buffer, run one export on it, and return its status. */
function call(abi: Abi, run: () => number, request: string): number {
  const bytes = new TextEncoder().encode(request);
  const pointer = abi.shelfkit_input(bytes.length);
  if (pointer === 0) {
    throw new Error(
      `the shelf is too large for the engine: a ${bytes.length}-byte request`
    );
  }
  // A view is taken after the call that may have grown memory, never before.
  new Uint8Array(abi.memory.buffer, pointer, bytes.length).set(bytes);
  return run();
}

function readOutput(abi: Abi): string {
  const view = new Uint8Array(
    abi.memory.buffer,
    abi.shelfkit_output_ptr(),
    abi.shelfkit_output_len()
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(view);
}

/** Standard base64 with padding; `btoa` exists in the Worker, the browser, and Node. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x80_00;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}
