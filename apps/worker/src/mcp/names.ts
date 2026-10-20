/**
 * The relay's tool names (`docs/PRD.md` section 8.1, rules 1 and 3).
 *
 * A relayed tool is `<item>__<tool>`. Item ids are kebab-case, so they contain no `_` at all, and the first `__` in a
 * name always ends the item id: the separator is unambiguous, not merely unlikely to collide. ShelfKit's own tools are
 * AcidCat capability ids, which contain no `_`, so no relayed name can equal, shadow, or be mistaken for a `shelf.*`
 * tool, and a backend cannot claim one by naming its tool `shelf.search` or `shelf_search`: it becomes
 * `<item>__shelf.search`.
 */

/** The separator between an item id and its upstream tool's name. */
export const SEPARATOR = "__";

/** MCP asks for tool names of at most 128 characters. */
export const MAXIMUM_NAME_LENGTH = 128;

/** The characters MCP allows in a tool name. */
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/u;

/** The namespaced name of `tool` on the hosted item `item`, or `null` when it would not be a valid MCP tool name. */
export function relayedName(item: string, tool: string): string | null {
  const name = `${item}${SEPARATOR}${tool}`;
  return tool !== "" &&
    name.length <= MAXIMUM_NAME_LENGTH &&
    TOOL_NAME.test(name)
    ? name
    : null;
}

/** The item and upstream tool a relayed name addresses, or `null` for a name that is not of the relayed form. */
export function parseRelayedName(
  name: string
): { readonly item: string; readonly tool: string } | null {
  const at = name.indexOf(SEPARATOR);
  if (at <= 0 || name.length > MAXIMUM_NAME_LENGTH) {
    return null;
  }
  const item = name.slice(0, at);
  const tool = name.slice(at + SEPARATOR.length);
  return relayedName(item, tool) === name && !item.includes("_")
    ? { item, tool }
    : null;
}

/** Whether `name` is in the relay's namespace. ShelfKit's own capability ids never are. */
export function isRelayedName(name: string): boolean {
  return name.includes(SEPARATOR);
}
