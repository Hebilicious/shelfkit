/**
 * YAML frontmatter: what a Markdown primitive says about itself, and whether a SKILL.md is one the shelf loader
 * accepts. The loader (`crates/core`, `load.rs`) checks SKILL.md against agentskills.io; an import that copied a
 * SKILL.md it rejects would fail the whole import's snapshot, so the adapter checks first and imports such a skill as
 * a link instead, rather than editing the author's file.
 */
import { parse } from "yaml";

/** The frontmatter mapping, or `undefined` when there is none or it is not a mapping. */
export function frontmatter(text: string): Record<string, unknown> | undefined {
  const normalized = text.replaceAll("\r\n", "\n").replace(/^﻿/u, "");
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return undefined;
  }
  try {
    const value: unknown = parse(normalized.slice(4, end));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A string field of a frontmatter mapping. */
export function stringField(
  mapping: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = mapping?.[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

const SKILL_KEYS = new Set([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);

/**
 * Why a SKILL.md would not load as the skill `id`, or `undefined` when it would. The same rules as the loader's:
 * agentskills.io keys only, `name` equal to the id, a description of 1 to 1024 characters, string-valued `license`,
 * `compatibility` (at most 500 characters), and `allowed-tools`, and a `metadata` of strings.
 */
export function skillProblem(text: string, id: string): string | undefined {
  const mapping = frontmatter(text);
  if (mapping === undefined) {
    return "SKILL.md has no YAML frontmatter mapping";
  }
  const unknown = Object.keys(mapping).filter((key) => !SKILL_KEYS.has(key));
  if (unknown.length > 0) {
    return `SKILL.md has keys agentskills.io does not allow: ${unknown.join(", ")}`;
  }
  if (mapping.name !== id) {
    return `SKILL.md's name \`${String(mapping.name)}\` is not the item id \`${id}\``;
  }
  const description = mapping.description;
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    [...description].length > 1024
  ) {
    return "SKILL.md's description must be 1 to 1024 characters";
  }
  for (const key of ["license", "compatibility", "allowed-tools"]) {
    if (key in mapping && typeof mapping[key] !== "string") {
      return `SKILL.md's \`${key}\` must be a string`;
    }
  }
  const compatibility = mapping.compatibility;
  if (typeof compatibility === "string" && [...compatibility].length > 500) {
    return "SKILL.md's compatibility must be at most 500 characters";
  }
  const metadata = mapping.metadata;
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" ||
      metadata === null ||
      Object.values(metadata).some((value) => typeof value !== "string"))
  ) {
    return "SKILL.md's metadata must map strings to strings";
  }
  return undefined;
}
