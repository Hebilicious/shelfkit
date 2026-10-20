/**
 * Wire and file schemas, shared by the Worker and the CLI.
 *
 * The Rust crates in `crates/` own the shelf format itself, because the
 * compiler must run identically in the CLI and in the browser. These schemas
 * describe what crosses a boundary: HTTP payloads and GraphQL inputs.
 */
import * as v from "valibot";

export const ItemKindSchema = v.picklist([
  "skill",
  "prompt",
  "instructions",
  "agent",
  "hook",
  "plugin",
  "mcp",
  "lsp",
  "library",
  "stack",
]);

export const RevisionSchema = v.pipe(
  v.string(),
  v.regex(/^sha256-[0-9a-f]{64}$/u, "must be a sha256-<64 hex> revision")
);

/** Item ids are kebab-case and may not contain `__`, which the MCP namespace
 * separator reserves. The Rust model enforces the same rule. */
export const ItemIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "must be lowercase kebab-case"),
  v.check((id) => !id.includes("__"), "must not contain `__`")
);

export const KeyScopeSchema = v.picklist(["read", "publish"]);

export const CreateKeyInputSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  scopes: v.pipe(v.array(KeyScopeSchema), v.minLength(1)),
});

export type ItemKind = v.InferOutput<typeof ItemKindSchema>;
export type CreateKeyInput = v.InferOutput<typeof CreateKeyInputSchema>;
