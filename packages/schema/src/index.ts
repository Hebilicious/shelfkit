/**
 * Wire and file schemas, shared by the Worker and the CLI.
 *
 * The Rust crates in `crates/` own the shelf format itself, because the compiler must run identically in the CLI and
 * in the browser. These schemas describe what crosses a boundary: shelf files as JSON, HTTP payloads, GraphQL inputs,
 * and the MCP capabilities. `./json-schema` converts them for AcidCat; `./catalog` renders the AcidCat catalog.
 */
import * as v from "valibot";

export * from "./capabilities.ts";
export * from "./shelf.ts";

export const KeyScopeSchema = v.picklist(["read", "publish"]);

export const CreateKeyInputSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  scopes: v.pipe(v.array(KeyScopeSchema), v.minLength(1)),
});

export type CreateKeyInput = v.InferOutput<typeof CreateKeyInputSchema>;
