/**
 * The GraphQL API: everything the web UI and the CLI do, including key management (`docs/PRD.md` sections 9 and 10).
 *
 * Built with Pothos on first use (`buildSchema`), never at module scope. Each resolver is a thin call into the shelf's
 * Durable Object, the same methods the MCP endpoint calls, so the UI and an agent cannot disagree. A shelf the viewer
 * cannot read is `null`, as if it did not exist; a mutation the viewer may not make is a `FORBIDDEN` error.
 *
 * `apps/worker/schema.graphql` is this schema printed; `moon run worker:graphql-schema` writes it and the gate fails
 * when it is stale.
 */
import SchemaBuilder from "@pothos/core";
import { conflictsOf } from "@shelfkit/engine";
import type { Conflict } from "@shelfkit/engine";
import { ItemSchema, ShelfIdSchema, shelfReport } from "@shelfkit/schema";
import type {
  CompilePlan,
  ItemSummary,
  Markers,
  Profile,
  ResolvedProfile,
} from "@shelfkit/schema";
import { GraphQLError, valueFromASTUntyped } from "graphql";
import type { GraphQLSchema } from "graphql";
import * as v from "valibot";

import {
  access,
  listShelves,
  shelfExists,
  sessionForKey,
  shelfStub,
  signInCookie,
  signOutCookie,
} from "../auth/index.ts";
import { parseSecret, secretHash } from "../auth/keys.ts";
import type { JobMessage } from "../jobs/messages.ts";
import type {
  ImportJobRecord,
  ItemDetail,
  RevisionRecord,
  ShelfSummary,
} from "../shelf-index.ts";
import type { Committed, ShelfEvent, ShelfProblem } from "../shelf/api.ts";
import { PRIMARY_FILE } from "../shelf/files.ts";
import type { GraphQLContext } from "./context.ts";

interface ShelfNode {
  readonly id: string;
  readonly summary: ShelfSummary;
}

interface ItemNode {
  readonly shelf: string;
  readonly summary: ItemSummary;
}

interface ProfileNode {
  readonly shelf: string;
  readonly profile: Profile;
  readonly resolution: ResolvedProfile;
}

interface ResolutionNode {
  readonly shelf: string;
  readonly resolution: ResolvedProfile;
  readonly conflicts: readonly Conflict[];
}

interface PlanResult {
  readonly plan: CompilePlan | null;
  readonly errors: readonly ShelfProblem[];
}

interface FileNode {
  readonly shelf: string;
  readonly item: string;
  readonly revision: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * A JSON input as plain objects. GraphQL builds an inline object literal with a null prototype, which cannot cross a
 * Durable Object's RPC boundary; a JSON round trip makes it plain, and drops anything that is not JSON.
 */
// BOUNDARY: a JSON scalar's input is any JSON value until a resolver parses it with its schema.
function plainJson(value: unknown): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is the point: it drops what is not JSON, which `structuredClone` keeps or throws on.
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
}

function shelfArg(id: string): string {
  const parsed = v.safeParse(ShelfIdSchema, id);
  if (!parsed.success) {
    throw badInput(`\`${id}\` is not a shelf id`);
  }
  return parsed.output;
}

/** Throw for a commit refused because the viewer may not make it; any other refusal is the result's `errors`. */
function committed(result: Committed): Committed {
  if (!result.ok && result.reason === "forbidden") {
    throw forbidden(result.errors.map((error) => error.message).join("; "));
  }
  return result;
}

async function sendJob(
  context: GraphQLContext,
  message: JobMessage
): Promise<void> {
  await context.env.JOBS.send(message);
}

function stub(context: GraphQLContext, shelf: string) {
  return shelfStub(context.env, shelf);
}

async function detail(
  context: GraphQLContext,
  node: ItemNode
): Promise<ItemDetail> {
  return await context.memo(
    `item ${node.shelf} ${node.summary.id}`,
    async () => {
      const found = await shelfStub(context.env, node.shelf).itemDetail(
        context.session,
        node.shelf,
        node.summary.id
      );
      if (found === null) {
        throw new GraphQLError(`the item \`${node.summary.id}\` is gone`, {
          extensions: { code: "NOT_FOUND" },
        });
      }
      return found;
    }
  );
}

async function contents(
  context: GraphQLContext,
  shelf: string,
  item: string,
  revision: string
) {
  return await context.memo(`files ${shelf} ${item}@${revision}`, async () => {
    const found = await shelfStub(context.env, shelf).getItem(
      context.session,
      shelf,
      `${item}@${revision}`
    );
    return found.ok ? found.value.files : [];
  });
}

async function planOf(
  context: GraphQLContext,
  shelf: string,
  profile: string
): Promise<PlanResult> {
  return await context.memo(`plan ${shelf} ${profile}`, async () => {
    const found = await shelfStub(context.env, shelf).planCompile(
      context.session,
      shelf,
      profile
    );
    if (found.ok) {
      return { errors: [], plan: found.value };
    }
    return {
      errors:
        found.failure._tag === "CompileFailed" ? found.failure.errors : [],
      plan: null,
    };
  });
}

async function loadShelf(
  context: GraphQLContext,
  id: string
): Promise<ShelfNode | null> {
  const target = await existingShelf(context, id);
  if (target === null) {
    return null;
  }
  const found = await target.summary(context.session, id);
  return found.ok ? { id, summary: found.value } : null;
}

/** The shelf's object when the deployment holds the shelf, checked once per request; `null` creates nothing. */
async function existingShelf(context: GraphQLContext, shelf: string) {
  const exists = await context.memo(
    `exists ${shelf}`,
    async () => await shelfExists(context.env, shelf)
  );
  return exists ? shelfStub(context.env, shelf) : null;
}

/** The shelf's object for a mutation, or `NOT_FOUND` when the deployment holds no such shelf. */
async function held(context: GraphQLContext, shelf: string) {
  const target = await existingShelf(context, shelf);
  if (target === null) {
    throw new GraphQLError(`there is no shelf \`${shelf}\``, {
      extensions: { code: "NOT_FOUND" },
    });
  }
  return target;
}

function encoding(value: string | null | undefined): "utf-8" | "base64" {
  if (value === "base64") {
    return "base64";
  }
  if (value === undefined || value === null || value === "utf-8") {
    return "utf-8";
  }
  throw badInput(`\`${value}\` is not an encoding: use utf-8 or base64`);
}

