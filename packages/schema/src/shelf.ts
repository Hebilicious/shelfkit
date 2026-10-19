/**
 * The shelf format as it crosses a boundary. `crates/core` owns the format; these schemas describe the same JSON the
 * Rust model reads and writes, field for field, so the Worker and the browser can validate it without the crate.
 * `test/contract.test.ts` loads the core fixtures through them to keep the two in step.
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

/** `sha256-<64 lowercase hex>`: the content address of an item or of a resolved profile. */
export const RevisionSchema = v.pipe(
  v.string(),
  v.regex(/^sha256-[0-9a-f]{64}$/u, "must be a sha256-<64 hex> revision")
);

/** A digest over bytes, as the registry writes it: `sha256:<64 lowercase hex>`. */
export const DigestSchema = v.pipe(
  v.string(),
  v.regex(/^sha256:[0-9a-f]{64}$/u, "must be a sha256:<64 hex> digest")
);

/**
 * Item ids are kebab-case, at most 64 characters, and may not contain `__`, which the MCP namespace separator
 * reserves. Kebab-case has no underscore at all, so the pattern alone excludes it. The Rust model enforces the same
 * rule.
 */
export const ItemIdSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "must be lowercase kebab-case")
);

/** Semantic Versioning 2.0.0, as the Rust `is_semver` checks it: no leading zeros, dot-separated identifiers. */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;

/** Profiles and bundles use the item id rules. */
export const ProfileIdSchema = ItemIdSchema;

/**
 * Which shelf a call addresses. A deployment holds several shelves, one Durable Object each, so every call names one.
 *
 * The value is the shelf's registry namespace (`registry.namespace` in `shelf.json`): the `{owner}` of the OpenAPM
 * Registry routes, where each profile is published as the package `{owner}/{repo}` = `{shelf}/{profile}`. One name
 * therefore addresses the shelf on the registry, in key scopes (`read:{shelf}/*`, `publish:{shelf}/{profile}`), and
 * over MCP.
 */
export const ShelfIdSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "must be a lowercase kebab-case registry namespace"
  )
);

/**
 * `id` (latest) or `id@sha256-…` (pinned to a revision), as in a profile's `items`. The lookahead holds the id to the
 * same 64 characters as `ItemIdSchema`.
 */
export const ItemRefSchema = v.pipe(
  v.string(),
  v.regex(
    /^(?=[^@]{1,64}(?:@|$))[a-z0-9]+(?:-[a-z0-9]+)*(?:@sha256-[0-9a-f]{64})?$/u,
    "must be an item id of at most 64 characters, optionally pinned as id@sha256-<64 hex>"
  )
);

/**
 * An APM target slug, verbatim. The loader classifies it: the OpenAPM v0.1 producer set is the default, CLI-only
 * slugs are an opt-in, and `intellij` is rejected. This schema checks only the spelling.
 */
export const TargetSlugSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9-]*$/u, "must be an APM target slug")
);

/** What makes a stack or library detectable, and what `shelf.recommend` matches against. */
export const MarkersSchema = v.strictObject({
  dependencies: v.optional(v.array(v.string())),
  files: v.optional(v.array(v.string())),
  packageManager: v.optional(v.string()),
});

/**
 * Where an imported item came from, and what using it obliges. Carried on the item, once per import, because one
 * import from one source shares one attribution obligation. Absent on an item authored in the shelf.
 */
export const SourceSchema = v.strictObject({
  /** The credit the source requires, as text. */
  creditText: v.optional(v.string()),
  /** The upstream digest, as `sha256:<hex>`, for a registry source. */
  digest: v.optional(v.string()),
  /** The `id` of an entry in `shelf.json`'s `sources`. */
  id: v.optional(v.string()),
  /** The licence as the source states it. */
  license: v.optional(v.string()),
  /** The SPDX identifier of the licence. */
  licenseId: v.optional(v.string()),
  /** Where the credit links to. */
  linkTarget: v.optional(v.string()),
  /** The path of the item inside the upstream repository or package. */
  path: v.optional(v.string()),
  /** The deep link to this item's record at the source. */
  recordUrl: v.optional(v.string()),
  /** The ref the import asked for: a tag, a branch, or a commit. */
  ref: v.optional(v.string()),
  /** The upstream Git repository. */
  repo: v.optional(v.string()),
  /** The commit `ref` resolved to when the item was imported. */
  resolvedCommit: v.optional(v.string()),
  /** Whether derived work must carry the same licence. */
  shareAlike: v.optional(v.boolean()),
  /** The upstream URL, for a source that is not Git. */
  url: v.optional(v.string()),
  /** The resolved version, for a registry source. */
  version: v.optional(v.string()),
});

