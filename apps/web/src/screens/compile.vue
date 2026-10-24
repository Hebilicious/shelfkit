<script setup lang="ts">
/**
 * Install a profile into a repository. The profile is in the shelf's registry (`shelfkit push` publishes it), so stock
 * APM installs it: the repository's apm.yml names the registry and the profile, and `apm install` puts each item
 * where each agent reads it. Three ways to get there: a prompt for an agent, commands for a terminal, or the ShelfKit
 * CLI from a clone of the shelf. Everything here is computed from the profiles and the index already in memory.
 */
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { readProfile } from "../api/json.ts";
import InstallPlaces from "../components/install-places.vue";
import QueryState from "../components/query-state.vue";
import { copyToClipboard } from "../composables/clipboard.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { useProfiles, useShelfIndex } from "../data/shelf.ts";
import type { IndexItem, ItemKind } from "../data/shelf.ts";
import { agentPrompt, cliSteps, terminalSteps } from "../lib/install.ts";
import type { InstallTarget } from "../lib/install.ts";
import { KIND_ORDER, KINDS, RULES_NOTE } from "../lib/vocabulary.ts";
import { param } from "../navigation.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();
const profileId = computed(() => param(route.params.profile));

const profilesQuery = useProfiles(shelf);
const index = useShelfIndex(shelf);

const profiles = computed(() => profilesQuery.data.value?.profiles ?? []);
const profile = computed(
  () => profiles.value.find((entry) => entry.id === profileId.value) ?? null,
);

// With no profile chosen, open the shelf's default (or first) one.
watch(
  profiles,
  (list) => {
    if (profileId.value === "" && list.length > 0) {
      const chosen =
        list.find((entry) => entry.id === profilesQuery.data.value?.defaultProfile) ?? list[0];
      if (chosen !== undefined) {
        void router.replace({
          name: "compile",
          params: { profile: chosen.id, shelf: shelf.value },
        });
      }
    }
  },
  { immediate: true },
);

function choose(event: Event): void {
  if (event.target instanceof HTMLSelectElement) {
    void router.push({
      name: "compile",
      params: { profile: event.target.value, shelf: shelf.value },
    });
  }
}

/** The profile's items, by kind in the sidebar's order. */
const groups = computed(() => {
  const byId = new Map((index.data.value?.items ?? []).map((item) => [item.id, item]));
  const items = (profile.value?.resolution.items ?? [])
    .map((entry) => byId.get(entry.id))
    .filter((item): item is IndexItem => item !== undefined);
  return KIND_ORDER.map((kind) => ({
    items: items.filter((item) => item.kind === kind),
    kind,
  })).filter((group) => group.items.length > 0);
});

const RULE_KINDS: ReadonlySet<ItemKind> = new Set(["instructions", "stack", "library"]);
const hasRules = computed(() => groups.value.some((group) => RULE_KINDS.has(group.kind)));

const published = computed(() => (profile.value?.published ?? null) !== null);

const target = computed<InstallTarget | null>(() => {
  const current = profile.value;
  const summary = index.data.value;
  if (current === null || summary === null) {
    return null;
  }
  return {
    coordinate: current.apmCoordinate,
    isPrivate: !summary.public,
    profile: current.id,
    registryUrl: summary.registryUrl,
    targets: readProfile(current.document)?.compile.targets ?? [],
    title: current.title,
  };
});

type Way = "agent" | "terminal" | "cli";
const way = ref<Way>("agent");
const WAYS: readonly { way: Way; label: string }[] = [
  { label: "Ask your agent", way: "agent" },
  { label: "Terminal", way: "terminal" },
  { label: "ShelfKit CLI", way: "cli" },
];

const text = computed(() => {
  const current = target.value;
  if (current === null) {
    return "";
  }
  switch (way.value) {
    case "agent": {
      return agentPrompt(current);
    }
    case "terminal": {
      return terminalSteps(current);
    }
    default: {
      return cliSteps(current);
    }
  }
});

async function copy(): Promise<void> {
  try {
    await copyToClipboard(text.value);
    notify(
      way.value === "agent"
        ? "Prompt copied: paste it to your agent in the repository."
        : "Commands copied.",
    );
  } catch (error) {
    notifyError(error);
  }
}
</script>

