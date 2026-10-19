/**
 * The list `j` and `k` move through. A screen registers its main list; the keyboard handler in `app.vue` moves its
 * selection and opens, selects, or favourites the selected entry.
 */
import { onBeforeUnmount, ref, shallowRef } from "vue";
import type { Ref } from "vue";

import { moveIndex } from "../lib/keys.ts";

export interface ListHandlers {
  readonly length: () => number;
  readonly open?: (index: number) => void;
  readonly select?: (index: number) => void;
  readonly favourite?: (index: number) => void;
}

interface ActiveList extends ListHandlers {
  readonly index: Ref<number>;
}

const active = shallowRef<ActiveList | null>(null);

/** Register a screen's main list for the keyboard; the returned index is its selection. */
export function useListNav(handlers: ListHandlers): Ref<number> {
  const index = ref(-1);
  const list: ActiveList = { ...handlers, index };
  active.value = list;
  onBeforeUnmount(() => {
    if (active.value === list) {
      active.value = null;
    }
  });
  return index;
}

export function moveSelection(by: 1 | -1): void {
  const list = active.value;
  if (list === null) {
    return;
  }
  list.index.value = moveIndex(list.index.value, by, list.length());
  requestAnimationFrame(() => {
    document
      .querySelector('[data-list-row][aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  });
}

export function openSelection(): void {
  const list = active.value;
  if (list !== null && list.index.value >= 0) {
    list.open?.(list.index.value);
  }
}

export function selectSelection(): void {
  const list = active.value;
  if (list !== null && list.index.value >= 0) {
    list.select?.(list.index.value);
  }
}

export function favouriteSelection(): void {
  const list = active.value;
  if (list !== null && list.index.value >= 0) {
    list.favourite?.(list.index.value);
  }
}
