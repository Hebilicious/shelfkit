<script setup lang="ts">
import { computed, ref } from "vue";

import type { InventoryItem } from "../api/types.ts";
import { ITEM_DRAG_TYPE } from "../api/types.ts";
import { useListNav } from "../composables/list-nav.ts";

const { items, inProfile } = defineProps<{
  items: readonly InventoryItem[];
  inProfile: ReadonlySet<string>;
}>();
const emit = defineEmits<{ add: [id: string] }>();

const search = ref("");
const kind = ref("");

const kinds = computed(() => [...new Set(items.map((item) => item.kind))].toSorted());

const shown = computed(() => {
  const words = search.value
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");
  return items.filter((item) => {
    if (kind.value !== "" && item.kind !== kind.value) {
      return false;
    }
    const text =
      `${item.id} ${item.title} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
});

function dragStart(event: DragEvent, id: string): void {
  event.dataTransfer?.setData(ITEM_DRAG_TYPE, id);
  event.dataTransfer?.setData("text/plain", id);
  if (event.dataTransfer !== null) {
    event.dataTransfer.effectAllowed = "copyMove";
  }
}

const index = useListNav({
  length: () => shown.value.length,
  open: (at) => {
    const item = shown.value[at];
    if (item !== undefined) {
      emit("add", item.id);
    }
  },
});
</script>

<template>
  <section aria-label="Inventory" class="panel inventory">
    <h2>Inventory</h2>
    <input
      v-model="search"
      aria-label="Filter the inventory"
      data-search
      placeholder="Filter items…  ( / )"
      type="search"
    />
    <select v-model="kind" aria-label="Kind">
      <option value="">Every kind</option>
      <option v-for="entry in kinds" :key="entry" :value="entry">{{ entry }}</option>
    </select>
    <p class="small muted">Drag an item into the profile, or press <kbd>+</kbd>. <kbd>j</kbd>/<kbd>k</kbd> then <kbd>Enter</kbd> adds.</p>
    <ul class="list" data-testid="compose-inventory">
      <li v-for="(item, at) in shown" :key="item.id">
        <div
          class="list-row inventory__row"
          data-list-row
          draggable="true"
          :aria-current='at === index ? "true" : undefined'
          :data-item="item.id"
          @dragstart="dragStart($event, item.id)"
        >
          <span class="badge">{{ item.kind }}</span>
          <span class="ellipsis" :title="item.description">{{ item.title }}</span>
          <span class="spacer" />
          <span v-if="inProfile.has(item.id)" aria-label="in the profile" class="small muted">✓</span>
          <button
            v-else
            class="small"
            type="button"
            :aria-label="`Add ${item.title}`"
            :data-testid="`add-${item.id}`"
            @click='emit("add", item.id)'
          >
            +
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.inventory {
  max-height: calc(100dvh - var(--spacing-size-16) * 2);
  overflow: auto;
}

.inventory__row {
  cursor: grab;
  padding-inline: var(--spacing-size-1);
}
</style>