/** A secret name: what `{ "secret": NAME }` and a source's `secret` refer to. */
export const SecretNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z][A-Z0-9_]*$/u, "must be UPPER_SNAKE_CASE")
);

/** A secret is a reference to a name the runtime resolves, never a literal. A literal is for values that are not secret. */
export const SecretValueSchema = v.union([
  v.string(),
  v.strictObject({
    secret: v.pipe(
      v.string(),
      v.regex(/^[A-Z][A-Z0-9_]*$/u, "must be UPPER_SNAKE_CASE")
    ),
  }),
]);

const SectionSchema = v.strictObject({ body: v.string(), heading: v.string() });

const SecretsSchema = v.record(v.string(), SecretValueSchema);

const RemoteTransportSchema = v.picklist(["http", "sse", "streamable-http"]);

/** The fields every item has, beside its kind's own. */
const common = {
  $schema: v.optional(v.string()),
  /** The opt-in for CLI-only slugs in `targets`, which `shelfkit check` reports. */
  allowNonconformantTargets: v.optional(v.boolean()),
  description: v.optional(v.string()),
  id: ItemIdSchema,
  requires: v.optional(v.array(ItemIdSchema)),
  source: v.optional(SourceSchema),
  tags: v.optional(v.array(v.string())),
  targets: v.optional(v.array(TargetSlugSchema)),
  title: v.pipe(v.string(), v.minLength(1)),
};

const McpSchema = v.variant("flavour", [
  v.strictObject({
    ...common,
    flavour: v.literal("remote"),
    headers: v.optional(SecretsSchema),
    kind: v.literal("mcp"),
    /** The MCP registry name. With no `url`, APM resolves the server through the registry by this name. */
    name: v.optional(v.string()),
    tools: v.optional(v.array(v.string())),
    transport: v.optional(RemoteTransportSchema),
    url: v.optional(v.string()),
  }),
  v.strictObject({
    ...common,
    args: v.optional(v.array(v.string())),
    command: v.string(),
    cwd: v.optional(v.string()),
    env: v.optional(SecretsSchema),
    flavour: v.literal("stdio"),
    kind: v.literal("mcp"),
    name: v.optional(v.string()),
    tools: v.optional(v.array(v.string())),
  }),
  v.strictObject({
    ...common,
    flavour: v.literal("hosted"),
    /** Injected upstream by ShelfKit; the caller never sees them. */
    headers: v.optional(SecretsSchema),
    kind: v.literal("mcp"),
    tools: v.optional(v.array(v.string())),
    transport: v.optional(RemoteTransportSchema),
    /** The upstream server ShelfKit relays to, over https. */
    url: v.string(),
  }),
]);

/** An item, exactly as `items/<kind>/<id>/item.json` holds it. */
export const ItemSchema = v.variant("kind", [
  v.strictObject({ ...common, kind: v.literal("skill") }),
  v.strictObject({
    ...common,
    asCommand: v.optional(v.boolean()),
    kind: v.literal("prompt"),
    variables: v.optional(
      v.array(
        v.strictObject({
          default: v.optional(v.string()),
          description: v.optional(v.string()),
          name: v.string(),
          required: v.optional(v.boolean()),
        })
      )
    ),
  }),
  v.strictObject({
    ...common,
    kind: v.literal("instructions"),
    markers: v.optional(MarkersSchema),
    sections: v.optional(v.array(SectionSchema)),
  }),
  v.strictObject({ ...common, kind: v.literal("agent") }),
  v.strictObject({ ...common, kind: v.literal("hook") }),
  v.strictObject({ ...common, kind: v.literal("plugin") }),
  McpSchema,
  v.strictObject({
    ...common,
    args: v.optional(v.array(v.string())),
    command: v.string(),
    env: v.optional(SecretsSchema),
    extensionToLanguage: v.record(v.string(), v.string()),
    initializationOptions: v.optional(v.unknown()),
    kind: v.literal("lsp"),
    maxRestarts: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    name: v.string(),
    restartOnCrash: v.optional(v.boolean()),
    settings: v.optional(v.unknown()),
    shutdownTimeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    startupTimeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    transport: v.optional(v.picklist(["stdio", "socket"])),
    workspaceFolder: v.optional(v.string()),
  }),
  v.strictObject({
    ...common,
    detect: v.optional(MarkersSchema),
    docs: v.optional(v.string()),
    kind: v.literal("library"),
    notes: v.optional(v.array(v.string())),
  }),
  v.strictObject({
    ...common,
    conventions: v.optional(v.array(SectionSchema)),
    kind: v.literal("stack"),
    markers: MarkersSchema,
    recommends: v.optional(v.array(ItemIdSchema)),
  }),
]);

