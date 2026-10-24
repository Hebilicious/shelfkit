/**
 * The shelf as the screens read it. Opening a shelf loads its index once (every item with its body and item.json, see
 * `ShelfIndexQuery`) and its profiles, and keeps both across visits; the lists, the search, the prompt library, and the
 * top of every item page are then computed from memory, so moving between them never waits on the network. What only
 * one page needs (an item's history, a profile's plan) is loaded when it opens, or earlier when a link to it is hovered.
 */
import type { Profile } from "@shelfkit/schema";
import type { Ref } from "vue";

import { execute } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { readPlan } from "../api/json.ts";
import {
  ActivityQuery,
  ItemQuery,
  PreviewProfileQuery,
  ProfilesQuery,
  ShelfIndexQuery,
} from "../api/operations.ts";
import { loadEngine } from "../engine/browser.ts";
import { addItems, emptyProfile } from "../lib/profile.ts";
import { peek, prefetch, shelfKey, update, useQuery } from "./cache.ts";
import type { Query } from "./cache.ts";

type IndexAnswer = NonNullable<ResultOf<typeof ShelfIndexQuery>["shelf"]>;

/** One item as the index holds it. */
export type IndexItem = IndexAnswer["items"]["nodes"][number]["item"];

export type ItemKind = IndexItem["kind"];

/** The shelf's summary and every item, as the index query answers it with every page joined. */
export interface ShelfIndex extends Omit<IndexAnswer, "items"> {
  readonly items: readonly IndexItem[];
}

export function indexKey(shelf: string): string {
  return shelfKey(shelf, "index");
}

/** The index, every page of it; `null` when the shelf does not exist or this viewer may not read it. */
async function loadIndex(shelf: string): Promise<ShelfIndex | null> {
  const first = await execute(ShelfIndexQuery, { offset: 0, shelf });
  if (first.shelf === null) {
    return null;
  }
  const { items, ...summary } = first.shelf;
  const all = items.nodes.map((node) => node.item);
  while (all.length < items.total) {
    // The pages are fetched in turn: each needs the length of the ones before it.
    // oxlint-disable-next-line no-await-in-loop -- see the line above.
    const next = await execute(ShelfIndexQuery, { offset: all.length, shelf });
    const nodes = next.shelf?.items.nodes ?? [];
    if (nodes.length === 0) {
      break;
    }
    all.push(...nodes.map((node) => node.item));
  }
  return { ...summary, items: all };
}

export function useShelfIndex(shelf: Ref<string>): Query<ShelfIndex | null> {
  return useQuery(
    () => (shelf.value === "" ? null : indexKey(shelf.value)),
    async () => await loadIndex(shelf.value),
    { persist: true }
  );
}

/** Change one item in the cached index, for an edit whose result is known before the service confirms it. */
export function patchIndexItem(
  shelf: string,
  id: string,
  change: (item: IndexItem) => IndexItem
): void {
  update<ShelfIndex | null>(indexKey(shelf), (index) =>
    index === null
      ? null
      : {
          ...index,
          items: index.items.map((item) =>
            item.id === id ? change(item) : item
          ),
        }
  );
}

// Profiles.

export type ProfileSummary = NonNullable<
  ResultOf<typeof ProfilesQuery>["shelf"]
>["profiles"][number];
export type ProfilesAnswer = NonNullable<
  ResultOf<typeof ProfilesQuery>["shelf"]
>;

export function profilesKey(shelf: string): string {
  return shelfKey(shelf, "profiles");
}

async function loadProfiles(shelf: string): Promise<ProfilesAnswer | null> {
  const data = await execute(ProfilesQuery, { shelf });
  return data.shelf;
}

export function useProfiles(shelf: Ref<string>): Query<ProfilesAnswer | null> {
  return useQuery(
    () => (shelf.value === "" ? null : profilesKey(shelf.value)),
    async () => await loadProfiles(shelf.value),
    { persist: true }
  );
}

// One item's full record: every file's text, its revisions, and its scans.

export type ItemDetail = NonNullable<
  NonNullable<ResultOf<typeof ItemQuery>["shelf"]>["item"]
>;

function itemKey(shelf: string, id: string): string {
  return shelfKey(shelf, "item", id);
}

async function loadItem(shelf: string, id: string): Promise<ItemDetail | null> {
  const data = await execute(ItemQuery, { id, shelf });
  return data.shelf?.item ?? null;
}

export function useItem(
  shelf: Ref<string>,
  id: Ref<string>
): Query<ItemDetail | null> {
  return useQuery(
    () =>
      shelf.value === "" || id.value === ""
        ? null
        : itemKey(shelf.value, id.value),
    async () => await loadItem(shelf.value, id.value)
  );
}

