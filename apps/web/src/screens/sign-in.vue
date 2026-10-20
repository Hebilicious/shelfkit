<script setup lang="ts">
import * as v from "valibot";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { messageOf } from "../api/graphql.ts";
import { signIn } from "../composables/session.ts";

const route = useRoute();
const router = useRouter();
const key = ref("");
const problem = ref<string | null>(null);
const LocalPathSchema = v.pipe(v.string(), v.startsWith("/"));
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    await signIn(key.value.trim());
    key.value = "";
    const { next } = route.query;
    await router.push(v.is(LocalPathSchema, next) ? next : "/");
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="page sign-in">
    <form class="panel" @submit.prevent="submit">
      <h1>Sign in</h1>
      <p class="muted small">
        Paste a key: the owner key, or a scoped key created in Settings. The browser keeps it in an HttpOnly cookie, so
        this page never holds it after you sign in.
      </p>
      <label class="field">
        Key
        <input
          v-model="key"
          autocomplete="off"
          data-search
          name="key"
          required
          spellcheck="false"
          type="password"
        />
      </label>
      <p v-if="problem !== null" class="error-text small" role="alert">{{ problem }}</p>
      <div class="row">
        <button class="primary" type="submit" :disabled='busy || key.trim() === ""'>Sign in</button>
      </div>
    </form>
  </main>
</template>

<style scoped>
.sign-in {
  max-width: var(--layout-measure-prose);
  margin: 0 auto;
  width: 100%;
}
</style>
