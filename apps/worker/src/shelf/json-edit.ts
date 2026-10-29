/**
 * Editing a JSON document a person wrote, as a person would: change the members whose value changed and leave every
 * other byte where it was. An item's `item.json` lives in the shelf's Git repository, so rewriting it whole for a
 * one-field edit would show as a rewrite of the file in its history, reorder its keys, and drop the fields the engine
 * normalizes away (a `"required": false` it treats as the default).
 *
 * Only top-level members are edited; a member whose value changed is replaced whole, written on one line when the
 * value it replaces was on one line, and indented as its neighbours are otherwise.
 */
import { canonicalJson, JsonSchema } from "@shelfkit/importers";
import type { Json } from "@shelfkit/importers";
import * as v from "valibot";

/** A JSON object, as a document's top level is. */
export type JsonObject = Readonly<Record<string, Json>>;

/** A JSON object, parsed. */
export const JsonObjectSchema = v.record(v.string(), JsonSchema);

/** A member's value in canonical form, or nothing for an absent one, so two documents compare by content. */
function canonical(value: Json | undefined): string | undefined {
  return value === undefined ? undefined : canonicalJson(value);
}

/** Where one top-level member sits in the text. */
interface Member {
  readonly key: string;
  /** The offset of the member's key, its opening quote. */
  readonly start: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** The end of the JSON string that opens at `start`, just past its closing quote. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** The end of the JSON value that opens at `start`. */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    return stringEnd(text, start);
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index = stringEnd(text, index);
        if (index === -1) {
          return -1;
        }
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          return index + 1;
        }
      }
      index += 1;
    }
    return -1;
  }
  const literal = /^[^\s,}\]]+/u.exec(text.slice(start));
  return literal === null ? -1 : start + literal[0].length;
}

function skipSpace(text: string, start: number): number {
  const space = /^\s*/u.exec(text.slice(start));
  return start + (space?.[0].length ?? 0);
}

/** Every top-level member of the object `text` holds, in order, or null when it is not one. */
function membersOf(text: string): Member[] | null {
  let index = skipSpace(text, 0);
  if (text[index] !== "{") {
    return null;
  }
  index = skipSpace(text, index + 1);
  const members: Member[] = [];
  while (text[index] !== "}") {
    if (text[index] !== '"') {
      return null;
    }
    const start = index;
    const keyEnd = stringEnd(text, index);
    if (keyEnd === -1) {
      return null;
    }
    const key = v.parse(v.string(), JSON.parse(text.slice(start, keyEnd)));
    index = skipSpace(text, keyEnd);
    if (text[index] !== ":") {
      return null;
    }
    const valueStart = skipSpace(text, index + 1);
    const end = valueEnd(text, valueStart);
    if (end === -1) {
      return null;
    }
    members.push({ key, start, valueEnd: end, valueStart });
    index = skipSpace(text, end);
    if (text[index] === ",") {
      index = skipSpace(text, index + 1);
    } else if (text[index] !== "}") {
      return null;
    }
  }
  return members;
}

/** A value on one line, spaced as a formatter spaces it: `{ "name": "x" }`, `["a", "b"]`. */
function inline(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => inline(entry)).join(", ")}]`;
  }
  if (value !== null && v.is(JsonObjectSchema, value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** `value` written where the member at `indent` was, on one line if what it replaces was. */
function render(value: Json, indent: string, oneLine: boolean): string {
  return oneLine
    ? inline(value)
    : JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
}

function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(lineStart))?.[0] ?? "";
}

/**
 * `text`, an object written as JSON, with each top-level member whose value differs between `before` and `after`
 * replaced, removed, or added. `before` and `after` are the document as read and as it should be; a member they agree
 * on keeps its text even when `text` writes it differently. Null when `text` is not an object this can edit.
 */
export function editJsonObject(
  text: string,
  before: JsonObject,
  after: JsonObject
): string | null {
  const members = membersOf(text);
  if (members === null) {
    return null;
  }
  const changed = new Set(
    [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (key) => canonical(before[key]) !== canonical(after[key])
    )
  );
  let edited = text;
  // Last member first, so earlier offsets still hold.
  for (const member of members.toReversed()) {
    if (!changed.has(member.key)) {
      continue;
    }
    changed.delete(member.key);
    const value = after[member.key];
    if (value === undefined) {
      const next = /^\s*,\s*/u.exec(edited.slice(member.valueEnd));
      const removeFrom =
        next === null ? edited.lastIndexOf(",", member.start) : member.start;
      const removeTo =
        next === null ? member.valueEnd : member.valueEnd + next[0].length;
      edited = `${edited.slice(0, removeFrom === -1 ? member.start : removeFrom)}${edited.slice(removeTo)}`;
      continue;
    }
    const oneLine = !edited
      .slice(member.valueStart, member.valueEnd)
      .includes("\n");
    edited = `${edited.slice(0, member.valueStart)}${render(value, indentAt(edited, member.start), oneLine)}${edited.slice(member.valueEnd)}`;
  }
  const added = [...changed].flatMap((key) => {
    const value = after[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  if (added.length > 0) {
    const close = edited.lastIndexOf("}");
    const last = membersOf(edited)?.at(-1);
    const indent = last === undefined ? "  " : indentAt(edited, last.start);
    const lines = added.map(
      ([key, value]) =>
        `${indent}${JSON.stringify(key)}: ${render(value, indent, false)}`
    );
    const body = edited.slice(0, close).replace(/\s*$/u, "");
    const separator = last === undefined ? "\n" : ",\n";
    edited = `${body}${separator}${lines.join(",\n")}\n${edited.slice(close)}`;
  }
  return edited;
}