/** Start loading what an item's page shows beyond the index: a link to it is under the pointer, or has focus. */
export function prefetchItem(shelf: string, id: string): void {
  prefetch(itemKey(shelf, id), async () => await loadItem(shelf, id));
  const revision = indexed(shelf, id)?.revision;
  if (revision !== undefined) {
    prefetch(
      installKey(shelf, id, revision),
      async () => await loadInstall(shelf, id)
    );
  }
}

/** One item of the cached index, if the index is loaded. */
function indexed(shelf: string, id: string): IndexItem | undefined {
  // SAFETY: the index key only ever holds what `loadIndex` returns.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SAFETY note above is why this is a `ShelfIndex`.
  const index = peek(indexKey(shelf)) as ShelfIndex | null | undefined;
  return index?.items.find((item) => item.id === id);
}

/**
 * Load what every section of a shelf opens on, before any of them is visited, and compile the WebAssembly engine the
 * profile editor runs once the browser is idle.
 */
export function warmShelf(shelf: string): void {
  prefetch(indexKey(shelf), async () => await loadIndex(shelf), {
    persist: true,
  });
  prefetch(profilesKey(shelf), async () => await loadProfiles(shelf), {
    persist: true,
  });
  const idle =
    globalThis.requestIdleCallback ??
    ((run: () => void) => setTimeout(run, 1000));
  idle(() => {
    prefetch(activityKey(shelf, ""), async () => await loadActivity(shelf, ""));
    void warmEngine();
  });
}

async function warmEngine(): Promise<void> {
  try {
    await loadEngine();
  } catch {
    // The screen that needs the engine loads it again, and reports what went wrong.
  }
}

/** The tags of the items given, with how many carry each, most used first. */
export function tagCounts(
  items: readonly IndexItem[]
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ count, tag }))
    .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// What installing one item writes into a repository.

export interface ItemInstall {
  /** The `apm.yml` a profile holding only this item compiles to. */
  readonly apmYml: string;
  /** The files written beside it, without the generated package's own `apm.yml`. */
  readonly files: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
  readonly errors: readonly string[];
}

function installKey(shelf: string, id: string, revision: string): string {
  return shelfKey(shelf, "install", id, revision);
}

/** A profile holding only `id`, the preview Install would compile for it. */
function soloProfile(id: string): Profile {
  return addItems(emptyProfile("item-preview", "Item preview"), [id]);
}

async function loadInstall(
  shelf: string,
  id: string
): Promise<ItemInstall | null> {
  const data = await execute(PreviewProfileQuery, {
    document: soloProfile(id),
    shelf,
  });
  const preview = data.shelf?.previewProfile;
  if (preview === undefined) {
    return null;
  }
  const plan = readPlan(preview.plan?.json ?? null);
  return {
    apmYml: plan?.apmYml ?? "",
    errors: preview.errors.map((error) => error.message),
    files: (plan?.files ?? [])
      .filter((file) => !file.path.endsWith("/apm.yml"))
      .map((file) => ({
        contents:
          file.encoding === "base64" ? "(a binary file)" : file.contents,
        path: file.path.replace(/^vendor\/item-preview\//u, ""),
      })),
  };
}

/** What installing the item writes, at its current revision. */
export function useItemInstall(
  shelf: Ref<string>,
  item: Ref<{ readonly id: string; readonly revision: string } | null>
): Query<ItemInstall | null> {
  return useQuery(
    () =>
      item.value === null
        ? null
        : installKey(shelf.value, item.value.id, item.value.revision),
    async () => await loadInstall(shelf.value, item.value?.id ?? "")
  );
}

// Which repositories installed which profile.

export type ActivityAnswer = NonNullable<
  ResultOf<typeof ActivityQuery>["shelf"]
>;

function activityKey(shelf: string, profile: string): string {
  return shelfKey(shelf, "activity", profile);
}

async function loadActivity(
  shelf: string,
  profile: string
): Promise<ActivityAnswer | null> {
  const data = await execute(ActivityQuery, {
    profile: profile === "" ? null : profile,
    shelf,
  });
  return data.shelf;
}

/** The installs on record, every profile's when `profile` is empty. */
export function useActivity(
  shelf: Ref<string>,
  profile: Ref<string>
): Query<ActivityAnswer | null> {
  return useQuery(
    () => activityKey(shelf.value, profile.value),
    async () => await loadActivity(shelf.value, profile.value)
  );
}
