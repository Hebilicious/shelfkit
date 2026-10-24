/**
 * ShelfKit's own MCP tools, as AcidCat capabilities: the frozen contract that the MCP endpoint (issue #6) serves and
 * the web UI (issue #7) renders.
 *
 * AcidCat's MCP binding names each tool by its capability id, so the tool an agent calls is `shelf.search`, not
 * `shelf_search`. Capability ids contain no `_`, and a relayed backend tool is `<item>__<tool>`, so the two namespaces
 * cannot collide (`docs/PRD.md` section 8.1, rule 3).
 *
 * Each export is a descriptor without `run`: issue #6 spreads it into `@acid-cat/core-ts`'s `capability({ ...,
 * run })`, which accepts these Valibot schemas as Standard Schemas. `acidcat.catalog.json` beside this package is
 * rendered from the same descriptors, and `moon run schema:check` fails when it is stale.
 *
 * Every call names its shelf, because one deployment holds several. Every capability reads, except `shelf.report`.
 */
import * as v from "valibot";

import {
  DigestSchema,
  ItemIdSchema,
  ItemKindSchema,
  ItemRefSchema,
  ItemSchema,
  ItemSummarySchema,
  MarkersSchema,
  NoticeSchema,
  ProfileIdSchema,
  ProfileSchema,
  ProfileSummarySchema,
  ResolvedProfileSchema,
  RevisionSchema,
  ShelfIdSchema,
} from "./shelf.ts";

/** The AcidCat target the capabilities are served to, through AcidCat's MCP binding. */
export const MCP_TARGET = "mcp";

const audience = [MCP_TARGET] as const;

/** A failure, as AcidCat returns it: an object whose `_tag` names it, and a message for the agent. */
function failure<
  const Tag extends string,
  const Entries extends v.ObjectEntries,
>(tag: Tag, entries: Entries) {
  return v.strictObject({
    ...entries,
    _tag: v.literal(tag),
    message: v.string(),
  });
}

export const ShelfNotFoundSchema = failure("ShelfNotFound", {
  shelf: ShelfIdSchema,
});
export const ProfileNotFoundSchema = failure("ProfileNotFound", {
  profile: ProfileIdSchema,
});
export const ItemNotFoundSchema = failure("ItemNotFound", {
  item: ItemIdSchema,
});

/** The item exists, but the shelf holds no snapshot at the requested revision. */
export const RevisionNotFoundSchema = failure("RevisionNotFound", {
  item: ItemIdSchema,
  revision: RevisionSchema,
});

/** The profile does not compile: a conflict, a rejected target, or an item that failed to load. */
export const CompileFailedSchema = failure("CompileFailed", {
  errors: v.array(v.strictObject({ message: v.string(), path: v.string() })),
});

/** The key cannot write to this shelf. */
export const ForbiddenSchema = failure("Forbidden", {});

const shelfInput = { shelf: ShelfIdSchema };

export const shelfSearch = {
  audience,
  description:
    "Search one shelf's items by text over titles, descriptions, tags, and prompt bodies. Filter by kind and tag; " +
    'with no query, list every item that passes the filters, such as every MCP server with kinds ["mcp"]. ' +
    "Returns summaries; read an item with shelf.item.get, which gives an MCP server's whole definition.",
  failures: { ShelfNotFound: ShelfNotFoundSchema },
  id: "shelf.search",
  input: v.strictObject({
    ...shelfInput,
    kinds: v.optional(v.array(ItemKindSchema)),
    /** At most this many results; 20 when absent. */
    limit: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))
    ),
    /** The text to match. Without it, every item passes, so `kinds: ["mcp"]` lists the shelf's MCP servers. */
    query: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    /** Items carrying every one of these tags. */
    tags: v.optional(v.array(v.string())),
  }),
  output: v.strictObject({
    items: v.array(
      v.strictObject({
        item: ItemSummarySchema,
        /** The matching text, when the match is in content rather than in the title. */
        snippet: v.optional(v.string()),
      })
    ),
    /** More items matched than `limit`. */
    truncated: v.boolean(),
  }),
  readOnly: true,
} as const;

