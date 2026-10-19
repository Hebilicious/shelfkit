<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { execute } from "../api/graphql.ts";
import { PromptsQuery, SetFavouriteMutation } from "../api/operations.ts";
import PromptDetail from "../components/prompt-detail.vue";
import PromptNew from "../components/prompt-new.vue";
import QueryState from "../components/query-state.vue";
import { useListNav } from "../composables/list-nav.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { notifyError } from "../composables/toasts.ts";
import { useQuery } from "../composables/use-query.ts";
import { param } from "../router.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();

const typed = ref("");
const search = ref("");
const favouritesOnly = ref(false);
const tag = ref<string | null>(null);
const creating = ref(false);

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(typed, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    search.value = value.trim();
  }, 150);
});

const prompts = useQuery(async () => {
  const data = await execute(PromptsQuery, {
    favouritesOnly: favouritesOnly.value,
    query: search.value === "" ? null : search.value,
    shelf: shelf.value,
    tags: tag.value === null ? null : [tag.value],
  });
  return data.shelf;
}, [shelf, search, favouritesOnly, tag]);

/** When the list was last used, by item id: the list opens on what is actually used. */
const usedAt = computed(() => {
  const map = new Map<string, { at: string; uses: number }>();
  for (const recent of prompts.data.value?.recents ?? []) {
    if (recent.item.kind === "prompt") {
      map.set(recent.item.id, { at: recent.usedAt, uses: recent.uses });
    }
  }
  return map;
});

/**
 * Without a search: favourites first, then the most recently used, then the rest by title. With one, the service's
 * full-text ranking over bodies, titles, descriptions and tags is kept.
 */
const rows = computed(() => {
  const nodes = prompts.data.value?.prompts.nodes ?? [];
  if (search.value !== "") {
    return nodes;
  }
  return nodes.toSorted((a, b) => {
    if (a.item.favourite !== b.item.favourite) {
      return a.item.favourite ? -1 : 1;
    }
    const usedA = usedAt.value.get(a.item.id)?.at ?? "";
    const usedB = usedAt.value.get(b.item.id)?.at ?? "";
    if (usedA !== usedB) {
      return usedA > usedB ? -1 : 1;
    }
    return a.item.title.localeCompare(b.item.title);
  });
});

const tags = computed(() => {
  const all = new Set<string>();
  for (const node of prompts.data.value?.prompts.nodes ?? []) {
    for (const entry of node.item.tags) {
      all.add(entry);
    }
  }
  return [...all].toSorted();
});

const selectedId = computed(() => param(route.params.id));

function open(id: string): void {
  creating.value = false;
  void router.push({ name: "prompts", params: { id, shelf: shelf.value }, query: route.query });
}

async function toggleFavourite(id: string, favourite: boolean): Promise<void> {
  try {
    await execute(SetFavouriteMutation, { favourite, item: id, shelf: shelf.value });
    await prompts.refresh();
  } catch (error) {
    notifyError(error);
  }
}

const index = useListNav({
  favourite: (at) => {
    const row = rows.value[at];
    if (row !== undefined) {
      void toggleFavourite(row.item.id, !row.item.favourite);
    }
  },
  length: () => rows.value.length,
  open: (at) => {
    const row = rows.value[at];
    if (row !== undefined) {
      open(row.item.id);
    }
  },
});

// Keep the keyboard selection on the open prompt, and open the first prompt when none is chosen.
watch(
  [rows, selectedId],
  ([list, id]) => {
    if (id === "" && !creating.value) {
      const [first] = list;
      if (first !== undefined) {
        void router.replace({ name: "prompts", params: { id: first.item.id, shelf: shelf.value } });
      }
      return;
    }
    const at = list.findIndex((row) => row.item.id === id);
    if (at !== -1) {
      index.value = at;
    }
  },
  { immediate: true },
);

async function created(id: string): Promise<void> {
  creating.value = false;
  await prompts.refresh();
  open(id);
}
</script>

<template>
  <div class="prompts">
    <aside aria-label="Prompt library" class="prompts__list">
      <div class="stack prompts__controls">
        <div class="row">
          <h1>Prompts</h1>
          <span class="spacer" />
          <button class="small" type="button" @click="creating = true">New prompt</button>
        </div>
        <input
          v-model="typed"
          aria-label="Search prompts"
          data-search
          placeholder="Search prompt text…  ( / )"
          type="search"
        />
        <div class="row">
          <button
            class="chip"
            type="button"
            :aria-pressed="!favouritesOnly"
            @click="favouritesOnly = false"
          >All</button>
          <button
            class="chip"
            type="button"
            :aria-pressed="favouritesOnly"
            @click="favouritesOnly = true"
          >★ Favourites</button>
          <button
            v-for="entry in tags"
            :key="entry"
            class="chip"
            type="button"
            :aria-pressed="tag === entry"
            @click="tag = tag === entry ? null : entry"
          >
            #{{ entry }}
          </button>
        </div>
      </div>
      <QueryState
        :loading="prompts.loading.value"
        :error="prompts.error.value"
        :empty="rows.length === 0"
        :empty-text='search === "" ? "No prompts yet. Create one, or import some." : "No prompt matches."'
      />
      <ul class="list" data-testid="prompt-list">
        <li v-for="(row, at) in rows" :key="row.item.id">
          <RouterLink
            class="list-row prompt-row"
            data-list-row
            :aria-current='row.item.id === selectedId || at === index ? "true" : undefined'
            :to='{ name: "prompts", params: { shelf, id: row.item.id } }'
            @click="index = at"
          >
            <div class="prompt-row__text">
              <div class="row">
                <strong class="ellipsis">{{ row.item.title }}</strong>
                <span v-if="row.item.favourite" aria-label="favourite" class="small">★</span>
                <span v-if="usedAt.get(row.item.id)" class="small muted">{{ usedAt.get(row.item.id)?.uses }}×</span>
              </div>
              <div class="small muted ellipsis">{{ row.snippet ?? row.item.description }}</div>
            </div>
          </RouterLink>
        </li>
      </ul>
    </aside>
    <PromptNew v-if="creating" :shelf="shelf" @created="created" @cancel="creating = false" />
    <PromptDetail
      v-else-if='selectedId !== ""'
      :id="selectedId"
      :key="`${shelf}/${selectedId}`"
      :shelf="shelf"
      @favourite="toggleFavourite"
      @deleted="prompts.refresh()"
    />
  </div>
</template>

<style scoped>
.prompts {
  display: grid;
  grid-template-columns: var(--layout-measure-pane) 1fr;
  min-height: 0;
}

.prompts__list {
  border-inline-end: var(--hairline);
  overflow: auto;
  max-height: calc(100dvh - var(--spacing-size-16));
}

.prompts__controls {
  padding: var(--spacing-size-4);
}

.prompt-row__text {
  min-width: 0;
  display: grid;
}
</style>
