/**
 * Keeping the relay's credentials out of what it returns. A relayed server may echo what it was sent, in an error
 * message ("invalid credential: Bearer …"), in a result, or in a tool's description, and the caller holds only an
 * `mcp:` grant, never the credential. So every string the relay passes on, at any depth and in object keys too, has
 * each form of each credential it sent replaced, before it leaves the Worker.
 */
import type * as v from "valibot";

import { readJson } from "./wire.ts";
import type { JsonObject } from "./wire.ts";

/** What a credential is replaced with. */
export const REDACTED = "[redacted]";

/** Forms shorter than this are not searched for: they would match ordinary text, and no credential is that short. */
const SHORTEST_FORM = 6;

/** The base64 text of a string's UTF-8 bytes. */
function base64(text: string): string {
  return btoa(String.fromCodePoint(...new TextEncoder().encode(text)));
}

/** A base64 text decoded as UTF-8, or `null` when it is not that. */
function unbase64(text: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0)
    );
  } catch {
    return null;
  }
}

/** The forms of one header value a server could echo: as sent, after its scheme, a Basic pair and its password. */
function formsOf(value: string): string[] {
  const forms = [value];
  const scheme = /^(?<scheme>[A-Za-z]+)\s+(?<rest>\S.*)$/u.exec(value)?.groups;
  const credential = scheme?.rest ?? value;
  forms.push(credential);
  if (scheme?.scheme?.toLowerCase() === "basic") {
    const pair = unbase64(credential);
    if (pair !== null) {
      forms.push(pair, pair.slice(pair.indexOf(":") + 1));
    }
  }
  return forms.flatMap((form) => [form, base64(form)]);
}

/** Every form of every value, longest first, so a longer form is replaced before a form it contains. */
export function secretForms(values: readonly string[]): string[] {
  return [...new Set(values.flatMap((value) => formsOf(value)))]
    .filter((form) => form.length >= SHORTEST_FORM)
    .toSorted((a, b) => b.length - a.length);
}

/** A form as it appears inside a JSON string: with JSON's escapes. */
function escaped(form: string): string {
  return JSON.stringify(form).slice(1, -1);
}

/**
 * `value`, checked against `schema`, with every form replaced in every string and object key at any depth; `null`
 * when the redacted value no longer fits the schema. The value is redacted as JSON text, so nothing in it is missed
 * however deep it sits.
 */
export function redact<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: JsonObject,
  forms: readonly string[]
): v.InferOutput<TSchema> | null {
  let text = JSON.stringify(value);
  for (const form of forms) {
    text = text.replaceAll(escaped(form), REDACTED);
  }
  const redacted = readJson(schema, text);
  return redacted?.success === true ? redacted.output : null;
}
