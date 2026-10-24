<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import KindGuide from "../components/kind-guide.vue";
import QueryState from "../components/query-state.vue";
import { useListNav } from "../composables/list-nav.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { prefetchItem, tagCounts, useProfiles, useShelfIndex } from "../data/shelf.ts";
import type { IndexItem, ItemKind } from "../data/shelf.ts";
import { search } from "../lib/search.ts";
import { KIND_GUIDES, KIND_ORDER, KINDS, kindOfSlug, scanLabel } from "../lib/vocabulary.ts";
import { param } from "../navigation.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();

/** The kind this page shows, from its address; `null` on Everything. */
const kind = computed<ItemKind | null>(() => kindOfSlug(param(route.params.kind)));

const typed = ref("");
const tags = ref<string[]>([]);
const selected = ref<string[]>([]);
const target = ref("");

const index = useShelfIndex(shelf);
const profiles = useProfiles(shelf);

/** The items of this page's kind, grouped by kind in the sidebar's order on Everything. */
const items = computed<readonly IndexItem[]>(() => {
  const all = index.data.value?.items ?? [];
  const current = kind.value;
  if (current !== null) {
    return all.filter((item) => item.kind === current);
  }
  return KIND_ORDER.flatMap((entry) => all.filter((item) => item.kind === entry));
});

const shelfTotal = computed(() => index.data.value?.items.length ?? 0);
const allTags = computed(() => tagCounts(items.value));

// A tag picked on one kind's page means nothing on another's.
watch(kind, () => {
  tags.value = [];
  selected.value = [];
});

/** Filtering and search both run on the items in memory, so the list follows every keystroke. */
const rows = computed(() => {
  const filtered = items.value.filter((item) => tags.value.every((tag) => item.tags.includes(tag)));
  return search(filtered, typed.value);
});

/** On Everything without a search, a heading starts each kind's run of rows. */
function startsGroup(at: number): boolean {
  if (kind.value !== null || typed.value.trim() !== "") {
    return false;
  }
  return at === 0 || rows.value[at - 1]?.item.kind !== rows.value[at]?.item.kind;
}

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
    <KindGuide v-if="kind !== null" :kind="kind" :shelf="shelf" />
    <template v-else>
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
    </template>
    <div class="stack">
      <input
        v-model="typed"
        aria-label="Search the shelf"
        data-search
        :placeholder='kind === null
          ? "Search the shelf…  ( / )"
          : `Search ${KINDS[kind].plural.toLowerCase()}…  ( / )`'
        type="search"
      />
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
      :empty-text='items.length > 0
        ? "Nothing matches."
        : kind !== null
          ? `This shelf has no ${KINDS[kind].plural.toLowerCase()} yet. Import some, or add them to the shelf repository and push it.`
          : "This shelf is empty. Import items, or push a shelf with shelfkit push."'
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
          }}<template v-if="kind !== null && shelfTotal !== items.length"> of {{ shelfTotal }} on the shelf</template></span>
        <span class="spacer"></span>
        <span><kbd>x</kbd> selects the highlighted item</span>
      </li>
      <template v-for="(row, at) in rows" :key="row.item.id">
        <li v-if="startsGroup(at)" class="inventory__group">
          <RouterLink
            :to='row.item.kind === "prompt"
              ? { name: "prompts", params: { shelf } }
              : { name: "kind", params: { shelf, kind: KIND_GUIDES[row.item.kind].slug } }'
          >
            {{ KINDS[row.item.kind].plural }}
          </RouterLink>
          <span class="small muted">{{ KINDS[row.item.kind].about }}</span>
        </li>
        <li>
          <div class="list-row" data-list-row :aria-current='at === cursor ? "true" : undefined'>
            <input
              type="checkbox"
              :checked="selected.includes(row.item.id)"
              :aria-label="`Select ${row.item.title}`"
              @change="toggleSelected(row.item.id)"
            />
            <span
              v-if='kind === null && typed.trim() !== ""'
              class="badge kind"
              :title="KINDS[row.item.kind].about"
            >{{ KINDS[row.item.kind].label }}</span>
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
      </template>
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

.inventory__group {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-size-2);
  padding: var(--spacing-size-3) var(--spacing-size-3) var(--spacing-size-1);
  border-bottom: var(--hairline);
}

.inventory__group a {
  color: var(--text-primary);
  font-weight: var(--typography-weight-sans-bold);
  text-decoration: none;
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
