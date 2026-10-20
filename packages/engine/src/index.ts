/**
 * The shelf engine: ShelfKit's Rust loader, resolver, and compiler, compiled to WebAssembly, behind one typed port.
 *
 * It runs the code `shelfkit compile --dry-run --json` runs, so the composer's preview, the MCP `shelf.compile.plan`
 * tool, and the CLI cannot disagree about what a profile compiles to. A host compiles the module once and hands it over:
 * the Worker imports `@shelfkit/engine/shelfkit.wasm` as a `WebAssembly.Module`, the browser compiles it from its URL,
 * and Node reads it from disk (`@shelfkit/engine/node`).
 *
 * The module imports nothing. Its ABI is JSON in and JSON out through two buffers it owns (`crates/wasm/src/lib.rs`).
 */
import { CompilePlanSchema } from "@shelfkit/schema";
import type { CompilePlan, ProfileSchema } from "@shelfkit/schema";
import * as v from "valibot";

/** A profile document as written in `profiles/<id>.json`, before defaults are filled in. */
export type ProfileDocument = v.InferInput<typeof ProfileSchema>;

/** The ABI this port speaks; the module reports its own through `shelfkit_abi_version`. */
export const ABI_VERSION = 2;

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

export interface Engine {
  /** Load the shelf, resolve the profile, and compile it. */
  readonly planCompile: (
    files: readonly ShelfFile[],
    options?: PlanOptions
  ) => PlanResult;
}

/** The module's exports. */
interface Abi {
  readonly memory: WebAssembly.Memory;
  readonly shelfkit_abi_version: () => number;
  readonly shelfkit_input: (length: number) => number;
  readonly shelfkit_plan: () => number;
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
  return {
    planCompile: (files, options = {}) => {
      try {
        return planCompile(abi, files, options);
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) {
          abi = open(make(module));
          throw new Error(
            `the engine trapped (${error.message}) and was restarted; this plan was not made`,
            { cause: error }
          );
        }
        throw error;
      }
    },
  };
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
  const status = call(abi, JSON.stringify(request));
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

/** Write the request into the module's input buffer, run the plan, and return its status. */
function call(abi: Abi, request: string): number {
  const bytes = new TextEncoder().encode(request);
  const pointer = abi.shelfkit_input(bytes.length);
  if (pointer === 0) {
    throw new Error(
      `the shelf is too large for the engine: a ${bytes.length}-byte request`
    );
  }
  // A view is taken after the call that may have grown memory, never before.
  new Uint8Array(abi.memory.buffer, pointer, bytes.length).set(bytes);
  return abi.shelfkit_plan();
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
