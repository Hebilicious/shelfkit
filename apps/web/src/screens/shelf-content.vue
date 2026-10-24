<script setup lang="ts">
/**
 * What the shelf holds: a sidebar of its kinds, grouped by what they do for the agent, beside everything, one kind,
 * the prompts, or one item. Every kind is listed, the empty ones too, so the sidebar also says what a shelf can hold.
 */
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";

import { useShelfId } from "../composables/shelf-context.ts";
import { useShelfIndex } from "../data/shelf.ts";
import type { ItemKind } from "../data/shelf.ts";
import { param } from "../navigation.ts";
import { KIND_GROUPS, KIND_GUIDES, KINDS, kindOfSlug } from "../lib/vocabulary.ts";

const shelf = useShelfId();
const route = useRoute();
const index = useShelfIndex(shelf);

const counts = computed(() => {
  const out = new Map<ItemKind, number>();
  for (const item of index.data.value?.items ?? []) {
    out.set(item.kind, (out.get(item.kind) ?? 0) + 1);
  }
  return out;
});

const total = computed(() => index.data.value?.items.length ?? 0);

/** The kind the page shows: the one named by the address, the open item's, or the prompts'. */
const activeKind = computed<ItemKind | "all">(() => {
  switch (route.name) {
    case "kind": {
      return kindOfSlug(param(route.params.kind)) ?? "all";
    }
    case "prompts": {
      return "prompt";
    }
    case "item": {
      const id = param(route.params.id);
      return index.data.value?.items.find((item) => item.id === id)?.kind ?? "all";
    }
    default: {
      return "all";
    }
  }
});

function kindRoute(kind: ItemKind): { name: string; params: Record<string, string> } {
  return kind === "prompt"
    ? { name: "prompts", params: { shelf: shelf.value } }
    : { name: "kind", params: { kind: KIND_GUIDES[kind].slug, shelf: shelf.value } };
}
</script>

<template>
  <div class="shelf-content">
    <nav aria-label="What the shelf holds" class="sidebar">
      <RouterLink
        class="sidebar__link"
        :class='{ "sidebar__link--active": activeKind === "all" }'
        :to='{ name: "shelf", params: { shelf } }'
      >
        <span>Everything</span>
        <span class="muted">{{ total }}</span>
      </RouterLink>
      <section v-for="group in KIND_GROUPS" :key="group.title" class="sidebar__group">
        <h2 class="sidebar__title">{{ group.title }}</h2>
        <RouterLink
          v-for="kind in group.kinds"
          :key="kind"
          class="sidebar__link"
          :class='{
            "sidebar__link--active": activeKind === kind,
            "sidebar__link--empty": (counts.get(kind) ?? 0) === 0,
          }'
          :title="KINDS[kind].about"
          :to="kindRoute(kind)"
        >
          <span>{{ KINDS[kind].plural }}</span>
          <span class="muted">{{ counts.get(kind) ?? 0 }}</span>
        </RouterLink>
      </section>
    </nav>
    <RouterView />
  </div>
</template>

<style scoped>
.shelf-content {
  display: grid;
  grid-template-columns: var(--layout-measure-rail) minmax(0, 1fr);
  min-height: 0;
}

.sidebar {
  display: grid;
  align-content: start;
  gap: var(--spacing-size-1);
  padding: var(--spacing-size-4) var(--spacing-size-3);
  border-inline-end: var(--hairline);
  position: sticky;
  inset-block-start: 0;
  max-height: calc(100dvh - var(--layout-offset-header));
  overflow: auto;
}

.sidebar__group {
  display: grid;
  gap: var(--spacing-size-1);
  margin-block-start: var(--spacing-size-3);
}

.sidebar__title {
  padding-inline: var(--spacing-size-2);
  color: var(--text-muted);
  font-size: var(--typography_fluid-sans-text-xs);
  font-weight: var(--typography-weight-sans-medium);
  text-transform: uppercase;
}

.sidebar__link {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing-size-2);
  padding: var(--spacing-size-1) var(--spacing-size-2);
  border-radius: var(--layout-radius-s);
  color: var(--text-primary);
  text-decoration: none;
  font-size: var(--typography_fluid-sans-text-s);
}

.sidebar__link:hover, .sidebar__link--active {
  background: var(--surface-sunken);
}

.sidebar__link--active {
  font-weight: var(--typography-weight-sans-medium);
}

.sidebar__link--empty {
  color: var(--text-muted);
}
</style>
