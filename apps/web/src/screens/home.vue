<script setup lang="ts">
import { watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { sessionError, shelves, viewer } from "../composables/session.ts";

const router = useRouter();

// One shelf is the common case: go straight to it.
watch(
  shelves,
  (list) => {
    const only = list.length === 1 ? list[0] : undefined;
    if (only !== undefined) {
      void router.replace({ name: "shelf", params: { shelf: only.id } });
    }
  },
  { immediate: true },
);
</script>

<template>
  <main class="page home">
    <header class="stack">
      <h1>ShelfKit</h1>
      <p class="lead">
        One place for the prompts, skills, conventions and MCP servers your coding agents use, and a way to install
        the right set of them into any repository.
      </p>
      <p class="muted small">
        Items live on a shelf. A profile picks the items one kind of project needs. Installing a profile writes an
        <code>apm.yml</code> into the repository, and <code>apm install</code> sets up Claude, Codex, Copilot or Cursor
        with everything it lists.
      </p>
    </header>
    <h2 v-if="shelves.length > 0">Your shelves</h2>
    <p v-if="sessionError !== null" class="error-text">{{ sessionError }}</p>
    <template v-else-if="viewer !== null && !viewer.authenticated && shelves.length === 0">
      <p>Sign in to open your shelf, or open a shelf someone shared with you.</p>
      <p><RouterLink class="button primary" :to='{ name: "sign-in" }'>Sign in</RouterLink></p>
    </template>
    <p v-else-if="viewer !== null && shelves.length === 0 && viewer.owner" class="muted">
      There is no shelf yet. Push one with <code>shelfkit push</code>, or import one.
    </p>
    <p v-else-if="viewer?.principal && shelves.length === 0" class="muted" data-testid="no-access">
      {{ viewer.name }} has no access to a shelf here yet. The owner can invite you from a shelf's Settings.
    </p>
    <p v-else-if="viewer !== null && shelves.length === 0" class="muted">
      This key reaches no shelf yet. Push one with <code>shelfkit push</code>, or import one.
    </p>
    <ul class="list panel">
      <li v-for="shelf in shelves" :key="shelf.id">
        <RouterLink class="list-row" :to='{ name: "shelf", params: { shelf: shelf.id } }'>
          <strong>{{ shelf.name }}</strong>
          <span class="mono small muted">{{ shelf.id }}</span>
          <span class="muted small ellipsis">{{ shelf.description }}</span>
          <span class="spacer"></span>
          <span class="small muted">{{ shelf.itemCount }} items · {{ shelf.profileCount }} profiles</span>
          <span v-if="shelf.public" class="badge">public</span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.home {
  max-width: var(--layout-measure-wide);
  margin: 0 auto;
  width: 100%;
}

.lead {
  margin: 0;
  font-size: var(--typography_fluid-sans-text-l);
}
</style>
