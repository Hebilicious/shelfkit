/**
 * YAML frontmatter: what a Markdown primitive says about itself, and whether a SKILL.md is one the shelf loader
 * accepts. The loader (`crates/core`, `skill.rs`) refuses a SKILL.md an agent cannot use; an import that copied a
 * SKILL.md it rejects would fail the whole import's snapshot, so the adapter checks first and imports such a skill as
 * a link instead, rather than editing the author's file.
 */
import * as v from "valibot";
import { parse } from "yaml";

/** What a primitive's frontmatter says about itself, as far as an import reads it. */
export interface Meta {
  description?: string;
  license?: string;
  name?: string;
  title?: string;
}

const TextSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/** The fields an import reads, each still as the author wrote it; anything else in the frontmatter is left alone. */
const FieldsSchema = v.looseObject({
  description: v.optional(v.unknown()),
  license: v.optional(v.unknown()),
  name: v.optional(v.unknown()),
  title: v.optional(v.unknown()),
});

/** A frontmatter value as non-empty text, or `undefined`. BOUNDARY: the value is the author's, untyped. */
function textOf(value: unknown): string | undefined {
  const parsed = v.safeParse(TextSchema, value);
  return parsed.success ? parsed.output : undefined;
}

/** The YAML between the leading `---` lines, as the loader finds it, or `undefined` when there is none. */
function yamlBlock(text: string): string | undefined {
  const normalized = text.replaceAll("\r\n", "\n").replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  const end = normalized.indexOf("\n---", 4);
  return end === -1 ? undefined : normalized.slice(4, end);
}

/** The parsed YAML of a frontmatter block, or `undefined` when it does not parse. BOUNDARY: callers parse it. */
function parsedYaml(text: string): unknown {
  const block = yamlBlock(text);
  if (block === undefined) {
    return undefined;
  }
  try {
    // BOUNDARY: YAML from upstream is untyped until a schema reads it.
    const value: unknown = parse(block);
    return value;
  } catch {
    return undefined;
  }
}

/** What a primitive's frontmatter says about it: its name, title, description, and licence, when it states them. */
export function frontmatter(text: string): Meta {
  const parsed = v.safeParse(FieldsSchema, parsedYaml(text));
  if (!parsed.success) {
    return {};
  }
  const meta: Meta = {};
  const { description, license, name, title } = parsed.output;
  for (const [key, value] of [
    ["description", textOf(description)],
    ["license", textOf(license)],
    ["name", textOf(name)],
    ["title", textOf(title)],
  ] as const) {
    if (value !== undefined) {
      meta[key] = value;
    }
  }
  return meta;
}

/**
 * SKILL.md's frontmatter as the shelf loader requires it: a `name` equal to the item id and a non-empty
 * `description`. Other agentskills.io deviations (unknown keys, a long description, nested `metadata`) load, and
 * `shelfkit check` reports them as `skill-frontmatter` notices, so they do not stop an import.
 */
function skillSchema(id: string) {
  return v.looseObject({
    description: v.pipe(
      v.string("description is required and must be a string"),
      v.check((text) => text.trim() !== "", "description must be non-empty")
    ),
    name: v.pipe(
      v.string("name is required and must be a string"),
      v.check((name) => name === id, `name must be the item id \`${id}\``)
    ),
  });
}

/**
 * Why a SKILL.md would not load as the skill `id`, or `undefined` when it would: it needs YAML frontmatter that
 * parses to a mapping, a `name` equal to the id, and a non-empty `description`.
 */
export function skillProblem(text: string, id: string): string | undefined {
  const yaml = parsedYaml(text);
  if (yaml === undefined) {
    return "SKILL.md has no YAML frontmatter";
  }
  const parsed = v.safeParse(skillSchema(id), yaml);
  if (parsed.success) {
    return undefined;
  }
  const problems = parsed.issues.map((issue) => {
    const path = v.getDotPath(issue);
    return path === null ? issue.message : `${path}: ${issue.message}`;
  });
  return `SKILL.md's frontmatter is not one the shelf loads (${problems.join("; ")})`;
}
