/**
 * The shelf object's API: what its RPC methods take and return. GraphQL and the MCP endpoint (issue #6) both call
 * these methods, so the UI and an agent see the same shelf.
 *
 * The six MCP capabilities map one to one: `search`, `recommend`, `getProfile`, `getItem`, `planCompile`, and
 * `report` take the capability's input without `shelf` (the object is the shelf) and answer with its output, or with
 * one of its failures, exactly as `packages/schema/src/capabilities.ts` defines them. A session that may not read the
 * shelf gets `ShelfNotFound`, so a key cannot learn that another shelf exists.
 */
import type {
  CompileFailedSchema,
  ForbiddenSchema,
  ItemNotFoundSchema,
  ProfileNotFoundSchema,
  RevisionNotFoundSchema,
  shelfItemGet,
  ShelfNotFoundSchema,
  shelfProfileGet,
  shelfRecommend,
  shelfReport,
  shelfSearch,
} from "@shelfkit/schema";
import type * as v from "valibot";

/** An answer, or a failure in the AcidCat shape: an object whose `_tag` names it. */
export type Outcome<T, F> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: F };

export type ShelfNotFound = v.InferOutput<typeof ShelfNotFoundSchema>;
export type ProfileNotFound = v.InferOutput<typeof ProfileNotFoundSchema>;
export type ItemNotFound = v.InferOutput<typeof ItemNotFoundSchema>;
export type RevisionNotFound = v.InferOutput<typeof RevisionNotFoundSchema>;
export type CompileFailed = v.InferOutput<typeof CompileFailedSchema>;
export type Forbidden = v.InferOutput<typeof ForbiddenSchema>;

type InputOf<C extends { readonly input: v.GenericSchema }> = Omit<
  v.InferOutput<C["input"]>,
  "shelf"
>;
type OutputOf<C extends { readonly output: v.GenericSchema }> = v.InferOutput<
  C["output"]
>;

export type SearchInput = InputOf<typeof shelfSearch>;
export type SearchOutput = OutputOf<typeof shelfSearch>;
export type RecommendInput = InputOf<typeof shelfRecommend>;
export type RecommendOutput = OutputOf<typeof shelfRecommend>;
export type ProfileOutput = OutputOf<typeof shelfProfileGet>;
export type ItemOutput = OutputOf<typeof shelfItemGet>;
export type ReportInput = InputOf<typeof shelfReport>;
export type ReportOutput = OutputOf<typeof shelfReport>;
export type { CompilePlan } from "@shelfkit/schema";

/** A problem with a shelf the engine refused, in the file it came from. */
export interface ShelfProblem {
  readonly path: string;
  readonly message: string;
}

/** The inventory list behind the Shelf screen and `shelf.search`: text is optional here, and there is an offset. */
export interface InventoryInput {
  readonly query?: string;
  readonly kinds?: readonly string[];
  readonly tags?: readonly string[];
  /** 50 when absent, at most 200. */
  readonly limit?: number;
  readonly offset?: number;
}

export interface InventoryOutput {
  readonly items: SearchOutput["items"];
  readonly total: number;
}

/** One file of a snapshot: its path from the shelf root, and the R2 object holding its bytes. */
export interface SnapshotFile {
  readonly path: string;
  /** Lowercase hex. */
  readonly sha256: string;
  readonly size: number;
}

export interface SnapshotRecord {
  /** `sha256:<hex>` of the canonical manifest, which is itself the R2 object `objects/<hex>`. */
  readonly digest: string;
  readonly parent: string | null;
  readonly origin: "push" | "forge" | "edit" | "import" | "git";
  /** The commit in the shelf's repository that holds these files; null for a snapshot from before repositories. */
  readonly commit: string | null;
  readonly message: string | null;
  readonly keyId: string | null;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

/** What a write that changes the shelf's files answers: the new snapshot, or why the engine refused it. */
export type Committed =
  | {
      readonly ok: true;
      readonly snapshot: SnapshotRecord;
      /** The items and profiles whose revision changed, and those removed. */
      readonly changed: {
        readonly items: readonly string[];
        readonly profiles: readonly string[];
        readonly removed: readonly string[];
      };
    }
  | {
      readonly ok: false;
      /**
       * `invalid`: the engine refused the shelf. `missing`: objects to upload first. `conflict`: the shelf moved.
       * `unavailable`: the shelf's repository did not take the commit.
       */
      readonly reason:
        | "invalid"
        | "missing"
        | "conflict"
        | "forbidden"
        | "unavailable";
      readonly errors: readonly ShelfProblem[];
      readonly missing?: readonly string[];
    };

/** A shelf change, as subscriptions deliver it. */
export interface ShelfEvent {
  readonly kind:
    | "snapshot"
    | "item"
    | "profile"
    | "activity"
    | "import"
    | "keys"
    | "settings"
    | "package"
    | "scan"
    | "upstream";
  /** What changed: an item or profile id, an import job id, a package, or the snapshot digest. */
  readonly id: string;
  readonly at: string;
}

export interface KeyRecord {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export type { CompilePlan as Plan } from "@shelfkit/schema";

/** Where the MCP relay sends a call to a hosted item, with its credentials resolved. Never returned to a client. */
export interface RelayTarget {
  readonly item: string;
  readonly url: string;
  readonly transport: "http" | "sse" | "streamable-http";
  readonly tools: readonly string[];
  /** Literal headers, and each secret header's value, released only to `url`'s origin. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Why the relay may not call a hosted item. */
export type RelayRefused =
  | {
      readonly _tag: "NotRelayable";
      readonly item: string;
      readonly message: string;
    }
  | {
      readonly _tag: "SecretUnavailable";
      readonly secrets: readonly string[];
      readonly message: string;
    };
