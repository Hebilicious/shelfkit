<script setup lang="ts">
import { watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { sessionError, shelves, viewer } from "../composables/session.ts";

const router = useRouter();

// One shelf is the common case (a key belongs to one): go straight to it.
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
    <h1>Shelves</h1>
    <p v-if="sessionError !== null" class="error-text">{{ sessionError }}</p>
    <template v-else-if="viewer !== null && !viewer.authenticated && shelves.length === 0">
      <p>Sign in with a key to open your shelf.</p>
      <p><RouterLink class="button primary" :to='{ name: "sign-in" }'>Sign in</RouterLink></p>
    </template>
    <p v-else-if="viewer !== null && shelves.length === 0" class="muted">
      This key reaches no shelf yet. Push one with <code>shelfkit push</code>, or import one.
    </p>
    <ul class="list panel">
      <li v-for="shelf in shelves" :key="shelf.id">
        <RouterLink class="list-row" :to='{ name: "shelf", params: { shelf: shelf.id } }'>
          <strong>{{ shelf.name }}</strong>
          <span class="mono small muted">{{ shelf.id }}</span>
          <span class="muted small ellipsis">{{ shelf.description }}</span>
          <span class="spacer" />
          <span class="small muted">{{ shelf.itemCount }} items · {{ shelf.profileCount }} profiles</span>
          <span v-if="shelf.public" class="badge">public</span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.home {
  max-width: calc(var(--shape-measure-prose) * 1.5);
  margin: 0 auto;
  width: 100%;
}
</style>