/** What a list shows for an item: enough to choose it, not its content. */
export const ItemSummarySchema = v.strictObject({
  description: v.string(),
  id: ItemIdSchema,
  kind: ItemKindSchema,
  revision: RevisionSchema,
  tags: v.array(v.string()),
  title: v.string(),
});

/** What `shelfkit check` reports that does not stop a load: the Rust `Notice`. */
export const NoticeSchema = v.strictObject({
  code: v.picklist(["producer-nonconformant-target", "unratified-lsp"]),
  message: v.string(),
  /** The file the notice is about, relative to the shelf root. */
  path: v.string(),
});

/** A profile's compile settings after `extends`, with defaults filled in: the Rust `CompileSettings`. */
export const CompileSettingsSchema = v.strictObject({
  allowNonconformantTargets: v.boolean(),
  name: v.string(),
  onConflict: v.picklist(["fail", "shelf-wins", "local-wins"]),
  pin: v.picklist(["revision", "latest"]),
  /** Sorted. Empty means the manifest leaves `targets` out and APM detects the harnesses. */
  targets: v.array(TargetSlugSchema),
  vendorAuthored: v.boolean(),
});

/** One item in a resolved profile: the Rust `ResolvedItem`. */
export const ResolvedItemSchema = v.strictObject({
  /**
   * The item's revision in the shelf now. A pin must name the revision the shelf holds, so this equals `revision`
   * today; it differs only if a later source serves older snapshots.
   */
  current: RevisionSchema,
  id: ItemIdSchema,
  kind: ItemKindSchema,
  /** Why the item is in the profile. */
  origin: v.variant("via", [
    v.strictObject({ profile: ProfileIdSchema, via: v.literal("profile") }),
    v.strictObject({
      bundle: ProfileIdSchema,
      profile: ProfileIdSchema,
      via: v.literal("bundle"),
    }),
    v.strictObject({ item: ItemIdSchema, via: v.literal("requires") }),
  ]),
  pinned: v.boolean(),
  /** The revision this profile compiles, pinned or not. The profile revision covers it. */
  revision: RevisionSchema,
});

/** A profile with bundles, `extends`, and `requires` expanded: the Rust `ResolvedProfile`. */
export const ResolvedProfileSchema = v.strictObject({
  compile: CompileSettingsSchema,
  id: ProfileIdSchema,
  /** Sorted by id. */
  items: v.array(ResolvedItemSchema),
  notices: v.array(NoticeSchema),
  /** The profile file, relative to the shelf root. */
  path: v.string(),
  /** A hash of the resolved compile settings and of every item's id and revision. */
  revision: RevisionSchema,
});

/** A profile's `compile` settings as written: every field optional, so `extends` can tell what a child set. */
export const CompileOptionsSchema = v.strictObject({
  allowNonconformantTargets: v.optional(v.boolean()),
  name: v.optional(v.string()),
  onConflict: v.optional(v.picklist(["fail", "shelf-wins", "local-wins"])),
  pin: v.optional(v.picklist(["revision", "latest"])),
  targets: v.optional(v.array(TargetSlugSchema)),
  vendorAuthored: v.optional(v.boolean()),
});

/** A profile exactly as `profiles/<id>.json` holds it, and as the Rust `Profile` serializes it. */
export const ProfileSchema = v.strictObject({
  $schema: v.optional(v.string()),
  bundles: v.array(ProfileIdSchema),
  compile: CompileOptionsSchema,
  /** Left out when empty. */
  description: v.optional(v.string()),
  extends: v.array(ProfileIdSchema),
  id: ProfileIdSchema,
  items: v.array(ItemRefSchema),
  title: v.string(),
  /** The semver the profile publishes as on a registry; without it, one is generated from the revision. */
  version: v.optional(
    v.pipe(v.string(), v.regex(SEMVER, "must be a semantic version"))
  ),
});

export const ProfileSummarySchema = v.strictObject({
  description: v.string(),
  id: ProfileIdSchema,
  revision: RevisionSchema,
  title: v.string(),
});

/** A bundle exactly as `bundles/<id>.json` holds it: a named item list with no compile settings. */
export const BundleSchema = v.strictObject({
  $schema: v.optional(v.string()),
  description: v.optional(v.string()),
  id: ProfileIdSchema,
  items: v.array(ItemRefSchema),
  title: v.string(),
});

