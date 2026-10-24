<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import QueryState from "../components/query-state.vue";
import { useListNav } from "../composables/list-nav.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { prefetchItem, tagCounts, useProfiles, useShelfIndex } from "../data/shelf.ts";
import type { IndexItem, ItemKind } from "../data/shelf.ts";
import { search } from "../lib/search.ts";
import { KIND_ORDER, KINDS, scanLabel } from "../lib/vocabulary.ts";

const shelf = useShelfId();
const router = useRouter();

const typed = ref("");
const kinds = ref<ItemKind[]>([]);
const tags = ref<string[]>([]);
const selected = ref<string[]>([]);
const target = ref("");

const index = useShelfIndex(shelf);
const profiles = useProfiles(shelf);

const items = computed<readonly IndexItem[]>(() => index.data.value?.items ?? []);

/** The kinds this shelf holds, in the filter order, with how many of each. */
const kindCounts = computed(() =>
  KIND_ORDER.map((kind) => ({
    count: items.value.filter((item) => item.kind === kind).length,
    kind,
  })).filter((entry) => entry.count > 0),
);

const allTags = computed(() => tagCounts(items.value));

/** Filtering and search both run on the items in memory, so the list follows every keystroke. */
const rows = computed(() => {
  const filtered = items.value.filter(
    (item) =>
      (kinds.value.length === 0 || kinds.value.includes(item.kind)) &&
      tags.value.every((tag) => item.tags.includes(tag)),
  );
  return search(filtered, typed.value);
});

function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function toggleSelected(id: string): void {
  selected.value = toggleIn(selected.value, id);
}

const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selected.value.includes(row.item.id)),
);

function selectAll(): void {
  selected.value = allSelected.value ? [] : rows.value.map((row) => row.item.id);
}

/** Open the profile editor on a profile (or a new one) with the selection added. */
function addToProfile(): void {
  void router.push({
    name: "compose",
    params: { profile: target.value, shelf: shelf.value },
    query: { add: selected.value.join(",") },
  });
}

function itemRoute(item: IndexItem): { name: string; params: Record<string, string> } {
  return item.kind === "prompt"
    ? { name: "prompts", params: { id: item.id, shelf: shelf.value } }
    : { name: "item", params: { id: item.id, shelf: shelf.value } };
}

const cursor = useListNav({
  length: () => rows.value.length,
  open: (at) => {
    const row = rows.value[at];
    if (row !== undefined) {
      void router.push(itemRoute(row.item));
    }
  },
  select: (at) => {
    const row = rows.value[at];
    if (row !== undefined) {
      toggleSelected(row.item.id);
    }
  },
});

const SCAN_TONE = { clean: "info", disputed: "warn", flagged: "danger", unscanned: "" } as const;
</script>