export const shelfRecommend = {
  audience,
  description:
    "Recommend items and profiles for a repository from its stack markers: the files at its root, the package " +
    "names in its dependency manifests, and its package manager. Stacks and libraries match on their markers, and " +
    "a matched stack brings the items it recommends.",
  failures: { ShelfNotFound: ShelfNotFoundSchema },
  id: "shelf.recommend",
  input: v.strictObject({ ...shelfInput, markers: MarkersSchema }),
  output: v.strictObject({
    items: v.array(
      v.strictObject({
        item: ItemSummarySchema,
        /** The markers of the repository that this item matched; empty when it is only recommended. */
        matched: MarkersSchema,
        /** The matched stacks that recommend this item. */
        recommendedBy: v.array(ItemIdSchema),
      })
    ),
    /** Profiles that contain recommended items, with the ones they contain. */
    profiles: v.array(
      v.strictObject({
        items: v.array(ItemIdSchema),
        profile: ProfileSummarySchema,
      })
    ),
  }),
  readOnly: true,
} as const;

export const shelfProfileGet = {
  audience,
  description:
    "Read one profile: what it declares, and its resolution, with bundles, extends, and requires expanded, each " +
    "item's revision and origin, and the notices shelfkit check reports for it.",
  failures: {
    ProfileNotFound: ProfileNotFoundSchema,
    ShelfNotFound: ShelfNotFoundSchema,
  },
  id: "shelf.profile.get",
  input: v.strictObject({ ...shelfInput, profile: ProfileIdSchema }),
  output: v.strictObject({
    /** The profile as written in `profiles/<id>.json`, as the Rust model serializes it. */
    profile: ProfileSchema,
    resolution: ResolvedProfileSchema,
  }),
  readOnly: true,
} as const;

export const shelfItemGet = {
  audience,
  description:
    "Read one item: its item.json, its revision, and its files. Name it as `id` for the current revision, or " +
    "`id@sha256-…` for a pinned one.",
  failures: {
    ItemNotFound: ItemNotFoundSchema,
    RevisionNotFound: RevisionNotFoundSchema,
    ShelfNotFound: ShelfNotFoundSchema,
  },
  id: "shelf.item.get",
  input: v.strictObject({ ...shelfInput, item: ItemRefSchema }),
  output: v.strictObject({
    /** Every file in the item directory, `item.json` included, sorted by path. */
    files: v.array(
      v.strictObject({
        contents: v.string(),
        /** `utf-8` for text, `base64` for anything that is not valid UTF-8. */
        encoding: v.picklist(["utf-8", "base64"]),
        /** Relative to the item directory. */
        path: v.string(),
      })
    ),
    item: ItemSchema,
    /** The item directory, relative to the shelf root. */
    path: v.string(),
    revision: RevisionSchema,
  }),
  readOnly: true,
} as const;

/**
 * Something the user must be told about a compile. The first two codes and `skill-frontmatter` are the resolver's
 * notices; `hook-approval`
 * says the profile vendors a hook, which APM gates behind approval; `hosted-mcp` says a server ShelfKit relays compiles
 * to no `dependencies.mcp` entry; and `mcp-schema-mismatch` says an MCP entry uses the object form APM documents, which
 * the published OpenAPM v0.1 JSON Schema rejects.
 */
export const CompileNoteSchema = v.strictObject({
  ...NoticeSchema.entries,
  code: v.picklist([
    "producer-nonconformant-target",
    "unratified-lsp",
    "hook-approval",
    "hosted-mcp",
    "mcp-schema-mismatch",
    "skill-frontmatter",
  ]),
});

/**
 * The compiled plan for one profile. It is the JSON form of the compiler's `CompiledManifest`
 * (`crates/compiler/src/manifest.rs`), which issue #3 serializes with exactly these camelCase fields, so the CLI's
 * `compile --dry-run`, the composer's preview, and this capability cannot drift.
 */
