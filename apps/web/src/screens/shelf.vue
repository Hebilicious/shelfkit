<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { execute } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { InventoryQuery, ProfilesQuery, ShelfSummaryQuery } from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { useListNav } from "../composables/list-nav.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { useQuery } from "../composables/use-query.ts";

type ItemKind = NonNullable<
  ResultOf<typeof InventoryQuery>["shelf"]
>["items"]["nodes"][number]["item"]["kind"];

const KINDS: readonly ItemKind[] = [
  "prompt",
  "skill",
  "instructions",
  "agent",
  "stack",
  "library",
  "mcp",
  "lsp",
  "hook",
  "plugin",
];

const shelf = useShelfId();
const router = useRouter();

const typed = ref("");
const search = ref("");
const kinds = ref<ItemKind[]>([]);
const tags = ref<string[]>([]);
const selected = ref<string[]>([]);
const target = ref("");

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(typed, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    search.value = value.trim();
  }, 150);
});

const summary = useQuery(async () => {
  const data = await execute(ShelfSummaryQuery, { shelf: shelf.value });
  return data.shelf;
}, [shelf]);

const inventory = useQuery(async () => {
  const data = await execute(InventoryQuery, {
    kinds: kinds.value.length === 0 ? null : kinds.value,
    limit: 500,
    query: search.value === "" ? null : search.value,
    shelf: shelf.value,
    tags: tags.value.length === 0 ? null : tags.value,
  });
  return data.shelf?.items ?? null;
}, [shelf, search, kinds, tags]);

const profiles = useQuery(async () => {
  const data = await execute(ProfilesQuery, { shelf: shelf.value });
  return data.shelf?.profiles ?? [];
}, [shelf]);

const rows = computed(() => inventory.data.value?.nodes ?? []);

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

/** Open the composer on a profile (or a new one) with the selection added. */
function addToProfile(): void {
  void router.push({
    name: "compose",
    params: { profile: target.value, shelf: shelf.value },
    query: { add: selected.value.join(",") },
  });
}

const index = useListNav({
  length: () => rows.value.length,
  open: (at) => {
    const row = rows.value[at];
    if (row !== undefined) {
      void router.push({ name: "item", params: { id: row.item.id, shelf: shelf.value } });
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
    <header class="row">
      <div class="stack">
        <h1>{{ summary.data.value?.name ?? shelf }}</h1>
        <p class="muted small">{{ summary.data.value?.description }}</p>
      </div>
      <span class="spacer" />
      <span class="small muted">
        {{ summary.data.value?.itemCount ?? 0 }} items · {{ summary.data.value?.profileCount ?? 0 }} profiles
      </span>
    </header>
    <div class="stack">
      <input
        v-model="typed"
        aria-label="Search the shelf"
        data-search
        placeholder="Search titles, descriptions, tags and content…  ( / )"
        type="search"
      />
      <div aria-label="Kinds" class="row" role="group">
        <button
          v-for="kind in KINDS"
          :key="kind"
          class="chip"
          type="button"
          :aria-pressed="kinds.includes(kind)"
          @click="kinds = toggleIn(kinds, kind)"
        >
          {{ kind }}
        </button>
      </div>
      <div
        v-if="(summary.data.value?.tags.length ?? 0) > 0"
        aria-label="Tags"
        class="row"
        role="group"
      >
        <button
          v-for="entry in summary.data.value?.tags ?? []"
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
    <div aria-live="polite" class="row panel bulk">
      <label class="row small">
        <input
          type="checkbox"
          :checked="allSelected"
          aria-label="Select every item shown"
          @change="selectAll"
        />
        {{ selected.length }} selected
      </label>
      <span class="spacer" />
      <template v-if="selected.length > 0">
        <label class="small" for="bulk-target">into</label>
        <select id="bulk-target" v-model="target">
          <option value="">a new profile</option>
          <option v-for="profile in profiles.data.value ?? []" :key="profile.id" :value="profile.id">
            {{ profile.title }}
          </option>
        </select>
        <button class="primary" data-testid="add-to-profile" type="button" @click="addToProfile">Add to profile</button>
        <button class="quiet" type="button" @click="selected = []">Clear</button>
      </template>
      <span v-else class="small muted"><kbd>x</kbd> selects the highlighted item</span>
    </div>
    <QueryState
      :loading="inventory.loading.value"
      :error="inventory.error.value"
      :empty="rows.length === 0"
      empty-text="No items match."
    />
    <ul class="list panel inventory" data-testid="inventory">
      <li v-for="(row, at) in rows" :key="row.item.id">
        <div class="list-row" data-list-row :aria-current='at === index ? "true" : undefined'>
          <input
            type="checkbox"
            :checked="selected.includes(row.item.id)"
            :aria-label="`Select ${row.item.title}`"
            @change="toggleSelected(row.item.id)"
          />
          <span class="badge kind">{{ row.item.kind }}</span>
          <RouterLink
            class="inventory__title ellipsis"
            :to='row.item.kind === "prompt"
              ? { name: "prompts", params: { shelf, id: row.item.id } }
              : { name: "item", params: { shelf, id: row.item.id } }'
            @click="index = at"
          >
            {{ row.item.title }}
          </RouterLink>
          <span class="mono small muted">{{ row.item.id }}</span>
          <span class="small muted ellipsis inventory__about">{{ row.snippet ?? row.item.description }}</span>
          <span class="spacer" />
          <span v-for="entry in row.item.tags" :key="entry" class="chip">#{{ entry }}</span>
          <span
            v-if='row.item.scanStatus !== "unscanned"'
            class="badge"
            :class="SCAN_TONE[row.item.scanStatus]"
          >
            {{ row.item.scanStatus }}
          </span>
          <span class="small muted" :title='row.item.coordinate.message ?? ""'>{{ row.item.coordinate.kind }}</span>
        </div>
      </li>
    </ul>
    <p class="small muted">{{ inventory.data.value?.total ?? 0 }} shown</p>
  </main>
</template>

<style scoped>
.bulk {
  display: flex;
  padding: var(--spacing-size-2) var(--spacing-size-3);
}

.inventory {
  padding: 0;
}

.inventory__title {
  color: var(--text-primary);
  font-weight: var(--typography-weight-sans-medium);
  text-decoration: none;
}

.inventory__about {
  max-width: var(--shape-measure-prose);
}

.kind {
  min-width: var(--spacing-size-16);
  text-align: center;
}
</style>
