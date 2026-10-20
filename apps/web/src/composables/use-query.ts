/**
 * A screen's data: a load that runs when its inputs change and again whenever the shelf changes (the SSE subscription
 * in `use-shelf-events.ts`), keeping the last answer on screen while the next one loads.
 */
import { onScopeDispose, ref, shallowRef, watch } from "vue";
import type { Ref, ShallowRef, WatchSource } from "vue";

import { messageOf } from "../api/graphql.ts";
import { shelfChanges } from "./use-shelf-events.ts";

export interface Query<T> {
  readonly data: ShallowRef<T | null>;
  readonly error: Ref<string | null>;
  readonly loading: Ref<boolean>;
  readonly refresh: () => Promise<void>;
}

export function useQuery<T>(
  load: () => Promise<T>,
  sources: readonly WatchSource[] = []
): Query<T> {
  const data = shallowRef<T | null>(null);
  const problem = ref<string | null>(null);
  const loading = ref(false);
  let latest = 0;
  let disposed = false;

  async function refresh(): Promise<void> {
    latest += 1;
    const run = latest;
    loading.value = true;
    try {
      const value = await load();
      if (run === latest && !disposed) {
        data.value = value;
        problem.value = null;
      }
    } catch (error) {
      if (run === latest && !disposed) {
        problem.value = messageOf(error);
      }
    } finally {
      if (run === latest && !disposed) {
        loading.value = false;
      }
    }
  }

  watch(
    [...sources, shelfChanges],
    async () => {
      await refresh();
    },
    { immediate: true }
  );
  onScopeDispose(() => {
    disposed = true;
  });
  return { data, error: problem, loading, refresh };
}