export const CompilePlanSchema = v.strictObject({
  /** The `apm.yml` to write at the repository root, rendered. */
  apmYml: v.string(),
  /** `sha256:<hex>` over the bytes of `apmYml`, for `shelf.report`. */
  apmYmlDigest: DigestSchema,
  /**
   * The vendored files to write, paths relative to the repository root, sorted by path. `contents` is text unless
   * `encoding` is `base64`, for a file that is not UTF-8 (an image in a skill).
   */
  files: v.array(
    v.strictObject({
      contents: v.string(),
      encoding: v.optional(v.picklist(["utf-8", "base64"])),
      path: v.string(),
    })
  ),
  /** The command to run after writing the files. Printed, never run by ShelfKit. */
  installCommand: v.string(),
  /** What the user must be told: an unratified `lsp` key, Producer-nonconformant targets, hooks to approve. */
  notes: v.array(CompileNoteSchema),
  profile: ProfileIdSchema,
  /** The resolved profile's revision, for `shelf.report`. */
  profileRevision: RevisionSchema,
});

export const shelfCompilePlan = {
  audience,
  description:
    "Plan the compile of one profile: the apm.yml to write, the vendored files, the install command, and the " +
    "notes to pass on to the user. It changes nothing: ShelfKit plans, the agent writes the files, APM installs. " +
    "Report the result with shelf.report.",
  failures: {
    CompileFailed: CompileFailedSchema,
    ProfileNotFound: ProfileNotFoundSchema,
    ShelfNotFound: ShelfNotFoundSchema,
  },
  id: "shelf.compile.plan",
  input: v.strictObject({ ...shelfInput, profile: ProfileIdSchema }),
  output: CompilePlanSchema,
  readOnly: true,
} as const;

/**
 * `docs/PRD.md` does not define this capability's semantics. They are inferred from the Activity screen of section 9,
 * "which repositories compiled which profile revision, and what is stale": an agent that applied a plan from
 * `shelf.compile.plan` to a repository records that it did, and how it went. The call writes only that activity
 * record. It changes no item, profile, or revision, and it is the one capability that is not read-only.
 */
export const shelfReport = {
  audience,
  description:
    "Record that a plan from shelf.compile.plan was applied to a repository: the profile and revision, the digest " +
    "of the apm.yml written, and the outcome. This writes an activity record and nothing else. Returns whether the " +
    "profile has moved on since.",
  failures: {
    Forbidden: ForbiddenSchema,
    ProfileNotFound: ProfileNotFoundSchema,
    ShelfNotFound: ShelfNotFoundSchema,
  },
  id: "shelf.report",
  input: v.strictObject({
    ...shelfInput,
    /** `apmYmlDigest` from the plan, or the digest of the `apm.yml` actually written if it was edited. */
    apmYmlDigest: DigestSchema,
    /** The commit the plan was applied on, when the repository has one. */
    commit: v.optional(
      v.pipe(
        v.string(),
        v.regex(
          /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u,
          "must be a full commit hash"
        )
      )
    ),
    /** What went wrong, when `outcome` is `failed`. */
    message: v.optional(v.pipe(v.string(), v.maxLength(2000))),
    /** `applied`: the files were written. `installed`: `apm install` also succeeded. `failed`: neither completed. */
    outcome: v.picklist(["applied", "installed", "failed"]),
    profile: ProfileIdSchema,
    profileRevision: RevisionSchema,
    /** The repository's identity: its remote as `host/owner/repo`, or a directory name when it has no remote. */
    repository: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  }),
  output: v.strictObject({
    /** The profile's revision now. */
    currentRevision: RevisionSchema,
    /** The activity record's id. */
    id: v.string(),
    recordedAt: v.pipe(v.string(), v.isoTimestamp()),
    /** The reported revision is no longer the profile's current one. */
    stale: v.boolean(),
  }),
  readOnly: false,
} as const;

/** Every capability, in the order a client lists them. */
export const capabilities = [
  shelfSearch,
  shelfRecommend,
  shelfProfileGet,
  shelfItemGet,
  shelfCompilePlan,
  shelfReport,
] as const;

/** The catalog's own fields. `description` is also the MCP server's instructions to a model. */
export const catalog = {
  description:
    "A shelf of curated agent context: skills, prompts, instructions, agents, hooks, plugins, MCP servers, " +
    "language servers, libraries, and stacks, composed into profiles. Find what fits a repository, read it, and " +
    "plan the apm.yml that installs a profile. ShelfKit plans and never writes; you write the files, APM installs.",
  targets: { [MCP_TARGET]: { bindings: ["mcp"] } },
  title: "ShelfKit",
} as const;

export type CompilePlan = v.InferOutput<typeof CompilePlanSchema>;
