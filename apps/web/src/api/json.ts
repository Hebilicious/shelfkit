/**
 * The `JSON` scalar is the one place GraphQL's types say nothing. Each such value is checked here, with the Valibot
 * schemas the engine and the Worker use, before a screen reads it.
 */
import {
  CompilePlanSchema,
  ItemKindSchema,
  ProfileSchema,
  ResolvedProfileSchema,
  SourceSchema,
} from "@shelfkit/schema";
import type {
  CompilePlan,
  Profile,
  ResolvedProfile,
  Source,
} from "@shelfkit/schema";
import * as v from "valibot";

import type { PromptVariable } from "../lib/prompt.ts";

const VariablesSchema = v.array(
  v.object({
    default: v.optional(v.string()),
    description: v.optional(v.string()),
    name: v.string(),
    required: v.optional(v.boolean()),
  })
);

/**
 * A prompt's declared variables; an unreadable value reads as none.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readVariables(value: unknown): PromptVariable[] {
  const parsed = v.safeParse(VariablesSchema, value);
  return parsed.success ? parsed.output : [];
}

/**
 * A profile document as `profiles/<id>.json` holds it, or `null` when it is not one.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readProfile(value: unknown): Profile | null {
  const parsed = v.safeParse(ProfileSchema, value);
  return parsed.success ? parsed.output : null;
}

/**
 * A compile plan, exactly as `shelfkit compile --dry-run --json` prints it, or `null`.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readPlan(value: unknown): CompilePlan | null {
  const parsed = v.safeParse(CompilePlanSchema, value);
  return parsed.success ? parsed.output : null;
}

/** BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here. */
export function readResolution(value: unknown): ResolvedProfile | null {
  const parsed = v.safeParse(ResolvedProfileSchema, value);
  return parsed.success ? parsed.output : null;
}

/**
 * An item's provenance, or `null` when it was authored here (or the value is unreadable).
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readSource(value: unknown): Source | null {
  const parsed = v.safeParse(SourceSchema, value);
  return parsed.success ? parsed.output : null;
}

const BundleSchema = v.object({
  description: v.optional(v.string()),
  id: v.string(),
  items: v.array(v.string()),
  title: v.string(),
});

export type BundleDocument = v.InferOutput<typeof BundleSchema>;

/** BOUNDARY: `Shelf.bundles` is a list of unparsed `JSON` values; `BundleSchema` parses each here. */
export function readBundles(value: readonly unknown[]): BundleDocument[] {
  return value.flatMap((bundle) => {
    const parsed = v.safeParse(BundleSchema, bundle);
    return parsed.success ? [parsed.output] : [];
  });
}

const ShelfSourceSchema = v.object({
  id: v.string(),
  kind: v.string(),
  path: v.optional(v.string()),
  profile: v.optional(v.string()),
  repo: v.optional(v.string()),
  secret: v.optional(v.string()),
  tier: v.optional(v.number()),
  url: v.optional(v.string()),
});

export type ShelfSourceEntry = v.InferOutput<typeof ShelfSourceSchema>;

/**
 * `shelf.json`'s `sources`; entries that are not sources are left out.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readSources(value: unknown): ShelfSourceEntry[] {
  const parsed = v.safeParse(v.array(v.unknown()), value);
  if (!parsed.success) {
    return [];
  }
  return parsed.output.flatMap((entry) => {
    const source = v.safeParse(ShelfSourceSchema, entry);
    return source.success ? [source.output] : [];
  });
}

/**
 * One candidate an import offers (`packages/importers`' `Candidate`). Read loosely, so a field the importer adds
 * later does not hide the candidate.
 */
const CandidateSchema = v.looseObject({
  description: v.optional(v.string()),
  id: v.string(),
  key: v.string(),
  kind: ItemKindSchema,
  license: v.optional(v.string()),
  licenseId: v.optional(v.string()),
  linkOnly: v.boolean(),
  path: v.optional(v.string()),
  title: v.string(),
  upstream: v.optional(
    v.looseObject({
      digest: v.optional(v.string()),
      ref: v.optional(v.string()),
      resolvedCommit: v.optional(v.string()),
      url: v.optional(v.string()),
      version: v.optional(v.string()),
    })
  ),
});

export type ImportCandidate = v.InferOutput<typeof CandidateSchema>;

/** BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here. */
export function readCandidates(value: unknown): ImportCandidate[] {
  const parsed = v.safeParse(v.array(v.unknown()), value);
  if (!parsed.success) {
    return [];
  }
  return parsed.output.flatMap((entry) => {
    const candidate = v.safeParse(CandidateSchema, entry);
    return candidate.success ? [candidate.output] : [];
  });
}

const RecommendedProfilesSchema = v.array(
  v.object({ id: v.string(), items: v.array(v.string()), title: v.string() })
);

/**
 * The profiles a stack match recommends.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readRecommendedProfiles(
  value: unknown
): v.InferOutput<typeof RecommendedProfilesSchema> {
  const parsed = v.safeParse(RecommendedProfilesSchema, value);
  return parsed.success ? parsed.output : [];
}

/**
 * A list of strings, from a JSON value that should be one.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function readStrings(value: unknown): string[] {
  const parsed = v.safeParse(v.array(v.string()), value);
  return parsed.success ? parsed.output : [];
}

/**
 * A JSON value as indented text, for a screen that shows a document as it is held.
 * BOUNDARY: a GraphQL `JSON` value is unparsed; the schema above parses it here.
 */
export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