/** The kinds of place items come from (`docs/PRD.md` section 6): the Rust `SourceKind`. */
export const SourceKindSchema = v.picklist([
  "git",
  "apm-registry",
  "shelfkit",
  "catalog",
  "marketplace",
  "path",
]);

/** An entry in `shelf.json`'s `sources`: the Rust `ShelfSource`. */
export const ShelfSourceSchema = v.strictObject({
  id: v.string(),
  kind: SourceKindSchema,
  path: v.optional(v.string()),
  /** For a `shelfkit` source: the profile to import. */
  profile: v.optional(v.string()),
  repo: v.optional(v.string()),
  /** The secret name of a credential the source needs; released only to the origin the owner bound it to. */
  secret: v.optional(SecretNameSchema),
  tier: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  url: v.optional(v.string()),
});

/** `shelf.json`: the Rust `Manifest`. */
export const ShelfManifestSchema = v.strictObject({
  $schema: v.optional(v.string()),
  defaultProfile: v.optional(v.string()),
  description: v.optional(v.string()),
  name: v.string(),
  owner: v.optional(v.string()),
  /** How the shelf appears as an OpenAPM registry; a hosted service addresses the shelf by `namespace`. */
  registry: v.optional(
    v.strictObject({
      namespace: ShelfIdSchema,
      public: v.optional(v.boolean()),
    })
  ),
  sources: v.optional(v.array(ShelfSourceSchema)),
});

/** Where an item lands in `apm.yml` when a profile pinned by revision compiles it: the Rust `Coordinate`. */
export const CoordinateSchema = v.variant("kind", [
  /** A `dependencies.apm` reference to its upstream; `entry` is that entry as YAML. */
  v.strictObject({ entry: v.string(), kind: v.literal("upstream") }),
  /** Its content is vendored into the profile's local package. */
  v.strictObject({ kind: v.literal("vendored") }),
  v.strictObject({ kind: v.literal("mcp"), name: v.nullable(v.string()) }),
  v.strictObject({ kind: v.literal("lsp"), name: v.string() }),
  /** Its `source` cannot be referenced; compiling it fails with `message`. */
  v.strictObject({ kind: v.literal("unresolvable"), message: v.string() }),
]);

/** A whole shelf indexed by the engine: the Rust `engine::Inventory`. */
export const InventorySchema = v.strictObject({
  bundles: v.array(BundleSchema),
  items: v.array(
    v.strictObject({
      coordinate: CoordinateSchema,
      /** Relative to the item directory, sorted. */
      files: v.array(v.string()),
      item: ItemSchema,
      /** The item directory, relative to the shelf root. */
      path: v.string(),
      revision: RevisionSchema,
    })
  ),
  manifest: ShelfManifestSchema,
  notices: v.array(NoticeSchema),
  profiles: v.array(
    v.strictObject({
      profile: ProfileSchema,
      resolution: ResolvedProfileSchema,
    })
  ),
});

/** What `shelfkit recommend --json` prints: the Rust `Recommendation`. */
export const RecommendationSchema = v.strictObject({
  items: v.array(
    v.strictObject({
      id: ItemIdSchema,
      kind: ItemKindSchema,
      matched: MarkersSchema,
      recommendedBy: v.array(ItemIdSchema),
      title: v.string(),
    })
  ),
  profiles: v.array(
    v.strictObject({
      id: ProfileIdSchema,
      items: v.array(ItemIdSchema),
      title: v.string(),
    })
  ),
});

export type Bundle = v.InferOutput<typeof BundleSchema>;
export type Coordinate = v.InferOutput<typeof CoordinateSchema>;
export type Inventory = v.InferOutput<typeof InventorySchema>;
export type Recommendation = v.InferOutput<typeof RecommendationSchema>;
export type ShelfManifest = v.InferOutput<typeof ShelfManifestSchema>;
export type ShelfSource = v.InferOutput<typeof ShelfSourceSchema>;
export type SourceKind = v.InferOutput<typeof SourceKindSchema>;
export type ItemKind = v.InferOutput<typeof ItemKindSchema>;
export type Item = v.InferOutput<typeof ItemSchema>;
export type ItemSummary = v.InferOutput<typeof ItemSummarySchema>;
export type Markers = v.InferOutput<typeof MarkersSchema>;
export type Profile = v.InferOutput<typeof ProfileSchema>;
export type Notice = v.InferOutput<typeof NoticeSchema>;
export type ResolvedProfile = v.InferOutput<typeof ResolvedProfileSchema>;
export type Source = v.InferOutput<typeof SourceSchema>;
