<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import { followShelf, liveState } from "../composables/use-shelf-events.ts";
import { shelves, viewer, viewerName } from "../composables/session.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { useShelfIndex, warmShelf } from "../data/shelf.ts";
import { SECTIONS, sectionOf } from "../navigation.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();

const summary = useShelfIndex(shelf);
const NAV = SECTIONS.filter((section) => section.nav);

watch(
  shelf,
  (id) => {
    followShelf(id === "" ? null : id);
    if (id !== "") {
      warmShelf(id);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => followShelf(null));

function switchShelf(event: Event): void {
  if (event.target instanceof HTMLSelectElement) {
    void router.push({ name: "shelf", params: { shelf: event.target.value } });
  }
}

function active(name: string): boolean {
  return sectionOf(String(route.name ?? "")) === name;
}
</script>

<template>
  <div class="shelf-layout">
    <nav aria-label="Shelf sections" class="shelf-nav">
      <select v-if="shelves.length > 1" :value="shelf" aria-label="Shelf" @change="switchShelf">
        <option v-for="entry in shelves" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
      </select>
      <strong v-else class="shelf-nav__name">{{ summary.data.value?.name ?? shelf }}</strong>
      <RouterLink
        v-for="section in NAV"
        :key="section.name"
        class="shelf-nav__link"
        :class='{ "shelf-nav__link--active": active(section.name) }'
        :to="{ name: section.name, params: { shelf } }"
        :title="`g then ${section.key}`"
      >
        {{ section.title }}
      </RouterLink>
      <span class="spacer"></span>
      <span
        class="small muted"
        :title='liveState === "live"
          ? "Changes made elsewhere appear here as they happen"
          : "Reconnecting to receive changes made elsewhere"'
        data-testid="live"
      >
        {{ liveState === "live" ? "● live" : liveState === "connecting" ? "○ connecting" : "" }}
      </span>
    </nav>
    <main
      v-if="summary.data.value === null && !summary.loading.value && !summary.refreshing.value"
      class="page"
    >
      <h1>No shelf <code>{{ shelf }}</code></h1>
      <p v-if="summary.error.value !== null" class="error-text">{{ summary.error.value }}</p>
      <p v-else-if="viewer?.authenticated !== true">
        It may be private.
        <RouterLink :to='{ name: "sign-in", query: { next: route.fullPath } }'>Sign in</RouterLink> to read it.
      </p>
      <p v-else class="muted">You cannot read it as {{ viewer ? viewerName(viewer) : "this account" }}, or the deployment does not hold it.</p>
    </main>
    <RouterView v-else />
  </div>
</template>

<style scoped>
.shelf-layout {
  display: grid;
  grid-template-rows: auto 1fr;
  min-height: 0;
}

.shelf-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-size-1);
  padding: var(--spacing-size-1) var(--spacing-size-6);
  border-bottom: var(--hairline);
}

.shelf-nav__name {
  margin-inline-end: var(--spacing-size-3);
}

.shelf-nav__link {
  padding: var(--spacing-size-1) var(--spacing-size-2);
  border-radius: var(--layout-radius-s);
  color: var(--text-muted);
  text-decoration: none;
  font-size: var(--typography_fluid-sans-text-s);
  font-weight: var(--typography-weight-sans-medium);
}

.shelf-nav__link:hover, .shelf-nav__link--active {
  color: var(--text-primary);
  background: var(--surface-sunken);
}
</style>
