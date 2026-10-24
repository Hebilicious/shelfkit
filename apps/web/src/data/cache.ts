import * as v from "valibot";
/**
 * The SPA's one store of server data: every answer the screens read, kept by a key that names it completely.
 *
 * A screen asks for a key and gets what is cached under it straight away, so returning to a screen, or opening an
 * item the list already holds, renders in the same frame. When the cached answer is missing or stale, one load runs
 * in the background and replaces it; until something is cached the screen shows its own placeholder. Answers are
 * stale only when the shelf says so: the live subscription (`use-shelf-events.ts`) calls `invalidate` for the shelf
 * that changed, and every key that is on screen loads again while the rest wait for their next reader.
 *
 * Keys a screen marks `persist` are written to `localStorage` and read back on the next visit, so a reload paints the
 * last answer before the network answers. They are kept per viewer: `forgetEverything` runs on signing in or out.
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { ComputedRef, Ref, ShallowRef } from "vue";

import { messageOf } from "../api/graphql.ts";

/** What the cache holds: a GraphQL answer, or a value built from one. JSON-shaped, since some are stored. */
export type Answer = object | string | number | boolean | null;

const AnswerSchema = v.union([
  v.record(v.string(), v.unknown()),
  v.array(v.unknown()),
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
]);

/** What `localStorage` holds under `STORAGE_KEY`: answers by key, as `writeStored` wrote them. */
const StoredSchema = v.record(
  v.string(),
  v.object({ at: v.number(), data: AnswerSchema })
);

interface Entry {
  readonly data: ShallowRef<Answer | undefined>;
  readonly error: Ref<string | null>;
  readonly fetching: Ref<boolean>;
  /** When `data` was loaded, in `Date.now()` time; 0 when it never was. */
  loadedAt: number;
  stale: boolean;
  readers: number;
  persist: boolean;
  load: () => Promise<Answer>;
  inflight: Promise<void> | null;
}

const entries = new Map<string, Entry>();

/** Bumped when the viewer changes: a load that started before then answered for someone else, and is dropped. */
let generation = 0;

/** How many loads are running for keys with nothing cached yet: what the progress bar shows. */
export const blockingLoads = ref(0);

function entryFor(
  key: string,
  load: () => Promise<Answer>,
  persist: boolean
): Entry {
  const existing = entries.get(key);
  if (existing !== undefined) {
    existing.load = load;
    existing.persist ||= persist;
    return existing;
  }
  const stored = persist ? readStored(key) : undefined;
  const entry: Entry = {
    data: shallowRef(stored?.data),
    error: ref(null),
    fetching: ref(false),
    inflight: null,
    load,
    loadedAt: stored?.at ?? 0,
    persist,
    readers: 0,
    // An answer from an earlier visit paints at once and is checked again before it is trusted.
    stale: true,
  };
  entries.set(key, entry);
  return entry;
}

/** Load one entry now, sharing a load that is already running. */
async function fetchEntry(entry: Entry): Promise<void> {
  if (entry.inflight !== null) {
    await entry.inflight;
    return;
  }
  const blocking = entry.data.value === undefined;
  entry.fetching.value = true;
  entry.stale = false;
  if (blocking) {
    blockingLoads.value += 1;
  }
  const startedIn = generation;
  const running: Promise<void> = settle();
  entry.inflight = running;
  await running;

  async function settle(): Promise<void> {
    try {
      const value = await entry.load();
      if (startedIn !== generation) {
        return;
      }
      entry.data.value = value;
      entry.loadedAt = Date.now();
      entry.error.value = null;
      if (entry.persist) {
        schedulePersist();
      }
    } catch (error) {
      if (startedIn === generation) {
        entry.error.value = messageOf(error);
      }
    } finally {
      if (blocking) {
        blockingLoads.value -= 1;
      }
      // A newer load may have replaced this one (the viewer changed); that one clears its own state.
      if (entry.inflight === running) {
        entry.fetching.value = false;
        entry.inflight = null;
      }
    }
  }
}

export interface Query<T> {
  /** The cached answer, or `null` while there is none. */
  readonly data: ComputedRef<T | null>;
  readonly error: ComputedRef<string | null>;
  /** True only while nothing is cached and the first answer is loading. */
  readonly loading: ComputedRef<boolean>;
  /** True while any load runs, the background ones included. */
  readonly refreshing: ComputedRef<boolean>;
  readonly refresh: () => Promise<void>;
}

export interface QueryOptions {
  /** Keep the answer in `localStorage` across visits. */
  readonly persist?: boolean;
}

/**
 * The answer cached under `key`, loaded by `load` when it is missing or stale. `key` returns `null` while the screen
 * has nothing to ask yet. `load` must read only what `key` names, since two readers of a key share one answer.
 */
