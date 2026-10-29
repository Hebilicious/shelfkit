/**
 * Editing a profile document in the composer. Every function returns a new document; the composer keeps a history of
 * them for undo. A profile's `items` are item refs: `id` (compiles at the shelf's current revision) or
 * `id@sha256-<hex>` (pinned).
 */
import type { Profile } from "@shelfkit/schema";

/**
 * The OpenAPM v0.1 canonical producer set, as `crates/core/src/target.rs` lists it: the targets a profile may name
 * without an opt-in. The engine is the authority; this list only offers the choices.
 */
export const CANONICAL_TARGETS = [
  "agent-skills",
  "antigravity",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "opencode",
  "windsurf",
] as const;

/** Targets APM accepts outside the producer set: an explicit opt-in that the conflict panel reports. */
export const CLI_ONLY_TARGETS = ["grok-build", "hermes", "kiro"] as const;

/** The id part of an item ref. */
export function refId(ref: string): string {
  const at = ref.indexOf("@");
  return at === -1 ? ref : ref.slice(0, at);
}

/** The revision a ref pins, as `sha256-<hex>`, or `null` when it follows the current revision. */
export function refRevision(ref: string): string | null {
  const at = ref.indexOf("@");
  return at === -1 ? null : ref.slice(at + 1);
}

/** The version a new profile starts at: every profile has one, and it is what the profile publishes as. */
export const FIRST_PROFILE_VERSION = "0.1.0";

/** A new, empty profile with the compiler's defaults left implicit. */
export function emptyProfile(id: string, title: string): Profile {
  return {
    bundles: [],
    compile: {},
    extends: [],
    id,
    items: [],
    title,
    version: FIRST_PROFILE_VERSION,
  };
}

/** Add items by id, skipping any the profile already names. */
export function addItems(profile: Profile, ids: readonly string[]): Profile {
  const present = new Set(profile.items.map((ref) => refId(ref)));
  const added = ids.filter((id) => !present.has(id));
  return added.length === 0
    ? profile
    : { ...profile, items: [...profile.items, ...added] };
}

/** Insert one item at a position (drag and drop), or move it there when the profile already names it. */
export function placeItem(
  profile: Profile,
  id: string,
  index: number
): Profile {
  const existing = profile.items.find((ref) => refId(ref) === id) ?? id;
  const rest = profile.items.filter((ref) => refId(ref) !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  return {
    ...profile,
    items: [...rest.slice(0, at), existing, ...rest.slice(at)],
  };
}

/**
 * Put a removed item back exactly as it was named (pinned or not) at its old position, leaving every other edit made
 * since: undo of one removal. Nothing changes when the profile names the item again already.
 */
export function restoreItem(
  profile: Profile,
  itemRef: string,
  index: number
): Profile {
  const id = refId(itemRef);
  if (profile.items.some((existing) => refId(existing) === id)) {
    return profile;
  }
  const at = Math.max(0, Math.min(index, profile.items.length));
  return {
    ...profile,
    items: [...profile.items.slice(0, at), itemRef, ...profile.items.slice(at)],
  };
}

export function removeItem(profile: Profile, id: string): Profile {
  return {
    ...profile,
    items: profile.items.filter((ref) => refId(ref) !== id),
  };
}

/** Move an item one place up (`-1`) or down (`1`). */
export function moveItem(
  profile: Profile,
  id: string,
  offset: -1 | 1
): Profile {
  const index = profile.items.findIndex((ref) => refId(ref) === id);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= profile.items.length) {
    return profile;
  }
  const items = [...profile.items];
  const [moved] = items.splice(index, 1);
  if (moved === undefined) {
    return profile;
  }
  items.splice(target, 0, moved);
  return { ...profile, items };
}

/** Pin an item to a revision, or unpin it with `null`. */
export function pinItem(
  profile: Profile,
  id: string,
  revision: string | null
): Profile {
  return {
    ...profile,
    items: profile.items.map((ref) => {
      if (refId(ref) !== id) {
        return ref;
      }
      return revision === null ? id : `${id}@${revision}`;
    }),
  };
}

/** Toggle a string in a list field (`bundles`, `extends`, `compile.targets`). */
export function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((entry) => entry !== value)
    : [...list, value];
}

/**
 * The document as the shelf would store it: optional fields that are empty are left out, so a profile saved from the
 * composer compiles exactly as the same file written by hand. `version` is required and always kept, even empty, so
 * the shelf reports it.
 */
export function normalizeProfile(profile: Profile): Profile {
  const compile = Object.fromEntries(
    Object.entries(profile.compile).filter(
      ([, value]) => value !== undefined && value !== ""
    )
  );
  const normalized: Profile = {
    bundles: profile.bundles,
    compile,
    extends: profile.extends,
    id: profile.id,
    items: profile.items,
    title: profile.title,
    version: profile.version,
  };
  if (profile.$schema !== undefined) {
    normalized.$schema = profile.$schema;
  }
  if (profile.description !== undefined && profile.description.trim() !== "") {
    normalized.description = profile.description;
  }
  return normalized;
}

/** A profile id from a title: lowercase kebab-case, as item and profile ids must be. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);
}
