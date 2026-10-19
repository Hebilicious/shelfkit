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
export const ABI_VERSION = 5;

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
  /** The profile's `version`, or `0.0.0+sha256.<revision hex>`. */
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
  /** The OpenAPM Registry HTTP API's decisions, for a host that does the I/O. */
  readonly registry: Registry;
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
  readonly shelfkit_registry_prepare: () => number;
  readonly shelfkit_registry_respond: () => number;
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
  "shelfkit_registry_prepare",
  "shelfkit_registry_respond",
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
    inventory: guarded((instance: Abi, files: readonly ShelfFile[]) =>
      shelfCall(
        instance,
        instance.shelfkit_inventory,
        { files: files.map((file) => encodeFile(file)) },
        InventorySchema
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