export function useQuery<T extends Answer>(
  key: () => string | null,
  load: () => Promise<T>,
  options: QueryOptions = {}
): Query<T> {
  const current = shallowRef<Entry | null>(null);

  function attach(next: string | null): void {
    if (current.value !== null) {
      current.value.readers -= 1;
    }
    if (next === null) {
      current.value = null;
      return;
    }
    const entry = entryFor(next, load, options.persist === true);
    entry.readers += 1;
    current.value = entry;
    if (entry.stale || entry.data.value === undefined) {
      void fetchEntry(entry);
    }
  }

  watch(key, attach, { immediate: true });
  onScopeDispose(() => {
    attach(null);
  });

  return {
    // SAFETY: an entry's data is only ever written by the `load` of its key, and every reader of a key loads the
    // same `T` (the key names the operation and its variables).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SAFETY note above is why the data is a `T`.
    data: computed(() => (current.value?.data.value ?? null) as T | null),
    error: computed(() => current.value?.error.value ?? null),
    loading: computed(
      () =>
        current.value !== null &&
        current.value.data.value === undefined &&
        current.value.error.value === null
    ),
    refresh: async () => {
      const entry = current.value;
      if (entry !== null) {
        entry.stale = true;
        await fetchEntry(entry);
      }
    },
    refreshing: computed(() => current.value?.fetching.value === true),
  };
}

/** Start loading `key` before any screen reads it: on hover, or once the shelf is open. */
export function prefetch(
  key: string,
  load: () => Promise<Answer>,
  options: QueryOptions = {}
): void {
  const entry = entryFor(key, load, options.persist === true);
  if (entry.data.value === undefined || entry.stale) {
    void fetchEntry(entry);
  }
}

/** The answer cached under `key`, if any, without loading it. */
export function peek(key: string): Answer | undefined {
  return entries.get(key)?.data.value;
}

/** Replace a cached answer in place, for an edit whose result is already known (a favourite, a rename). */
export function update<T extends Answer>(
  key: string,
  change: (value: T) => T
): void {
  const entry = entries.get(key);
  if (entry?.data.value !== undefined) {
    // SAFETY: as in `useQuery`, the caller names the key whose answer is a `T`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SAFETY note above is why the data is a `T`.
    entry.data.value = change(entry.data.value as T);
  }
}

/**
 * Mark every key starting with `prefix` stale. Keys on screen load again now, the others when next read; each keeps
 * showing its last answer meanwhile.
 */
export function invalidate(prefix: string): void {
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix)) {
      entry.stale = true;
      if (entry.readers > 0) {
        void fetchEntry(entry);
      }
    }
  }
}

/** Drop every answer, cached and stored: the viewer changed, so what they may read changed. */
export function forgetEverything(): void {
  generation += 1;
  for (const [key, entry] of entries) {
    if (entry.readers === 0) {
      entries.delete(key);
    } else {
      // On screen: blank it and load it again as the new viewer.
      entry.data.value = undefined;
      entry.error.value = null;
      entry.inflight = null;
      entry.stale = true;
      void fetchEntry(entry);
    }
  }
  storedSnapshot = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable (a private window): nothing was stored.
  }
}

/** A key with its inputs, so two screens asking the same thing share one answer. */
export function keyOf(
  ...parts: readonly (string | number | boolean | null | undefined)[]
): string {
  return parts.map((part) => String(part ?? "")).join("\u0000");
}

/** A key about one shelf; `shelfPrefix` is what every such key starts with. */
export function shelfKey(
  shelf: string,
  ...parts: readonly [
    string,
    ...(string | number | boolean | null | undefined)[],
  ]
): string {
  return keyOf("shelf", shelf, ...parts);
}

/** The start of every key about `shelf`, which `invalidate` takes when that shelf changes. */
export function shelfPrefix(shelf: string): string {
  return `${keyOf("shelf", shelf)}\u0000`;
}

// Persistence.

const STORAGE_KEY = "shelfkit:cache:v1";
/** An answer larger than this is not stored; it loads on the next visit instead. */
const STORED_ENTRY_LIMIT = 1_500_000;

interface Stored {
  readonly at: number;
  readonly data: Answer;
}

let storedSnapshot: Record<string, Stored> | null = null;

/** BOUNDARY: `localStorage` holds text this module wrote earlier, or anything an earlier version wrote; `StoredSchema` parses it. */
function readAllStored(): Record<string, Stored> {
  if (storedSnapshot !== null) {
    return storedSnapshot;
  }
  storedSnapshot = {};
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    const parsed = v.safeParse(
      StoredSchema,
      text === null ? {} : JSON.parse(text)
    );
    if (parsed.success) {
      storedSnapshot = { ...parsed.output };
    }
  } catch {
    // Unreadable or unavailable: start empty.
  }
  return storedSnapshot;
}

function readStored(key: string): Stored | undefined {
  return readAllStored()[key];
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeStored, 500);
}

function writeStored(): void {
  const out: Record<string, Stored> = {};
  for (const [key, entry] of entries) {
    const data = entry.data.value;
    if (
      entry.persist &&
      data !== undefined &&
      JSON.stringify(data).length <= STORED_ENTRY_LIMIT
    ) {
      out[key] = { at: entry.loadedAt, data };
    }
  }
  storedSnapshot = out;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Over quota or unavailable: the next visit loads from the network instead.
  }
}