<template>
  <main class="page install">
    <header class="stack">
      <RouterLink class="small" :to='{ name: "profiles", params: { shelf } }'>← Profiles</RouterLink>
      <div class="row">
        <h1>Install {{ profile?.title ?? profileId }}</h1>
        <span class="spacer"></span>
        <label class="small muted" for="compile-profile">Profile</label>
        <select
          id="compile-profile"
          :value="profileId"
          data-testid="compile-profile"
          @change="choose"
        >
          <option v-for="entry in profiles" :key="entry.id" :value="entry.id">{{ entry.title }}</option>
        </select>
        <RouterLink
          v-if='profileId !== ""'
          class="button"
          :to='{ name: "compose", params: { shelf, profile: profileId } }'
        >
          Edit profile
        </RouterLink>
      </div>
      <p class="muted">
        Installing puts each item of this profile into a repository, in the files each agent reads. APM does the
        installing; you, your agent, or the ShelfKit CLI only tell it which profile to fetch.
      </p>
    </header>
    <QueryState
      :loading="profilesQuery.loading.value"
      :error="profilesQuery.error.value"
      :empty="profile === null"
      empty-text="This shelf has no such profile."
    />
    <template v-if="profile !== null && target !== null">
      <section class="stack">
        <div class="tabs" role="tablist">
          <button
            v-for="entry in WAYS"
            :key="entry.way"
            role="tab"
            type="button"
            :aria-selected="way === entry.way"
            :data-testid="`install-${entry.way}`"
            @click="way = entry.way"
          >
            {{ entry.label }}
          </button>
        </div>
        <p v-if='way === "agent"' class="small muted">
          Paste this to Claude Code, Codex, or any agent working in the repository. It edits apm.yml, runs APM, and
          tells you what it installed.
        </p>
        <p v-else-if='way === "terminal"' class="small muted">
          Run these in the repository's folder; uv runs the pinned APM, so nothing needs installing first. Already have
          an apm.yml? Add its <code>registries</code> entry and the dependency to yours instead of the
          <code>cat</code>.
        </p>
        <p v-else class="small muted">
          The CLI compiles from a clone of the shelf's own repository. It copies the items written on the shelf into
          <code>vendor/{{ profile.id }}/</code> in your repository instead of fetching them from the registry.
        </p>
        <p v-if='!published && way !== "cli"' class="severity-warning small" role="alert">
          This profile is not in the registry yet. <code>shelfkit push</code> publishes it; until then, use the ShelfKit
          CLI.
        </p>
        <div class="panel copy-block">
          <div class="row copy-block__bar">
            <span class="small muted">{{ way === "agent" ? "Prompt" : "Shell" }}</span>
            <span class="spacer"></span>
            <button class="primary" data-testid="copy-install" type="button" @click="copy">
              {{ way === "agent" ? "Copy prompt" : "Copy" }}
            </button>
          </div>
          <pre class="copy-block__text" data-testid="install-text">{{ text }}</pre>
        </div>
      </section>
      <section class="stack">
        <h2>What lands in the repository</h2>
        <p class="small muted">
          {{ profile.resolution.items.length }} items. Commit what APM writes along with apm.yml and apm.lock.yaml, so
          everyone working in the repository gets the same.
        </p>
        <p v-if="hasRules" class="small">
          <strong>Instructions, tech stacks, and library notes</strong> install the same way: each becomes a rule
          file of its own for each agent, loaded in every session. {{ RULES_NOTE }}
        </p>
        <details v-for="group in groups" :key="group.kind" class="panel">
          <summary>
            <strong>{{ KINDS[group.kind].plural }}</strong>
            <span class="muted small"> · {{ group.items.map((item) => item.title).join(", ") }}</span>
          </summary>
          <InstallPlaces
            :id='group.items.length === 1 ? (group.items[0]?.id ?? "<id>") : "<id>"'
            :kind="group.kind"
          />
        </details>
      </section>
    </template>
  </main>
</template>

<style scoped>
.install {
  max-width: var(--layout-measure-page);
}

.copy-block {
  padding: 0;
}

.copy-block__bar {
  padding: var(--spacing-size-2) var(--spacing-size-3);
  border-bottom: var(--hairline);
}

.copy-block__text {
  margin: 0;
  padding: var(--spacing-size-3);
  white-space: pre-wrap;
}
</style>
