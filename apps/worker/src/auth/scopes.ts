/**
 * Key scopes. The vocabulary is the OpenAPM Registry HTTP API's, so one key works for the registry, GraphQL, and MCP,
 * plus one form of ShelfKit's own for the MCP relay. Every scope on a key names the key's own shelf; `{shelf}` is the
 * shelf's registry namespace, and a profile is the package `{shelf}/{profile}`.
 *
 * | Scope | Registry | GraphQL and MCP |
 * | --- | --- | --- |
 * | `read` | read every package | read the shelf: items, profiles, plans, activity |
 * | `read:{shelf}/{profile}` | read that package | nothing more; a registry-only key |
 * | `publish:{shelf}/{profile}` | publish that package | edit that profile, and report a compile of it |
 * | `publish:{shelf}/*` | publish every package | write the shelf: push, edit items and profiles, import, share |
 * | `mcp:{shelf}/{item}` | none | call the relayed tools of the hosted MCP item `{item}` (`docs/PRD.md` 8.1, rule 2) |
 *
 * There is no wildcard relay grant: hosting is opt-in per item and per key. The owner key holds every scope on every
 * shelf, and alone manages keys and settings (sources, secret names, visibility) and creates a shelf. A key reads a
 * public shelf whatever its scopes, as the registry does.
 */
import { ItemIdSchema, ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

export type Scope =
  | { readonly kind: "read" }
  | { readonly kind: "read-package"; readonly profile: string }
  | { readonly kind: "publish"; readonly profile: string }
  | { readonly kind: "publish-all" }
  | { readonly kind: "mcp"; readonly item: string };

/** Parse one scope for a key of `shelf`, or say why it is not one. */
export function parseScope(
  shelf: string,
  text: string
): { readonly scope: Scope } | { readonly error: string } {
  if (text === "read") {
    return { scope: { kind: "read" } };
  }
  const match =
    /^(?<verb>read|publish|mcp):(?<owner>[^/]+)\/(?<name>.+)$/u.exec(
      text
    )?.groups;
  const verb = match?.verb;
  const owner = match?.owner;
  const name = match?.name;
  if (verb === undefined || owner === undefined || name === undefined) {
    return {
      error: `\`${text}\` is not a scope: use read, read:${shelf}/{profile}, publish:${shelf}/{profile}, publish:${shelf}/*, or mcp:${shelf}/{item}`,
    };
  }
  if (!v.is(ShelfIdSchema, owner) || owner !== shelf) {
    return {
      error: `\`${text}\` names the shelf \`${owner}\`; a key of \`${shelf}\` can only hold scopes on \`${shelf}\``,
    };
  }
  if (verb === "publish" && name === "*") {
    return { scope: { kind: "publish-all" } };
  }
  if (!v.safeParse(ItemIdSchema, name).success) {
    return { error: `\`${text}\`: \`${name}\` is not a profile or item id` };
  }
  if (verb === "read") {
    return { scope: { kind: "read-package", profile: name } };
  }
  if (verb === "publish") {
    return { scope: { kind: "publish", profile: name } };
  }
  return { scope: { item: name, kind: "mcp" } };
}

/** The scopes of a key, parsed; a scope that does not parse grants nothing. */
export function parseScopes(shelf: string, texts: readonly string[]): Scope[] {
  return texts.flatMap((text) => {
    const parsed = parseScope(shelf, text);
    return "scope" in parsed ? [parsed.scope] : [];
  });
}

/** The scopes the registry understands, as strings, for `registry.respond`. */
export function registryScopes(texts: readonly string[]): string[] {
  return texts.filter((text) => !text.startsWith("mcp:"));
}
