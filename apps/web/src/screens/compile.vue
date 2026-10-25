<script setup lang="ts">
/**
 * Install a profile into a repository. The profile is in the shelf's registry (`shelfkit push` publishes it), so stock
 * APM installs it: the repository's apm.yml names the registry and the profile, and `apm install` puts each item
 * where each agent reads it. The ShelfKit CLI is the default way there, and APM alone the other; each as a prompt for an
 * agent or commands for a terminal. Everything here is computed from the profiles and the index already in memory.
 */
import * as v from "valibot";
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
import {
  apmAgentPrompt,
  apmTerminalSteps,
  cliAgentPrompt,
  cliTerminalSteps,
} from "../lib/install.ts";
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

/** The kinds that go into AGENTS.md. */
const RULE_KINDS: ReadonlySet<ItemKind> = new Set(["instructions", "stack", "library"]);
const hasRules = computed(() => groups.value.some((group) => RULE_KINDS.has(group.kind)));

const published = computed(() => (profile.value?.published ?? null) !== null);

/** BOUNDARY: a published profile's versions, as the Worker lists them, newest first. */
const VersionsSchema = v.array(v.object({ version: v.string() }));
const newestVersion = computed(() => {
  const parsed = v.safeParse(VersionsSchema, profile.value?.published?.versions);
  return parsed.success ? (parsed.output[0]?.version ?? null) : null;
});

const target = computed<InstallTarget | null>(() => {
  const current = profile.value;
  const summary = index.data.value;
  if (current === null || summary === null) {
    return null;
  }
  return {
    coordinate: current.apmCoordinate,
    instructions: hasRules.value,
    isPrivate: !summary.public,
    origin: new URL(summary.registryUrl).origin,
    profile: current.id,
    registryUrl: summary.registryUrl,
    targets: readProfile(current.document)?.compile.targets ?? [],
    title: current.title,
    version: newestVersion.value,
  };
});

/** Who runs the install: an agent given a prompt, or you in a terminal. */
type Way = "agent" | "terminal";
const WAYS: readonly { way: Way; label: string }[] = [
  { label: "Ask your agent", way: "agent" },
  { label: "Terminal", way: "terminal" },
];
/** What installs: the ShelfKit CLI (the default), or APM alone. */
type Tool = "cli" | "apm";

const cliWay = ref<Way>("agent");
/** APM alone is the other way, shown on request. */
const showApm = ref(false);
const apmWay = ref<Way>("agent");

function textFor(tool: Tool, way: Way): string {
  const current = target.value;
  if (current === null) {
    return "";
  }
  if (tool === "cli") {
    return way === "agent" ? cliAgentPrompt(current) : cliTerminalSteps(current);
  }
  return way === "agent" ? apmAgentPrompt(current) : apmTerminalSteps(current);
}

const cliText = computed(() => textFor("cli", cliWay.value));
const apmText = computed(() => textFor("apm", apmWay.value));

async function copy(text: string, way: Way): Promise<void> {
  try {
    await copyToClipboard(text);
    notify(
      way === "agent"
        ? "Prompt copied: paste it to your agent in the repository."
        : "Commands copied: paste them in the repository's folder.",
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
        installing, from this shelf's registry; the ShelfKit CLI, your agent, or you only tell it which profile to
        fetch.
      </p>
    </header>
    <QueryState
      :loading="profilesQuery.loading.value"
      :error="profilesQuery.error.value"
      :empty="profile === null"
      empty-text="This shelf has no such profile."
    />
    <template v-if="profile !== null && target !== null">
      <p v-if="!published" class="severity-warning small" role="alert">
        This profile is not in the shelf's registry yet, so nothing below can fetch it. <code>shelfkit push</code>
        publishes it.
      </p>
      <section class="stack" data-testid="install-cli">
        <h2>With the ShelfKit CLI</h2>
        <p class="small muted">
          One command adds the profile to the repository's apm.yml, keeping what is there, and runs APM. The CLI
          installs itself once per computer<template v-if="target.isPrivate">, and for this private shelf
            <code>shelfkit login</code> signs the CLI in through your browser and keeps its key in the OS keychain, so
            the key is never copied, in a file, or in front of an agent</template>.
        </p>
        <div class="tabs" role="tablist">
          <button
            v-for="entry in WAYS"
            :key="entry.way"
            role="tab"
            type="button"
            :aria-selected="cliWay === entry.way"
            :data-testid="`install-cli-${entry.way}`"
            @click="cliWay = entry.way"
          >
            {{ entry.label }}
          </button>
        </div>
        <div class="panel copy-block">
          <div class="row copy-block__bar">
            <span class="small muted">
              {{
                cliWay === "agent"
                  ? "Paste to Claude Code, Codex, or any agent working in the repository"
                  : "Run in the repository's folder"
              }}
            </span>
            <span class="spacer"></span>
            <button
              class="primary"
              data-testid="copy-install"
              type="button"
              @click="copy(cliText, cliWay)"
            >
              {{ cliWay === "agent" ? "Copy prompt" : "Copy" }}
            </button>
          </div>
          <pre class="copy-block__text" data-testid="install-text">{{ cliText }}</pre>
        </div>
      </section>
      <section class="stack" data-testid="install-apm">
        <div class="row">
          <h2>With APM alone</h2>
          <span class="small muted">no ShelfKit CLI</span>
          <span class="spacer"></span>
          <button
            class="quiet"
            type="button"
            :aria-expanded="showApm"
            data-testid="install-apm-toggle"
            @click="showApm = !showApm"
          >
            {{ showApm ? "Hide" : "Show" }}
          </button>
        </div>
        <template v-if="showApm">
          <p class="small muted">
            The repository's apm.yml names the shelf's registry and the profile, and APM, run through uv, installs it.
            <template v-if="target.isPrivate">
              For a private shelf, APM needs the registry in its user config and a key in the environment.
            </template>
          </p>
          <div class="tabs" role="tablist">
            <button
              v-for="entry in WAYS"
              :key="entry.way"
              role="tab"
              type="button"
              :aria-selected="apmWay === entry.way"
              :data-testid="`install-apm-${entry.way}`"
              @click="apmWay = entry.way"
            >
              {{ entry.label }}
            </button>
          </div>
          <div class="panel copy-block">
            <div class="row copy-block__bar">
              <span class="small muted">
                {{
                  apmWay === "agent"
                    ? "Paste to an agent working in the repository"
                    : "Run in the repository's folder, which has no apm.yml yet"
                }}
              </span>
              <span class="spacer"></span>
              <button
                class="primary"
                data-testid="copy-install-apm"
                type="button"
                @click="copy(apmText, apmWay)"
              >
                {{ apmWay === "agent" ? "Copy prompt" : "Copy" }}
              </button>
            </div>
            <pre class="copy-block__text" data-testid="install-text-apm">{{ apmText }}</pre>
          </div>
        </template>
      </section>
      <section class="stack">
        <h2>What lands in the repository</h2>
        <p class="small muted">
          {{ profile.resolution.items.length }} items. Commit what APM writes along with apm.yml and apm.lock.yaml, so
          everyone working in the repository gets the same.
        </p>
        <p v-if="hasRules" class="small">
          <strong>Instructions, tech stacks, and library notes</strong> install the same way: together, into one
          section of the repository's AGENTS.md, which every agent reads in every session. {{ RULES_NOTE }}
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