function requireKey(context: GraphQLContext): void {
  if (context.session.kind !== "owner" && context.session.kind !== "key") {
    throw new GraphQLError("this needs a key", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
}

export function buildSchema(): GraphQLSchema {
  // Fields are non-null unless they say otherwise, so the SDL promises what the resolvers guarantee.
  const builder = new SchemaBuilder<{
    Context: GraphQLContext;
    DefaultFieldNullability: false;
    Scalars: {
      JSON: { Input: unknown; Output: unknown };
      DateTime: { Input: string; Output: string };
    };
  }>({ defaultFieldNullability: false });

  builder.scalarType("JSON", {
    description:
      "Any JSON value: a shelf document (item.json, a profile) exactly as the shelf holds it.",
    parseLiteral: (node, variables) =>
      plainJson(valueFromASTUntyped(node, variables)),
    parseValue: (value) => plainJson(value),
    serialize: (value) => value,
  });
  builder.scalarType("DateTime", {
    description: "An RFC 3339 UTC timestamp.",
    parseValue: (value) => v.parse(v.pipe(v.string(), v.isoTimestamp()), value),
    serialize: (value) => value,
  });

  const ItemKind = builder.enumType("ItemKind", {
    description: "The ten item kinds (`docs/PRD.md` section 5.2).",
    values: [
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
    ] as const,
  });

  const Severity = builder.enumType("Severity", {
    values: ["error", "warning", "info"] as const,
  });

  const ScanStatus = builder.enumType("ScanStatus", {
    description:
      "A revision's scan state. `unscanned` is not `clean`: no scanner has seen this revision. `disputed`: scanners disagree.",
    values: ["unscanned", "clean", "flagged", "disputed"] as const,
  });

  const DriftStatus = builder.enumType("DriftStatus", {
    description:
      "Whether an imported item's upstream has moved since it was pinned. `authored`: not imported. `unchecked`: imported, not checked yet.",
    values: [
      "authored",
      "unchecked",
      "current",
      "moved",
      "gone",
      "error",
    ] as const,
  });

  const ShelfEventKind = builder.enumType("ShelfEventKind", {
    values: [
      "snapshot",
      "item",
      "profile",
      "activity",
      "import",
      "keys",
      "settings",
      "package",
      "scan",
      "upstream",
    ] as const,
  });

  // --- Shared objects --------------------------------------------------------------------------------------------

  const Problem = builder.objectRef<ShelfProblem>("ShelfProblem").implement({
    description: "A problem with the shelf, in the file it came from.",
    fields: (t) => ({
      message: t.exposeString("message"),
      path: t.exposeString("path"),
    }),
  });

  const ConflictRef = builder.objectRef<Conflict>("Conflict").implement({
    description:
      "Something the composer's conflict panel shows: an engine error (`error`), or a resolver notice or compile note.",
    fields: (t) => ({
      code: t.exposeString("code"),
      message: t.exposeString("message"),
      path: t.exposeString("path"),
      severity: t.field({
        resolve: (conflict) => conflict.severity,
        type: Severity,
      }),
    }),
  });

  const Snapshot = builder
    .objectRef<NonNullable<ShelfSummary["snapshot"]>>("Snapshot")
    .implement({
      description:
        "One state of the shelf's files. Its manifest is the R2 object named by `digest`.",
      fields: (t) => ({
        createdAt: t.field({
          resolve: (row) => row.createdAt,
          type: "DateTime",
        }),
        digest: t.exposeString("digest"),
        fileCount: t.exposeInt("fileCount"),
        keyId: t.exposeString("keyId", { nullable: true }),
        message: t.exposeString("message", { nullable: true }),
        origin: t.exposeString("origin"),
        parent: t.exposeString("parent", { nullable: true }),
        totalBytes: t.exposeFloat("totalBytes"),
      }),
    });

  const SnapshotFile = builder
    .objectRef<{
      readonly path: string;
      readonly sha256: string;
      readonly size: number;
    }>("SnapshotFile")
    .implement({
      description:
        "A file of the current snapshot: download it from `/raw/{shelf}/objects/{sha256}`.",
      fields: (t) => ({
        path: t.exposeString("path"),
        sha256: t.exposeString("sha256"),
        size: t.exposeInt("size"),
      }),
    });

  const Commit = builder.objectRef<Committed>("CommitResult").implement({
    description:
      "What a write that changes the shelf's files answers: the new snapshot, or why it was refused (`invalid`: the engine refused the shelf; `missing`: upload these objects first; `conflict`: the shelf moved since `parent`).",
    fields: (t) => ({
      changedItems: t.stringList({
        resolve: (result) => (result.ok ? result.changed.items : []),
      }),
      changedProfiles: t.stringList({
        resolve: (result) => (result.ok ? result.changed.profiles : []),
      }),
      errors: t.field({
        resolve: (result) => (result.ok ? [] : result.errors),
        type: [Problem],
      }),
      missing: t.stringList({
        resolve: (result) => (result.ok ? [] : (result.missing ?? [])),
      }),
      ok: t.exposeBoolean("ok"),
      reason: t.string({
        nullable: true,
        resolve: (result) => (result.ok ? null : result.reason),
      }),
      removedItems: t.stringList({
        resolve: (result) => (result.ok ? result.changed.removed : []),
      }),
      snapshot: t.field({
        nullable: true,
        resolve: (result) => (result.ok ? result.snapshot : null),
        type: Snapshot,
      }),
    }),
  });

  const Plan = builder.objectRef<CompilePlan>("CompilePlan").implement({
    description:
      "A compiled profile: exactly what `shelfkit compile --dry-run --json` prints and `shelf.compile.plan` returns.",
    fields: (t) => ({
      apmYml: t.exposeString("apmYml"),
      apmYmlDigest: t.exposeString("apmYmlDigest"),
      files: t.field({ resolve: (plan) => plan.files, type: "JSON" }),
      installCommand: t.exposeString("installCommand"),
      json: t.field({
        description: "The whole plan as JSON.",
        resolve: (plan) => plan,
        type: "JSON",
      }),
      notes: t.field({ resolve: (plan) => plan.notes, type: "JSON" }),
      profile: t.exposeString("profile"),
      profileRevision: t.exposeString("profileRevision"),
    }),
  });

  const PlanResultRef = builder.objectRef<PlanResult>("PlanResult").implement({
    fields: (t) => ({
      errors: t.field({ resolve: (result) => result.errors, type: [Problem] }),
      plan: t.field({
        nullable: true,
        resolve: (result) => result.plan,
        type: Plan,
      }),
    }),
  });

  // --- Items -----------------------------------------------------------------------------------------------------

  const ItemFile = builder.objectRef<FileNode>("ItemFile").implement({
    description:
      "A file of an item at one revision, its path relative to the item directory.",
    fields: (t) => ({
      contents: t.string({
        description: "The text, or base64 when `encoding` is `base64`.",
        resolve: async (file, _args, context) => {
          const files = await contents(
            context,
            file.shelf,
            file.item,
            file.revision
          );
          return (
            files.find((entry) => entry.path === file.path)?.contents ?? ""
          );
        },
      }),
      encoding: t.string({
        resolve: async (file, _args, context) => {
          const files = await contents(
            context,
            file.shelf,
            file.item,
            file.revision
          );
          return (
            files.find((entry) => entry.path === file.path)?.encoding ?? "utf-8"
          );
        },
      }),
      path: t.exposeString("path"),
      sha256: t.exposeString("sha256"),
      size: t.exposeInt("size"),
    }),
  });

  const Revision = builder
    .objectRef<
      RevisionRecord & { readonly shelf: string; readonly item: string }
    >("ItemRevision")
    .implement({
      description:
        "One immutable snapshot of an item: what a profile pins and what a scan verdict attaches to.",
      fields: (t) => ({
        createdAt: t.field({
          resolve: (row) => row.createdAt,
          type: "DateTime",
        }),
        document: t.field({ resolve: (row) => row.document, type: "JSON" }),
        files: t.field({
          resolve: (row) =>
            row.files.map((file) => ({
              ...file,
              item: row.item,
              revision: row.revision,
              shelf: row.shelf,
            })),
          type: [ItemFile],
        }),
        keyId: t.exposeString("keyId", { nullable: true }),
        message: t.exposeString("message", { nullable: true }),
        revision: t.exposeString("revision"),
        snapshot: t.exposeString("snapshot"),
      }),
    });

  const Scan = builder
    .objectRef<ItemDetail["scans"][number]>("ScanRecord")
    .implement({
      description:
        "A scanner's verdict on one revision, recorded against the hash ShelfKit computed.",
      fields: (t) => ({
        detailsUrl: t.exposeString("detailsUrl", { nullable: true }),
        id: t.exposeID("id"),
        observed: t.exposeString("observed", { nullable: true }),
        recordedAt: t.field({
          resolve: (row) => row.recordedAt,
          type: "DateTime",
        }),
        revision: t.exposeString("revision"),
        scanner: t.exposeString("scanner"),
        summary: t.exposeString("summary", { nullable: true }),
        verdict: t.exposeString("verdict"),
      }),
    });

  const Drift = builder
    .objectRef<{ readonly detail: ItemDetail }>("Drift")
    .implement({
      description: "An imported item's pin against its upstream now.",
      fields: (t) => ({
        checkedAt: t.field({
          nullable: true,
          resolve: ({ detail: found }) => found.upstream?.checkedAt ?? null,
          type: "DateTime",
        }),
        error: t.string({
          nullable: true,
          resolve: ({ detail: found }) => found.upstream?.error ?? null,
        }),
        latest: t.field({
          nullable: true,
          resolve: ({ detail: found }) => found.upstream?.latest ?? null,
          type: "JSON",
        }),
        pinned: t.field({
          description:
            "What the item is pinned to: its `source`'s ref, commit, version, and digest.",
          nullable: true,
          resolve: ({ detail: found }) => {
            const { source } = found.document;
            return source === undefined
              ? null
              : {
                  digest: source.digest,
                  ref: source.ref,
                  resolvedCommit: source.resolvedCommit,
                  url: source.url,
                  version: source.version,
                };
          },
          type: "JSON",
        }),
        status: t.field({
          resolve: ({ detail: found }) => {
            if (found.document.source === undefined) {
              return "authored" as const;
            }
            return found.upstream?.status ?? ("unchecked" as const);
          },
          type: DriftStatus,
        }),
      }),
    });

  const Dependents = builder
    .objectRef<ItemDetail["dependents"]>("Dependents")
    .implement({
      description: "What in the shelf names an item: its reverse dependencies.",
      fields: (t) => ({
        bundles: t.stringList({ resolve: (row) => row.bundles }),
        profiles: t.stringList({ resolve: (row) => row.profiles }),
        recommendedBy: t.stringList({ resolve: (row) => row.recommendedBy }),
        requiredBy: t.stringList({ resolve: (row) => row.requiredBy }),
      }),
    });

  const Coordinate = builder
    .objectRef<ItemDetail["coordinate"]>("Coordinate")
    .implement({
      description:
        "Where an item lands in apm.yml when a profile pinned by revision compiles it: an upstream `dependencies.apm` entry (`entry`, YAML), the profile's vendored package, a `dependencies.mcp` or `dependencies.lsp` entry, or `unresolvable` with the reason.",
      fields: (t) => ({
        entry: t.string({
          nullable: true,
          resolve: (row) => (row.kind === "upstream" ? row.entry : null),
        }),
        kind: t.exposeString("kind"),
        message: t.string({
          nullable: true,
          resolve: (row) => (row.kind === "unresolvable" ? row.message : null),
        }),
        name: t.string({
          nullable: true,
          resolve: (row) =>
            row.kind === "mcp" || row.kind === "lsp" ? row.name : null,
        }),
      }),
    });

  const Item = builder.objectRef<ItemNode>("Item").implement({
    description:
      "An item: an addressable primitive of the shelf, at its current revision.",
    fields: (t) => ({
      asCommand: t.boolean({
        nullable: true,
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.document.kind === "prompt"
            ? (found.document.asCommand ?? false)
            : null;
        },
      }),
      body: t.string({
        description:
          "The text of the file the kind is defined by (prompt.md, SKILL.md, agent.md, AGENTS.fragment.md).",
        nullable: true,
        resolve: async (node, _args, context) => {
          const primary = PRIMARY_FILE.get(node.summary.kind);
          if (primary === undefined) {
            return null;
          }
          const files = await contents(
            context,
            node.shelf,
            node.summary.id,
            node.summary.revision
          );
          const found = files.find((file) => file.path === primary);
          return found?.encoding === "utf-8" ? found.contents : null;
        },
      }),
      coordinate: t.field({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.coordinate;
        },
        type: Coordinate,
      }),
      createdAt: t.field({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.createdAt;
        },
        type: "DateTime",
      }),
      dependents: t.field({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.dependents;
        },
        type: Dependents,
      }),
      description: t.string({ resolve: (node) => node.summary.description }),
      document: t.field({
        description: "The item's item.json.",
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.document;
        },
        type: "JSON",
      }),
      drift: t.field({
        resolve: async (node, _args, context) => ({
          detail: await detail(context, node),
        }),
        type: Drift,
      }),
      favourite: t.boolean({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.favourite;
        },
      }),
      files: t.field({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.files.map((file) => ({
            ...file,
            item: node.summary.id,
            revision: node.summary.revision,
            shelf: node.shelf,
          }));
        },
        type: [ItemFile],
      }),
      id: t.id({ resolve: (node) => node.summary.id }),
      kind: t.field({ resolve: (node) => node.summary.kind, type: ItemKind }),
      path: t.string({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.path;
        },
      }),
      revision: t.string({ resolve: (node) => node.summary.revision }),
      revisionAt: t.field({
        args: { revision: t.arg.string({ required: true }) },
        description: "One past or current revision.",
        nullable: true,
        resolve: async (node, args, context) => {
          const all = await shelfStub(context.env, node.shelf).itemRevisions(
            context.session,
            node.shelf,
            node.summary.id
          );
          const found = all?.find((row) => row.revision === args.revision);
          return found === undefined
            ? null
            : { ...found, item: node.summary.id, shelf: node.shelf };
        },
        type: Revision,
      }),
      revisions: t.field({
        description: "Every revision, newest first.",
        resolve: async (node, _args, context) =>
          (
            (await shelfStub(context.env, node.shelf).itemRevisions(
              context.session,
              node.shelf,
              node.summary.id
            )) ?? []
          ).map((row) => ({
            ...row,
            item: node.summary.id,
            shelf: node.shelf,
          })),
        type: [Revision],
      }),
      scanStatus: t.field({
        description: "The scan state of the current revision.",
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          const verdicts = found.scans.filter(
            (scan) => scan.revision === node.summary.revision
          );
          if (verdicts.length === 0) {
            return "unscanned" as const;
          }
          const flagged = verdicts.filter(
            (scan) => scan.verdict !== "clean"
          ).length;
          if (flagged === 0) {
            return "clean" as const;
          }
          return flagged === verdicts.length
            ? ("flagged" as const)
            : ("disputed" as const);
        },
        type: ScanStatus,
      }),
      scans: t.field({
        description:
          "Every verdict on every revision, newest first, disagreeing ones included.",
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.scans;
        },
        type: [Scan],
      }),
      source: t.field({
        description:
          "Provenance: where the item came from, its pin, licence, and attribution. Null when authored here.",
        nullable: true,
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.document.source ?? null;
        },
        type: "JSON",
      }),
      tags: t.stringList({ resolve: (node) => node.summary.tags }),
      targets: t.stringList({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.document.targets ?? [];
        },
      }),
      title: t.string({ resolve: (node) => node.summary.title }),
      updatedAt: t.field({
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.updatedAt;
        },
        type: "DateTime",
      }),
      variables: t.field({
        description: "A prompt's variables; empty for other kinds.",
        resolve: async (node, _args, context) => {
          const found = await detail(context, node);
          return found.document.kind === "prompt"
            ? (found.document.variables ?? [])
            : [];
        },
        type: "JSON",
      }),
    }),
  });

  const SearchHit = builder
    .objectRef<{
      readonly shelf: string;
      readonly item: ItemSummary;
      readonly snippet?: string;
    }>("SearchHit")
    .implement({
      fields: (t) => ({
        item: t.field({
          resolve: (hit) => ({ shelf: hit.shelf, summary: hit.item }),
          type: Item,
        }),
        snippet: t.string({
          description:
            "The matching text, when the match is in the item's content.",
          nullable: true,
          resolve: (hit) => hit.snippet ?? null,
        }),
      }),
    });

  const ItemList = builder
    .objectRef<{
      readonly shelf: string;
      readonly hits: readonly {
        readonly item: ItemSummary;
        readonly snippet?: string;
      }[];
      readonly total: number;
    }>("ItemList")
    .implement({
      fields: (t) => ({
        nodes: t.field({
          resolve: (list) =>
            list.hits.map((hit) => ({ ...hit, shelf: list.shelf })),
          type: [SearchHit],
        }),
        total: t.exposeInt("total"),
      }),
    });

  const RecentItem = builder
    .objectRef<{
      readonly shelf: string;
      readonly item: ItemSummary;
      readonly usedAt: string;
      readonly uses: number;
    }>("RecentItem")
    .implement({
      fields: (t) => ({
        item: t.field({
          resolve: (row) => ({ shelf: row.shelf, summary: row.item }),
          type: Item,
        }),
        usedAt: t.field({ resolve: (row) => row.usedAt, type: "DateTime" }),
        uses: t.exposeInt("uses"),
      }),
    });

  // --- Profiles --------------------------------------------------------------------------------------------------

  const ResolvedItem = builder
    .objectRef<{
      readonly shelf: string;
      readonly entry: ResolvedProfile["items"][number];
    }>("ResolvedItem")
    .implement({
      fields: (t) => ({
        current: t.string({ resolve: (row) => row.entry.current }),
        id: t.id({ resolve: (row) => row.entry.id }),
        kind: t.field({ resolve: (row) => row.entry.kind, type: ItemKind }),
        origin: t.field({
          description: "Why the item is in the profile.",
          resolve: (row) => row.entry.origin,
          type: "JSON",
        }),
        pinned: t.boolean({ resolve: (row) => row.entry.pinned }),
        revision: t.string({ resolve: (row) => row.entry.revision }),
      }),
    });

  const Resolution = builder.objectRef<ResolutionNode>("Resolution").implement({
    description:
      "A profile with bundles, extends, and requires expanded: the composer's resolution rail.",
    fields: (t) => ({
      compile: t.field({
        resolve: (node) => node.resolution.compile,
        type: "JSON",
      }),
      conflicts: t.field({
        description: "Every problem, by severity.",
        resolve: (node) => node.conflicts,
        type: [ConflictRef],
      }),
      items: t.field({
        resolve: (node) =>
          node.resolution.items.map((entry) => ({ entry, shelf: node.shelf })),
        type: [ResolvedItem],
      }),
      json: t.field({ resolve: (node) => node.resolution, type: "JSON" }),
      notices: t.field({
        resolve: (node) => node.resolution.notices,
        type: "JSON",
      }),
      pinned: t.field({
        description: "Items pinned to a revision in the profile.",
        resolve: (node) =>
          node.resolution.items
            .filter((entry) => entry.pinned)
            .map((entry) => ({ entry, shelf: node.shelf })),
        type: [ResolvedItem],
      }),
      revision: t.string({ resolve: (node) => node.resolution.revision }),
      unpinned: t.field({
        description:
          "Items the profile names by id alone; they compile at the shelf's current revision.",
        resolve: (node) =>
          node.resolution.items
            .filter((entry) => !entry.pinned)
            .map((entry) => ({ entry, shelf: node.shelf })),
        type: [ResolvedItem],
      }),
    }),
  });

  const ProfileRevision = builder
    .objectRef<{
      readonly revision: string;
      readonly createdAt: string;
      readonly snapshot: string;
      readonly profile: Profile;
    }>("ProfileRevision")
    .implement({
      fields: (t) => ({
        createdAt: t.field({
          resolve: (row) => row.createdAt,
          type: "DateTime",
        }),
        document: t.field({ resolve: (row) => row.profile, type: "JSON" }),
        revision: t.exposeString("revision"),
        snapshot: t.exposeString("snapshot"),
      }),
    });

  const Package = builder
    .objectRef<{
      readonly package: string;
      readonly versions: readonly {
        readonly version: string;
        readonly digest: string;
        readonly sizeBytes: number;
        readonly publishedAt: string;
      }[];
    }>("RegistryPackage")
    .implement({
      description: "A profile published to the shelf's OpenAPM registry.",
      fields: (t) => ({
        package: t.exposeString("package"),
        versions: t.field({ resolve: (row) => row.versions, type: "JSON" }),
      }),
    });

  const ProfileRef = builder.objectRef<ProfileNode>("Profile").implement({
    fields: (t) => ({
      apmCoordinate: t.string({
        description:
          "The registry dependency that installs this profile: `{shelf}/{profile}` on the shelf's registry.",
        resolve: (node) => `${node.shelf}/${node.profile.id}`,
      }),
      description: t.string({
        resolve: (node) => node.profile.description ?? "",
      }),
      document: t.field({
        description: "The profile as profiles/<id>.json holds it.",
        resolve: (node) => node.profile,
        type: "JSON",
      }),
      id: t.id({ resolve: (node) => node.profile.id }),
      items: t.field({
        description: "The resolved items.",
        resolve: async (node, _args, context) => {
          const ids = new Set(node.resolution.items.map((entry) => entry.id));
          const found = await shelfStub(context.env, node.shelf).inventory(
            context.session,
            node.shelf,
            { limit: 200 }
          );
          return found.ok
            ? found.value.items
                .filter((hit) => ids.has(hit.item.id))
                .map((hit) => ({ shelf: node.shelf, summary: hit.item }))
            : [];
        },
        type: [Item],
      }),
      plan: t.field({
        resolve: async (node, _args, context) =>
          await planOf(context, node.shelf, node.profile.id),
        type: PlanResultRef,
      }),
      published: t.field({
        nullable: true,
        resolve: async (node, _args, context) =>
          (
            (await shelfStub(context.env, node.shelf).packages(
              context.session,
              node.shelf
            )) ?? []
          ).find(
            (row) =>
              row.package === `${node.shelf}/${node.profile.id}`.toLowerCase()
          ) ?? null,
        type: Package,
      }),
      resolution: t.field({
        resolve: async (node, _args, context) => ({
          conflicts: conflictsOf(
            node.resolution,
            await planOf(context, node.shelf, node.profile.id)
          ),
          resolution: node.resolution,
          shelf: node.shelf,
        }),
        type: Resolution,
      }),
      revision: t.string({ resolve: (node) => node.resolution.revision }),
      revisions: t.field({
        resolve: async (node, _args, context) =>
          (await shelfStub(context.env, node.shelf).profileRevisions(
            context.session,
            node.shelf,
            node.profile.id
          )) ?? [],
        type: [ProfileRevision],
      }),
      title: t.string({ resolve: (node) => node.profile.title }),
      version: t.string({
        nullable: true,
        resolve: (node) => node.profile.version ?? null,
      }),
    }),
  });

  const Preview = builder
    .objectRef<{
      readonly shelf: string;
      readonly preview: {
        readonly resolution: ResolvedProfile | null;
        readonly plan: CompilePlan | null;
        readonly errors: readonly ShelfProblem[];
      };
    }>("ProfilePreview")
    .implement({
      description:
        "An unsaved profile, resolved and compiled for the composer. Nothing is written.",
      fields: (t) => ({
        conflicts: t.field({
          resolve: (row) =>
            conflictsOf(row.preview.resolution, {
              errors: row.preview.errors,
              plan: row.preview.plan,
            }),
          type: [ConflictRef],
        }),
        errors: t.field({
          resolve: (row) => row.preview.errors,
          type: [Problem],
        }),
        plan: t.field({
          nullable: true,
          resolve: (row) => row.preview.plan,
          type: Plan,
        }),
        resolution: t.field({
          nullable: true,
          resolve: (row) =>
            row.preview.resolution === null
              ? null
              : {
                  conflicts: conflictsOf(row.preview.resolution, {
                    errors: row.preview.errors,
                    plan: row.preview.plan,
                  }),
                  resolution: row.preview.resolution,
                  shelf: row.shelf,
                },
          type: Resolution,
        }),
      }),
    });

  const Recommendation = builder
    .objectRef<{
      readonly shelf: string;
      readonly markers: unknown;
      readonly value: {
        readonly items: readonly {
          readonly item: ItemSummary;
          readonly matched: unknown;
          readonly recommendedBy: readonly string[];
        }[];
        readonly profiles: readonly {
          readonly profile: { readonly id: string };
          readonly items: readonly string[];
        }[];
      };
    }>("Recommendation")
    .implement({
      description:
        "What a repository's stack markers match: the stack-marker tester and `shelf.recommend`.",
      fields: (t) => ({
        items: t.field({
          resolve: (row) =>
            row.value.items.map((entry) => ({
              matched: entry.matched,
              node: { shelf: row.shelf, summary: entry.item },
              recommendedBy: entry.recommendedBy,
            })),
          type: [
            builder
              .objectRef<{
                readonly node: ItemNode;
                readonly matched: unknown;
                readonly recommendedBy: readonly string[];
              }>("RecommendedItem")
              .implement({
                fields: (r) => ({
                  item: r.field({ resolve: (entry) => entry.node, type: Item }),
                  matched: r.field({
                    description:
                      "The markers this item matched; empty when only recommended.",
                    resolve: (entry) => entry.matched,
                    type: "JSON",
                  }),
                  recommendedBy: r.stringList({
                    resolve: (entry) => entry.recommendedBy,
                  }),
                }),
              }),
          ],
        }),
        markers: t.field({
          description: "The markers read from the sample.",
          resolve: (row) => row.markers,
          type: "JSON",
        }),
        profiles: t.field({
          resolve: (row) => row.value.profiles,
          type: "JSON",
        }),
        stacks: t.stringList({
          description: "The stacks whose markers matched.",
          resolve: (row) =>
            row.value.items
              .filter(
                (entry) =>
                  entry.item.kind === "stack" &&
                  JSON.stringify(entry.matched) !== "{}"
              )
              .map((entry) => entry.item.id),
        }),
      }),
    });

  // --- Activity, imports, settings -------------------------------------------------------------------------------

  const Activity = builder
    .objectRef<
      NonNullable<
        Awaited<ReturnType<ReturnType<typeof shelfStub>["activity"]>>
      >[number]
    >("Activity")
    .implement({
      description:
        "A compile applied to a repository, as `shelf.report` recorded it.",
      fields: (t) => ({
        apmYmlDigest: t.exposeString("apmYmlDigest"),
        commit: t.exposeString("commit", { nullable: true }),
        id: t.exposeID("id"),
        keyId: t.exposeString("keyId", { nullable: true }),
        message: t.exposeString("message", { nullable: true }),
        outcome: t.exposeString("outcome"),
        profile: t.exposeString("profile"),
        profileRevision: t.exposeString("profileRevision"),
        recordedAt: t.field({
          resolve: (row) => row.recordedAt,
          type: "DateTime",
        }),
        repository: t.exposeString("repository"),
        stale: t.boolean({
          description: "The profile has moved on since.",
          resolve: (row) => row.stale,
        }),
      }),
    });

  const ImportJob = builder.objectRef<ImportJobRecord>("ImportJob").implement({
    description:
      "An import: a source, the candidates it offers, what was picked with which pins, and how it went.",
    fields: (t) => ({
      candidates: t.field({ resolve: (job) => job.candidates, type: "JSON" }),
      createdAt: t.field({ resolve: (job) => job.createdAt, type: "DateTime" }),
      error: t.exposeString("error", { nullable: true }),
      id: t.exposeID("id"),
      imported: t.stringList({ resolve: (job) => job.imported }),
      picks: t.field({ resolve: (job) => job.picks, type: "JSON" }),
      source: t.field({ resolve: (job) => job.source, type: "JSON" }),
      status: t.exposeString("status"),
      updatedAt: t.field({ resolve: (job) => job.updatedAt, type: "DateTime" }),
      warnings: t.stringList({ resolve: (job) => job.warnings }),
    }),
  });

  const ApiKey = builder
    .objectRef<{
      readonly id: string;
      readonly name: string;
      readonly prefix: string;
      readonly scopes: readonly string[];
      readonly createdAt: string;
      readonly lastUsedAt: string | null;
      readonly revokedAt: string | null;
    }>("ApiKey")
    .implement({
      description:
        "A scoped key. Its plaintext is never stored; `prefix` is enough to recognise it and not to use it.",
      fields: (t) => ({
        createdAt: t.field({
          resolve: (row) => row.createdAt,
          type: "DateTime",
        }),
        id: t.exposeID("id"),
        lastUsedAt: t.field({
          nullable: true,
          resolve: (row) => row.lastUsedAt,
          type: "DateTime",
        }),
        name: t.exposeString("name"),
        prefix: t.exposeString("prefix"),
        revokedAt: t.field({
          nullable: true,
          resolve: (row) => row.revokedAt,
          type: "DateTime",
        }),
        scopes: t.stringList({ resolve: (row) => row.scopes }),
      }),
    });

  const KeySecret = builder
    .objectRef<{
      readonly key: {
        readonly id: string;
        readonly name: string;
        readonly prefix: string;
        readonly scopes: readonly string[];
        readonly createdAt: string;
        readonly lastUsedAt: string | null;
        readonly revokedAt: string | null;
      };
      readonly secret: string;
    }>("KeySecret")
    .implement({
      description:
        "A key just created. `secret` is its plaintext, shown this once and stored nowhere.",
      fields: (t) => ({
        key: t.field({ resolve: (row) => row.key, type: ApiKey }),
        secret: t.exposeString("secret"),
      }),
    });

  const SecretName = builder
    .objectRef<{
      readonly name: string;
      readonly description: string | null;
      readonly origin: string | null;
      readonly createdAt: string;
      readonly configured: boolean;
    }>("SecretName")
    .implement({
      description:
        'A secret name items and sources may reference as `{ "secret": "NAME" }`. Its value is the Worker secret `SHELFKIT_SECRET_<NAME>`, set with Wrangler, and is sent only to `origin`; `configured` says whether it is set.',
      fields: (t) => ({
        configured: t.exposeBoolean("configured"),
        createdAt: t.field({
          resolve: (row) => row.createdAt,
          type: "DateTime",
        }),
        description: t.exposeString("description", { nullable: true }),
        name: t.exposeString("name"),
        origin: t.exposeString("origin", {
          description:
            "The one origin the value may be sent to; null releases it nowhere.",
          nullable: true,
        }),
      }),
    });

  const ShareLink = builder
    .objectRef<{
      readonly id: string;
      readonly profile: string;
      readonly createdAt: string;
      readonly revokedAt: string | null;
    }>("ShareLink")
    .implement({
      fields: (t) => ({
        createdAt: t.field({
          resolve: (row) => row.createdAt,
          type: "DateTime",
        }),
        id: t.exposeID("id"),
        profile: t.exposeString("profile"),
        revokedAt: t.field({
          nullable: true,
          resolve: (row) => row.revokedAt,
          type: "DateTime",
        }),
      }),
    });

  const ShareLinkSecret = builder
    .objectRef<{
      readonly link: {
        readonly id: string;
        readonly profile: string;
        readonly createdAt: string;
        readonly revokedAt: string | null;
      };
      readonly token: string;
    }>("ShareLinkSecret")
    .implement({
      description:
        "A share link just created: `token` is shown once; the public page is `/share/{token}`.",
      fields: (t) => ({
        link: t.field({ resolve: (row) => row.link, type: ShareLink }),
        token: t.exposeString("token"),
      }),
    });

  const SharedProfile = builder
    .objectRef<
      NonNullable<
        Awaited<ReturnType<ReturnType<typeof shelfStub>["sharedProfile"]>>
      >
    >("SharedProfile")
    .implement({
      description: "A profile behind a share link: read-only, no key.",
      fields: (t) => ({
        document: t.field({ resolve: (row) => row.profile, type: "JSON" }),
        errors: t.field({ resolve: (row) => row.errors, type: [Problem] }),
        id: t.id({ resolve: (row) => row.profile.id }),
        items: t.field({ resolve: (row) => row.items, type: "JSON" }),
        plan: t.field({
          nullable: true,
          resolve: (row) => row.plan,
          type: Plan,
        }),
        resolution: t.field({ resolve: (row) => row.resolution, type: "JSON" }),
        shelf: t.exposeString("shelf"),
        title: t.string({ resolve: (row) => row.profile.title }),
      }),
    });

  const Access = builder
    .objectRef<ReturnType<typeof access>>("ShelfAccess")
    .implement({
      description: "What the viewer may do on this shelf.",
      fields: (t) => ({
        member: t.exposeBoolean("member"),
        owner: t.exposeBoolean("owner"),
        profiles: t.stringList({
          description:
            "Profiles the viewer may edit besides all of them when `write`.",
          resolve: (row) => [...row.profiles],
        }),
        read: t.exposeBoolean("read"),
        relay: t.stringList({
          description:
            "Hosted MCP items the viewer may relay; `*` for every one (the owner).",
          resolve: (row) => (row.relay === "all" ? ["*"] : [...row.relay]),
        }),
        write: t.exposeBoolean("write"),
      }),
    });

  // --- The shelf -------------------------------------------------------------------------------------------------

  const Shelf = builder.objectRef<ShelfNode>("Shelf").implement({
    description: "One shelf: one Durable Object, one registry namespace.",
    fields: (t) => ({
      activity: t.field({
        args: {
          before: t.arg({ type: "DateTime" }),
          limit: t.arg.int(),
          profile: t.arg.string(),
        },
        description:
          "Which repositories compiled which profile revision, newest first, and whether it is stale.",
        resolve: async (shelf, args, context) =>
          (await stub(context, shelf.id).activity(context.session, shelf.id, {
            before: args.before ?? undefined,
            limit: args.limit ?? undefined,
            profile: args.profile ?? undefined,
          })) ?? [],
        type: [Activity],
      }),
      bundles: t.field({
        description: "Every bundle, as bundles/<id>.json holds it.",
        resolve: async (shelf, _args, context) =>
          (await stub(context, shelf.id).bundles(context.session, shelf.id)) ??
          [],
        type: ["JSON"],
      }),
      databaseBytes: t.float({
        resolve: (shelf) => shelf.summary.databaseBytes,
      }),
      defaultProfile: t.string({
        nullable: true,
        resolve: (shelf) => shelf.summary.manifest.defaultProfile ?? null,
      }),
      description: t.string({
        resolve: (shelf) => shelf.summary.manifest.description ?? "",
      }),
      favourites: t.field({
        resolve: async (shelf, _args, context) => {
          const personal = await stub(context, shelf.id).personal(
            context.session,
            shelf.id
          );
          return (personal?.favourites ?? []).map((summary) => ({
            shelf: shelf.id,
            summary,
          }));
        },
        type: [Item],
      }),
      files: t.field({
        description:
          "The current snapshot's files: what `shelfkit fetch` downloads.",
        resolve: async (shelf, _args, context) => {
          const snapshot = await stub(context, shelf.id).files(
            context.session,
            shelf.id
          );
          return snapshot?.files ?? [];
        },
        type: [SnapshotFile],
      }),
      id: t.id({ resolve: (shelf) => shelf.id }),
      importJob: t.field({
        args: { id: t.arg.id({ required: true }) },
        nullable: true,
        resolve: async (shelf, args, context) =>
          ((await stub(context, shelf.id).importJobs(
            context.session,
            shelf.id,
            args.id
          )) ?? [])[0] ?? null,
        type: ImportJob,
      }),
      importJobs: t.field({
        resolve: async (shelf, _args, context) =>
          (await stub(context, shelf.id).importJobs(
            context.session,
            shelf.id
          )) ?? [],
        type: [ImportJob],
      }),
      item: t.field({
        args: { id: t.arg.id({ required: true }) },
        nullable: true,
        resolve: async (shelf, args, context) => {
          const found = await stub(context, shelf.id).itemDetail(
            context.session,
            shelf.id,
            args.id
          );
          if (found === null) {
            return null;
          }
          await context.memo(
            `item ${shelf.id} ${found.summary.id}`,
            // oxlint-disable-next-line eslint/require-await -- seeds the memo with an answer already in hand; `memo` takes a function that returns a promise.
            async () => found
          );
          return { shelf: shelf.id, summary: found.summary };
        },
        type: Item,
      }),
      itemCount: t.int({ resolve: (shelf) => shelf.summary.itemCount }),
      items: t.field({
        args: {
          kinds: t.arg({ type: [ItemKind] }),
          limit: t.arg.int(),
          offset: t.arg.int(),
          query: t.arg.string({
            description:
              "Full-text over titles, descriptions, tags, and bodies.",
          }),
          tags: t.arg.stringList({
            description: "Items carrying every one of these tags.",
          }),
        },
        description:
          "The inventory: every item, or those matching `query`, filtered by kind and tag.",
        resolve: async (shelf, args, context) => {
          const found = await stub(context, shelf.id).inventory(
            context.session,
            shelf.id,
            {
              kinds: args.kinds ?? undefined,
              limit: args.limit ?? undefined,
              offset: args.offset ?? undefined,
              query: args.query ?? undefined,
              tags: args.tags ?? undefined,
            }
          );
          return {
            hits: found.ok ? found.value.items : [],
            shelf: shelf.id,
            total: found.ok ? found.value.total : 0,
          };
        },
        type: ItemList,
      }),
      keys: t.field({
        description: "The shelf's scoped keys. The owner only.",
        resolve: async (shelf, _args, context) => {
          const found = await stub(context, shelf.id).listKeys(context.session);
          if (found === null) {
            throw forbidden("only the owner key lists keys");
          }
          return found;
        },
        type: [ApiKey],
      }),
      knownObjects: t.stringList({
        args: {
          sha256: t.arg.stringList({
            description: "Lowercase hex SHA-256 digests, at most 2000.",
            required: true,
          }),
        },
        description:
          "Which of these digests a committed snapshot of the shelf has ever referenced: content the service has. `shelfkit fetch` replaces a local file only when its content is known here, so it never discards unpushed work.",
        resolve: async (shelf, args, context) => {
          if (args.sha256.length > 2000) {
            throw badInput("ask about at most 2000 digests at once");
          }
          return (
            (await stub(context, shelf.id).referencedObjects(
              context.session,
              shelf.id,
              args.sha256
            )) ?? []
          );
        },
      }),
      manifest: t.field({
        description: "shelf.json.",
        resolve: (shelf) => shelf.summary.manifest,
        type: "JSON",
      }),
      name: t.string({ resolve: (shelf) => shelf.summary.manifest.name }),
      notices: t.field({
        resolve: (shelf) => shelf.summary.notices,
        type: "JSON",
      }),
      owner: t.string({
        nullable: true,
        resolve: (shelf) => shelf.summary.manifest.owner ?? null,
      }),
      packages: t.field({
        resolve: async (shelf, _args, context) =>
          (await stub(context, shelf.id).packages(context.session, shelf.id)) ??
          [],
        type: [Package],
      }),
      previewProfile: t.field({
        args: { document: t.arg({ required: true, type: "JSON" }) },
        description:
          "Resolve and compile a profile document that is not saved: the composer's live preview.",
        resolve: async (shelf, args, context) => {
          const preview = await stub(context, shelf.id).previewProfile(
            context.session,
            shelf.id,
            args.document
          );
          return {
            preview: preview ?? { errors: [], plan: null, resolution: null },
            shelf: shelf.id,
          };
        },
        type: Preview,
      }),
      profile: t.field({
        args: { id: t.arg.id({ required: true }) },
        nullable: true,
        resolve: async (shelf, args, context) => {
          const found = await stub(context, shelf.id).getProfile(
            context.session,
            shelf.id,
            args.id
          );
          return found.ok ? { ...found.value, shelf: shelf.id } : null;
        },
        type: ProfileRef,
      }),
      profileCount: t.int({ resolve: (shelf) => shelf.summary.profileCount }),
      profiles: t.field({
        resolve: async (shelf, _args, context) =>
          (
            (await stub(context, shelf.id).profiles(
              context.session,
              shelf.id
            )) ?? []
          ).map((row) => ({ ...row, shelf: shelf.id })),
        type: [ProfileRef],
      }),
      prompts: t.field({
        args: {
          favouritesOnly: t.arg.boolean(),
          limit: t.arg.int(),
          offset: t.arg.int(),
          query: t.arg.string({
            description:
              "Full-text over prompt bodies, titles, descriptions, and tags.",
          }),
          tags: t.arg.stringList(),
        },
        description: "The prompt library: prompts only, searchable by body.",
        resolve: async (shelf, args, context) => {
          const found = await stub(context, shelf.id).inventory(
            context.session,
            shelf.id,
            {
              kinds: ["prompt"],
              limit:
                args.favouritesOnly === true ? 200 : (args.limit ?? undefined),
              offset:
                args.favouritesOnly === true ? 0 : (args.offset ?? undefined),
              query: args.query ?? undefined,
              tags: args.tags ?? undefined,
            }
          );
          let hits = found.ok ? found.value.items : [];
          if (args.favouritesOnly === true) {
            const personal = await stub(context, shelf.id).personal(
              context.session,
              shelf.id
            );
            const favourites = new Set(
              (personal?.favourites ?? []).map((item) => item.id)
            );
            hits = hits.filter((hit) => favourites.has(hit.item.id));
          }
          const listed = found.ok ? found.value.total : 0;
          return {
            hits,
            shelf: shelf.id,
            total: args.favouritesOnly === true ? hits.length : listed,
          };
        },
        type: ItemList,
      }),
      public: t.boolean({
        description: "Whether anonymous reads are served.",
        resolve: (shelf) => shelf.summary.public,
      }),
      recents: t.field({
        args: { limit: t.arg.int() },
        description: "Items this key used most recently.",
        resolve: async (shelf, args, context) => {
          const personal = await stub(context, shelf.id).personal(
            context.session,
            shelf.id,
            args.limit ?? 20
          );
          return (personal?.recents ?? []).map(({ usedAt, uses, ...item }) => ({
            item,
            shelf: shelf.id,
            usedAt,
            uses,
          }));
        },
        type: [RecentItem],
      }),
      recommend: t.field({
        args: {
          dependencies: t.arg.stringList(),
          files: t.arg.stringList(),
          packageManager: t.arg.string(),
        },
        resolve: async (shelf, args, context) => {
          const markers: Markers = {
            dependencies: args.dependencies ?? [],
            files: args.files ?? [],
          };
          if (
            args.packageManager !== null &&
            args.packageManager !== undefined
          ) {
            markers.packageManager = args.packageManager;
          }
          const found = await stub(context, shelf.id).recommend(
            context.session,
            shelf.id,
            markers
          );
          if (!found.ok) {
            throw new GraphQLError(found.failure.message, {
              extensions: { code: "NOT_FOUND" },
            });
          }
          return { markers, shelf: shelf.id, value: found.value };
        },
        type: Recommendation,
      }),
      registryUrl: t.string({
        description:
          "The base URL APM's `registries` entry names for this deployment.",
        resolve: (_shelf, _args, context) =>
          `${new URL(context.request.url).origin}/apm`,
      }),
      secretNames: t.field({
        resolve: async (shelf, _args, context) =>
          (await stub(context, shelf.id).secretNames(
            context.session,
            shelf.id
          )) ?? [],
        type: [SecretName],
      }),
      shareLinks: t.field({
        resolve: async (shelf, _args, context) =>
          (await stub(context, shelf.id).shareLinks(
            context.session,
            shelf.id
          )) ?? [],
        type: [ShareLink],
      }),
      snapshot: t.field({
        nullable: true,
        resolve: (shelf) => shelf.summary.snapshot,
        type: Snapshot,
      }),
      snapshots: t.field({
        args: { limit: t.arg.int() },
        resolve: async (shelf, args, context) =>
          (await stub(context, shelf.id).snapshots(
            context.session,
            shelf.id,
            args.limit ?? 50
          )) ?? [],
        type: [Snapshot],
      }),
      sources: t.field({
        description: "shelf.json's `sources`.",
        resolve: (shelf) => shelf.summary.manifest.sources ?? [],
        type: "JSON",
      }),
      stackMatch: t.field({
        args: {
          files: t.arg.stringList({
            description:
              "Files at the repository's root, besides package.json.",
          }),
          packageJson: t.arg.string({ required: true }),
        },
        description:
          "The composer's stack-marker tester: which stacks a sample package.json matches, and what they bring.",
        resolve: async (shelf, args, context) => {
          const found = await stub(context, shelf.id).matchStacks(
            context.session,
            shelf.id,
            args.packageJson,
            args.files ?? []
          );
          if (found === null) {
            throw new GraphQLError("the shelf is not readable", {
              extensions: { code: "NOT_FOUND" },
            });
          }
          if (!found.ok) {
            throw badInput(found.error);
          }
          return {
            markers: found.markers,
            shelf: shelf.id,
            value: found.recommendation,
          };
        },
        type: Recommendation,
      }),
      tags: t.field({
        resolve: async (shelf, _args, context) =>
          (await stub(context, shelf.id).tags(context.session, shelf.id)) ?? [],
        type: [
          builder
            .objectRef<{ readonly tag: string; readonly count: number }>(
              "TagCount"
            )
            .implement({
              fields: (r) => ({
                count: r.exposeInt("count"),
                tag: r.exposeString("tag"),
              }),
            }),
        ],
      }),
      viewerAccess: t.field({
        resolve: (shelf, _args, context) =>
          access(context.session, shelf.id, shelf.summary.public),
        type: Access,
      }),
    }),
  });

  const Viewer = builder
    .objectRef<GraphQLContext["session"]>("Viewer")
    .implement({
      description: "Who the request is: the owner, a scoped key, or nobody.",
      fields: (t) => ({
        authenticated: t.boolean({
          resolve: (session) =>
            session.kind === "owner" || session.kind === "key",
        }),
        keyId: t.string({
          nullable: true,
          resolve: (session) =>
            session.kind === "owner" || session.kind === "key"
              ? session.keyId
              : null,
        }),
        keyName: t.string({
          nullable: true,
          resolve: (session) => (session.kind === "key" ? session.name : null),
        }),
        owner: t.boolean({ resolve: (session) => session.kind === "owner" }),
        scopes: t.stringList({
          resolve: (session) => (session.kind === "key" ? session.scopes : []),
        }),
        shelf: t.string({
          description: "The shelf a scoped key belongs to.",
          nullable: true,
          resolve: (session) => (session.kind === "key" ? session.shelf : null),
        }),
      }),
    });

  builder.queryType({
    fields: (t) => ({
      shareLinks: t.field({
        args: { shelf: t.arg.id({ required: true }) },
        description:
          "The share links the viewer may manage: every one for a member, else those of the profiles it may edit. A key that may create a profile's link lists it here even when it cannot read the shelf.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const found = await existingShelf(context, shelf);
          return found === null
            ? []
            : ((await found.shareLinks(context.session, shelf)) ?? []);
        },
        type: [ShareLink],
      }),
      sharedProfile: t.field({
        args: { token: t.arg.string({ required: true }) },
        description: "The profile a share link names. Needs no key.",
        nullable: true,
        resolve: async (_root, args, context) => {
          const parsed = parseSecret(args.token);
          if (parsed.kind !== "share") {
            return null;
          }
          const target = await existingShelf(context, parsed.shelf);
          return target === null
            ? null
            : await target.sharedProfile(await secretHash(args.token));
        },
        type: SharedProfile,
      }),
      shelf: t.field({
        args: { id: t.arg.id({ required: true }) },
        description:
          "One shelf, or null when there is none the viewer can read.",
        nullable: true,
        resolve: async (_root, args, context) =>
          await loadShelf(context, shelfArg(args.id)),
        type: Shelf,
      }),
      shelves: t.field({
        description:
          "The shelves the viewer can reach: every shelf for the owner, a key's own shelf otherwise.",
        resolve: async (_root, _args, context) => {
          const { session } = context;
          if (session.kind === "key") {
            const own = await loadShelf(context, session.shelf);
            return own === null ? [] : [own];
          }
          if (session.kind !== "owner") {
            return [];
          }
          const listed = await listShelves(context.env);
          const found = await Promise.all(
            listed.map(async (id) => await loadShelf(context, id))
          );
          return found.filter((shelf): shelf is ShelfNode => shelf !== null);
        },
        type: [Shelf],
      }),
      viewer: t.field({
        resolve: (_root, _args, context) => context.session,
        type: Viewer,
      }),
    }),
  });

  // --- Mutations -------------------------------------------------------------------------------------------------

  const FileInput = builder.inputType("ItemFileInput", {
    description:
      "A file of an item, relative to its directory: text, or base64 for bytes that are not UTF-8.",
    fields: (t) => ({
      contents: t.string({ required: true }),
      encoding: t.string({ defaultValue: "utf-8" }),
      path: t.string({ required: true }),
    }),
  });

  const SnapshotFileInput = builder.inputType("SnapshotFileInput", {
    fields: (t) => ({
      path: t.string({ required: true }),
      sha256: t.string({ required: true }),
      size: t.int({ required: true }),
    }),
  });

  builder.mutationType({
    fields: (t) => ({
      commitSnapshot: t.field({
        args: {
          files: t.arg({ required: true, type: [SnapshotFileInput] }),
          message: t.arg.string(),
          parent: t.arg.string({
            description:
              "The snapshot this one replaces; refused if the shelf has moved since.",
          }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Make these files the shelf's snapshot, after uploading each to `/raw/{shelf}/objects/{sha256}`: `shelfkit push`. The first snapshot creates the shelf (owner only).",
        resolve: async (_root, args, context) => {
          requireKey(context);
          const shelf = shelfArg(args.shelf);
          // Only the owner creates a shelf; anyone else's commit to a shelf that does not exist finds none.
          const target =
            context.session.kind === "owner"
              ? shelfStub(context.env, shelf)
              : await held(context, shelf);
          return committed(
            await target.commitSnapshot(context.session, {
              files: args.files.map((file) => ({
                path: file.path,
                sha256: file.sha256,
                size: file.size,
              })),
              message: args.message ?? undefined,
              origin: "push",
              parent: args.parent ?? undefined,
              shelf,
            })
          );
        },
        type: Commit,
      }),
      createKey: t.field({
        args: {
          name: t.arg.string({ required: true }),
          scopes: t.arg.stringList({
            description:
              "read, read:{shelf}/{profile}, publish:{shelf}/{profile}, publish:{shelf}/*, mcp:{shelf}/{item}.",
            required: true,
          }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Create a scoped key on a shelf. The owner only. The plaintext is in this answer and nowhere else.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const created = await target.createKey(context.session, {
            name: args.name,
            scopes: args.scopes,
          });
          if (!created.ok) {
            throw context.session.kind === "owner"
              ? badInput(created.errors.join("; "))
              : forbidden(created.errors.join("; "));
          }
          return { key: created.key, secret: created.secret };
        },
        type: KeySecret,
      }),
      createShareLink: t.field({
        args: {
          profile: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const created = await target.createShareLink(
            context.session,
            shelf,
            args.profile
          );
          if (created === null) {
            throw forbidden(
              "this key cannot share that profile, or there is no such profile"
            );
          }
          return created;
        },
        type: ShareLinkSecret,
      }),
      deleteItem: t.field({
        args: {
          id: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return committed(
            await target.deleteItem(context.session, shelf, args.id)
          );
        },
        type: Commit,
      }),
      deleteProfile: t.field({
        args: {
          id: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return committed(
            await target.deleteProfile(context.session, shelf, args.id)
          );
        },
        type: Commit,
      }),
      indexRepository: t.boolean({
        args: {
          ref: t.arg.string(),
          repository: t.arg.string({
            description: "owner/repo on GitHub.",
            required: true,
          }),
          root: t.arg.string({
            description:
              "The directory holding the shelf; the root by default.",
          }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Queue indexing a shelf from a GitHub repository through the REST API; the result arrives as a `snapshot` event.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          if (!(await target.mayUpload(context.session, shelf))) {
            throw forbidden("this key cannot write to this shelf");
          }
          await sendJob(context, {
            ref: args.ref ?? undefined,
            repository: args.repository,
            root: args.root ?? undefined,
            shelf,
            type: "index.forge",
          });
          return true;
        },
      }),
      pickImport: t.field({
        args: {
          job: t.arg.id({ required: true }),
          picks: t.arg({
            description: "`[{ candidate, id?, pin? }]`.",
            required: true,
            type: "JSON",
          }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const job = await target.pickImport(
            context.session,
            shelf,
            args.job,
            args.picks
          );
          if (job === null) {
            throw badInput(
              "the job is not ready, the picks name unknown candidates, or this key cannot import"
            );
          }
          await sendJob(context, { job: job.id, shelf, type: "import.apply" });
          return job;
        },
        type: ImportJob,
      }),
      putSecretName: t.boolean({
        args: {
          description: t.arg.string(),
          name: t.arg.string({ required: true }),
          origin: t.arg.string({
            description:
              "The one origin (https://host[:port]) the value may be sent to.",
            required: true,
          }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Create or change a secret name and bind it to the one origin its value may be sent to. The owner only.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          if (
            !(await target.putSecretName(
              context.session,
              shelf,
              args.name,
              args.origin,
              args.description ?? undefined
            ))
          ) {
            throw forbidden(
              "only the owner key manages secret names, which are UPPER_SNAKE_CASE and bound to an https origin"
            );
          }
          return true;
        },
      }),
      putSource: t.field({
        args: {
          shelf: t.arg.id({ required: true }),
          source: t.arg({
            description: "A shelf.json source entry.",
            required: true,
            type: "JSON",
          }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const parsed = v.safeParse(SourceInputSchema, args.source);
          if (!parsed.success) {
            throw badInput(
              parsed.issues.map((issue) => issue.message).join("; ")
            );
          }
          return committed(
            await target.putSource(context.session, shelf, parsed.output)
          );
        },
        type: Commit,
      }),
      recordUse: t.boolean({
        args: {
          item: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Record that the viewer used an item (copied it): its recents.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return await target.recordUse(context.session, args.shelf, args.item);
        },
      }),
      removeSecretName: t.boolean({
        args: {
          name: t.arg.string({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return await target.removeSecretName(
            context.session,
            args.shelf,
            args.name
          );
        },
      }),
      removeSource: t.field({
        args: {
          id: t.arg.string({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return committed(
            await target.removeSource(context.session, shelf, args.id)
          );
        },
        type: Commit,
      }),
      reportActivity: t.field({
        args: {
          input: t.arg({
            description: "`shelf.report`'s input.",
            required: true,
            type: "JSON",
          }),
        },
        description:
          "Record that a plan was applied to a repository: `shelf.report` over GraphQL.",
        resolve: async (_root, args, context) => {
          const parsed = v.safeParse(ReportInputSchema, args.input);
          if (!parsed.success) {
            throw badInput(
              parsed.issues.map((issue) => issue.message).join("; ")
            );
          }
          const { shelf, ...input } = parsed.output;
          const target = await held(context, shelf);
          const found = await target.report(context.session, shelf, input);
          if (!found.ok) {
            throw found.failure._tag === "Forbidden"
              ? forbidden(found.failure.message)
              : badInput(found.failure.message);
          }
          return found.value;
        },
        type: "JSON",
      }),
      revokeKey: t.boolean({
        args: {
          id: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Revoke a key. It fails on GraphQL, the registry, and /mcp from the next request. The owner only.",
        resolve: async (_root, args, context) => {
          if (context.session.kind !== "owner") {
            throw forbidden("only the owner key revokes keys");
          }
          const target = await held(context, shelfArg(args.shelf));
          return await target.revokeKey(context.session, args.id);
        },
      }),
      revokeShareLink: t.boolean({
        args: {
          id: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return await target.revokeShareLink(
            context.session,
            args.shelf,
            args.id
          );
        },
      }),
      saveProfile: t.field({
        args: {
          document: t.arg({ required: true, type: "JSON" }),
          message: t.arg.string(),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Create or replace a profile (profiles/<id>.json), validated by the engine with the whole shelf.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return committed(
            await target.saveProfile(
              context.session,
              shelf,
              args.document,
              args.message ?? undefined
            )
          );
        },
        type: Commit,
      }),
      setFavourite: t.boolean({
        args: {
          favourite: t.arg.boolean({ required: true }),
          item: t.arg.id({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return await target.setFavourite(
            context.session,
            args.shelf,
            args.item,
            args.favourite
          );
        },
      }),
      setVisibility: t.field({
        args: {
          public: t.arg.boolean({ required: true }),
          shelf: t.arg.id({ required: true }),
        },
        description:
          "Serve anonymous reads, or stop: shelf.json's `registry.public`. The owner only.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          return committed(
            await target.setVisibility(context.session, shelf, args.public)
          );
        },
        type: Commit,
      }),
      signIn: t.field({
        args: { key: t.arg.string({ required: true }) },
        description:
          "Hold a key in an HttpOnly cookie for the browser, so the SPA never reads it.",
        resolve: async (_root, args, context) => {
          const session = await sessionForKey(context.env, args.key);
          if (session.kind !== "owner" && session.kind !== "key") {
            throw new GraphQLError("the key is not valid", {
              extensions: { code: "UNAUTHENTICATED" },
            });
          }
          context.cookies.push(signInCookie(args.key));
          return session;
        },
        type: Viewer,
      }),
      signOut: t.boolean({
        resolve: (_root, _args, context) => {
          context.cookies.push(signOutCookie());
          return true;
        },
      }),
      startImport: t.field({
        args: {
          shelf: t.arg.id({ required: true }),
          source: t.arg({
            description:
              "`{ kind, repo?, url?, ref?, path?, sourceId?, profile? }`.",
            required: true,
            type: "JSON",
          }),
        },
        description:
          "Start an import: discovery runs on the job queue, and the job moves to `ready` with its candidates.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const job = await target.createImportJob(
            context.session,
            shelf,
            args.source
          );
          if (job === null) {
            throw badInput("not an import source, or this key cannot import");
          }
          await sendJob(context, {
            job: job.id,
            shelf,
            type: "import.discover",
          });
          return job;
        },
        type: ImportJob,
      }),
      updatePrompt: t.field({
        args: {
          asCommand: t.arg.boolean(),
          body: t.arg.string({ description: "The new prompt.md." }),
          description: t.arg.string(),
          id: t.arg.id({ required: true }),
          message: t.arg.string(),
          shelf: t.arg.id({ required: true }),
          tags: t.arg.stringList(),
          title: t.arg.string(),
          variables: t.arg({ type: "JSON" }),
        },
        description:
          "Edit a prompt in place. The edit is a new revision of the prompt and a new snapshot of the shelf.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const found = await target.getItem(context.session, shelf, args.id);
          if (!found.ok || found.value.item.kind !== "prompt") {
            throw badInput(`there is no prompt \`${args.id}\``);
          }
          const changes = Object.fromEntries(
            Object.entries({
              asCommand: args.asCommand,
              description: args.description,
              tags: args.tags,
              title: args.title,
              variables: args.variables,
            }).filter(([, value]) => value !== null && value !== undefined)
          );
          const parsed = v.safeParse(ItemSchema, {
            ...found.value.item,
            ...changes,
          });
          if (!parsed.success) {
            throw badInput(
              parsed.issues.map((issue) => issue.message).join("; ")
            );
          }
          const document = parsed.output;
          const files = found.value.files
            .filter((file) => file.path !== "item.json")
            .map((file) =>
              file.path === "prompt.md" &&
              args.body !== null &&
              args.body !== undefined
                ? {
                    contents: args.body,
                    encoding: "utf-8" as const,
                    path: file.path,
                  }
                : file
            );
          if (
            !files.some((file) => file.path === "prompt.md") &&
            args.body !== null &&
            args.body !== undefined
          ) {
            files.push({
              contents: args.body,
              encoding: "utf-8",
              path: "prompt.md",
            });
          }
          return committed(
            await target.writeItem(context.session, shelf, {
              document,
              files,
              message: args.message ?? `edit ${found.value.item.id}`,
            })
          );
        },
        type: Commit,
      }),
      writeItem: t.field({
        args: {
          document: t.arg({
            description: "The item.json.",
            required: true,
            type: "JSON",
          }),
          files: t.arg({
            description:
              "Every other file of the item; they replace the item's files.",
            required: true,
            type: [FileInput],
          }),
          message: t.arg.string(),
          shelf: t.arg.id({ required: true }),
        },
        description: "Create or replace an item.",
        resolve: async (_root, args, context) => {
          const shelf = shelfArg(args.shelf);
          const target = await held(context, shelf);
          const parsed = v.safeParse(ItemSchema, args.document);
          if (!parsed.success) {
            throw badInput(
              parsed.issues.map((issue) => issue.message).join("; ")
            );
          }
          return committed(
            await target.writeItem(context.session, shelf, {
              document: parsed.output,
              files: args.files.map((file) => ({
                contents: file.contents,
                encoding: encoding(file.encoding),
                path: file.path,
              })),
              message: args.message ?? undefined,
            })
          );
        },
        type: Commit,
      }),
    }),
  });

  // --- Subscriptions -----------------------------------------------------------------------------------------------

  const Event = builder.objectRef<ShelfEvent>("ShelfEvent").implement({
    description: "A change to a shelf, pushed from its Durable Object.",
    fields: (t) => ({
      at: t.field({ resolve: (event) => event.at, type: "DateTime" }),
      id: t.exposeString("id"),
      kind: t.field({ resolve: (event) => event.kind, type: ShelfEventKind }),
    }),
  });

  builder.subscriptionType({
    fields: (t) => ({
      shelfChanged: t.field({
        args: { shelf: t.arg.id({ required: true }) },
        description:
          "Every change to the shelf, over server-sent events (send `Accept: text/event-stream`).",
        resolve: (event: ShelfEvent) => event,
        subscribe: (_root, args, context) =>
          shelfEvents(context, shelfArg(args.shelf)),
        type: Event,
      }),
    }),
  });

  return builder.toSchema({ sortSchema: true });
}

const SourceInputSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist([
    "git",
    "apm-registry",
    "shelfkit",
    "catalog",
    "marketplace",
    "path",
  ]),
  path: v.optional(v.string()),
  profile: v.optional(v.string()),
  repo: v.optional(v.string()),
  tier: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  url: v.optional(v.string()),
});

/** `shelf.report`'s input, shelf included: the frozen capability's own schema. */
const ReportInputSchema = shelfReport.input;

/**
 * Read the shelf object's event stream as a sequence of events.
 *
 * @yields {ShelfEvent} Each event the shelf publishes, in order, until the stream ends.
 */
async function* shelfEvents(
  context: GraphQLContext,
  shelf: string
): AsyncGenerator<ShelfEvent> {
  const target = await held(context, shelf);
  const stream = await target.events(context.session, shelf);
  if (stream === null) {
    throw new GraphQLError(`there is no shelf \`${shelf}\` this key can read`, {
      extensions: { code: "NOT_FOUND" },
    });
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- events arrive one read at a time.
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf("\n\n");
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice("data: ".length))
          .join("\n");
        if (data !== "") {
          yield v.parse(ShelfEventSchema, JSON.parse(data));
        }
      }
    }
  } finally {
    await reader.cancel();
  }
}

const ShelfEventSchema = v.strictObject({
  at: v.string(),
  id: v.string(),
  kind: v.picklist([
    "snapshot",
    "item",
    "profile",
    "activity",
    "import",
    "keys",
    "settings",
    "package",
    "scan",
    "upstream",
  ]),
});