<template>
  <main class="page">
    <header class="stack">
      <h1>{{ index.data.value?.name ?? shelf }}</h1>
      <p v-if="index.data.value?.description" class="muted">{{ index.data.value.description }}</p>
    </header>
    <ol aria-label="How a shelf works" class="steps panel">
      <li>
        <strong>Collect</strong>
        <span class="small muted">
          Prompts, skills, instructions and MCP servers your coding agents should have, kept here.
        </span>
      </li>
      <li>
        <strong>Pick</strong>
        <span class="small muted">
          A <RouterLink :to='{ name: "profiles", params: { shelf } }'>profile</RouterLink> is the set one kind of
          project gets.
        </span>
      </li>
      <li>
        <strong>Install</strong>
        <span class="small muted">
          ShelfKit writes the profile into a repository's <code>apm.yml</code>, and <code>apm install</code> sets
          up Claude, Codex, Copilot or Cursor with it.
        </span>
      </li>
    </ol>
    <div class="stack">
      <input
        v-model="typed"
        aria-label="Search the shelf"
        data-search
        placeholder="Search titles, descriptions, tags and text…  ( / )"
        type="search"
      />
      <div v-if="kindCounts.length > 1" aria-label="Kinds" class="row" role="group">
        <button
          v-for="entry in kindCounts"
          :key="entry.kind"
          class="chip"
          type="button"
          :aria-pressed="kinds.includes(entry.kind)"
          :title="KINDS[entry.kind].about"
          @click="kinds = toggleIn(kinds, entry.kind)"
        >
          {{ KINDS[entry.kind].plural }} <span class="muted">{{ entry.count }}</span>
        </button>
      </div>
      <div v-if="allTags.length > 0" aria-label="Tags" class="row" role="group">
        <button
          v-for="entry in allTags"
          :key="entry.tag"
          class="chip"
          type="button"
          :aria-pressed="tags.includes(entry.tag)"
          @click="tags = toggleIn(tags, entry.tag)"
        >
          #{{ entry.tag }} <span class="muted">{{ entry.count }}</span>
        </button>
      </div>
    </div>
    <div v-if="selected.length > 0" aria-live="polite" class="row panel bulk">
      <span class="small">{{ selected.length }} selected</span>
      <span class="spacer"></span>
      <label class="small" for="bulk-target">Add to</label>
      <select id="bulk-target" v-model="target">
        <option value="">a new profile</option>
        <option
          v-for="profile in profiles.data.value?.profiles ?? []"
          :key="profile.id"
          :value="profile.id"
        >
          {{ profile.title }}
        </option>
      </select>
      <button class="primary" data-testid="add-to-profile" type="button" @click="addToProfile">Add to profile</button>
      <button class="quiet" type="button" @click="selected = []">Clear</button>
    </div>
    <QueryState
      :loading="index.loading.value"
      :error="index.error.value"
      :empty="rows.length === 0"
      :empty-text='items.length === 0
        ? "This shelf is empty. Import items, or push a shelf with shelfkit push."
        : "Nothing matches."'
    />
    <ul v-if="rows.length > 0" class="list panel inventory" data-testid="inventory">
      <li class="inventory__head row small muted">
        <input
          type="checkbox"
          :checked="allSelected"
          aria-label="Select every item shown"
          @change="selectAll"
        />
        <span>{{
            rows.length === items.length
              ? `${items.length} items`
              : `${rows.length} of ${items.length} items`
          }}</span>
        <span class="spacer"></span>
        <span><kbd>x</kbd> selects the highlighted item</span>
      </li>
      <li v-for="(row, at) in rows" :key="row.item.id">
        <div class="list-row" data-list-row :aria-current='at === cursor ? "true" : undefined'>
          <input
            type="checkbox"
            :checked="selected.includes(row.item.id)"
            :aria-label="`Select ${row.item.title}`"
            @change="toggleSelected(row.item.id)"
          />
          <span class="badge kind" :title="KINDS[row.item.kind].about">{{ KINDS[row.item.kind].label }}</span>
          <div class="inventory__text">
            <RouterLink
              class="inventory__title ellipsis"
              :to="itemRoute(row.item)"
              @click="cursor = at"
              @focus="prefetchItem(shelf, row.item.id)"
              @pointerenter="prefetchItem(shelf, row.item.id)"
            >
              {{ row.item.title }}
            </RouterLink>
            <span class="small muted ellipsis">{{ row.snippet ?? row.item.description }}</span>
          </div>
          <span class="spacer"></span>
          <span v-for="entry in row.item.tags" :key="entry" class="chip">#{{ entry }}</span>
          <span
            v-if="scanLabel(row.item.scanStatus) !== null"
            class="badge"
            :class="SCAN_TONE[row.item.scanStatus]"
          >
            {{ scanLabel(row.item.scanStatus) }}
          </span>
        </div>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--layout-measure-rail), 1fr));
  gap: var(--spacing-size-4);
  margin: 0;
  padding: var(--spacing-size-3) var(--spacing-size-4);
  list-style: none;
  counter-reset: step;
}

.steps li {
  display: grid;
  gap: var(--spacing-size-1);
  counter-increment: step;
}

.steps strong:before {
  content: counter(step) ". ";
  color: var(--text-muted);
}

.bulk {
  display: flex;
  padding: var(--spacing-size-2) var(--spacing-size-3);
}

.inventory {
  padding: 0;
}

.inventory__head {
  padding: var(--spacing-size-2) var(--spacing-size-3);
  border-bottom: var(--hairline);
}

.inventory__text {
  display: grid;
  min-width: 0;
}

.inventory__title {
  color: var(--text-primary);
  font-weight: var(--typography-weight-sans-medium);
  text-decoration: none;
}

.kind {
  min-width: var(--spacing-size-16);
  text-align: center;
}
</style>
