<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

import { execute } from "../api/graphql.ts";
import { readItemSummaries, readPlanFilePaths, readProfile } from "../api/json.ts";
import { SharedProfileQuery } from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { copyToClipboard } from "../composables/clipboard.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { keyOf, useQuery } from "../data/cache.ts";
import { KINDS } from "../lib/vocabulary.ts";
import { param } from "../navigation.ts";

const route = useRoute();
const token = computed(() => param(route.params.token));

/** A share link needs no key: the page reads the profile anonymously, read-only. */
const query = useQuery(
  () => keyOf("share", token.value),
  async () => {
    const data = await execute(SharedProfileQuery, { token: token.value });
    return data.sharedProfile;
  },
);

const shared = computed(() => query.data.value ?? null);
const items = computed(() => readItemSummaries(shared.value?.items ?? null));
const document = computed(() => readProfile(shared.value?.document ?? null));
const files = computed(() => readPlanFilePaths(shared.value?.plan?.files ?? null));

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyToClipboard(text);
    notify(`${what} copied.`);
  } catch (error) {
    notifyError(error);
  }
}
</script>

<template>
  <main class="page share">
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="shared === null"
      empty-text="This share link does not exist, or it was revoked."
    />
    <template v-if="shared !== null">
      <header class="stack">
        <p class="small muted">
          A profile shared from the shelf <span class="mono">{{ shared.shelf }}</span>, read-only: a set of prompts,
          skills and conventions for coding agents, which APM installs into a repository.
        </p>
        <h1 data-testid="shared-title">{{ shared.title }}</h1>
        <p v-if="document?.description" class="muted">{{ document.description }}</p>
      </header>
      <ul v-if="shared.errors.length > 0" class="error-text small">
        <li v-for="error in shared.errors" :key="`${error.path} ${error.message}`">{{ error.path }}: {{ error.message }}</li>
      </ul>
      <section class="panel">
        <h2>What it installs ({{ items.length }} {{ items.length === 1 ? "item" : "items" }})</h2>
        <ul class="list">
          <li v-for="item in items" :key="item.id" class="list-row">
            <span class="badge">{{ KINDS[item.kind].label }}</span>
            <strong>{{ item.title }}</strong>
            <span class="small muted ellipsis">{{ item.description }}</span>
          </li>
        </ul>
      </section>
      <section v-if="shared.plan" class="panel">
        <div class="row">
          <h2>apm.yml</h2>
          <span class="spacer"></span>
          <button type="button" @click='copy(shared.plan.apmYml, "apm.yml")'>Copy</button>
        </div>
        <pre data-testid="shared-apm-yml">{{ shared.plan.apmYml }}</pre>
        <p class="small muted">The manifest a repository gets at its root. APM reads it to set up each agent.</p>
        <p v-if="files.length > 0" class="small muted">
          It also needs {{ files.length }} {{ files.length === 1 ? "file" : "files" }} copied into the repository under
          <code>vendor/</code>, which <code>shelfkit compile</code> writes; <code>apm.yml</code> alone does not include
          them.
        </p>
        <div class="row">
          <span class="small muted">Then install with</span>
          <code>{{ shared.plan.installCommand }}</code>
          <button type="button" @click='copy(shared.plan.installCommand, "Install command")'>Copy</button>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.share {
  max-width: var(--layout-measure-page);
  margin: 0 auto;
  width: 100%;
}
</style>
