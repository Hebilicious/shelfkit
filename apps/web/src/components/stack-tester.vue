<script setup lang="ts">
import { ref } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { readRecommendedProfiles } from "../api/json.ts";
import { StackMatchQuery } from "../api/operations.ts";
import { KINDS } from "../lib/vocabulary.ts";

const { shelf, inProfile } = defineProps<{ shelf: string; inProfile: ReadonlySet<string> }>();
const emit = defineEmits<{ add: [id: string] }>();

type Match = NonNullable<ResultOf<typeof StackMatchQuery>["shelf"]>["stackMatch"];

const packageJson = ref('{\n  "dependencies": {\n    "vue": "^3.5.0"\n  }\n}\n');
const files = ref("");
const result = ref<Match | null>(null);
const problem = ref<string | null>(null);
const busy = ref(false);

async function test(): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    const data = await execute(StackMatchQuery, {
      files: files.value
        .split(/[\s,]+/u)
        .map((file) => file.trim())
        .filter((file) => file !== ""),
      packageJson: packageJson.value,
      shelf,
    });
    result.value = data.shelf?.stackMatch ?? null;
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section aria-label="Which tech stacks match a repository" class="panel tester">
    <h2>Which tech stacks match a repository</h2>
    <p class="small muted">
      Each tech stack on this shelf says how to recognise a repository that uses it. Paste a repository's
      <code>package.json</code> and the files at its root to see which stacks match, and what they suggest adding to
      the profile.
    </p>
    <div class="tester__grid">
      <form class="stack" @submit.prevent="test">
        <div class="field">
          <label for="tester-package-json">package.json</label>
          <textarea
            id="tester-package-json"
            v-model="packageJson"
            class="mono"
            rows="8"
            spellcheck="false"
          />
        </div>
        <label class="field">
          Other files at the root
          <input v-model="files" placeholder="wrangler.jsonc, Cargo.toml" />
        </label>
        <div class="row">
          <button type="submit" :disabled="busy">Find matching stacks</button>
        </div>
        <p v-if="problem !== null" class="error-text small">{{ problem }}</p>
      </form>
      <div v-if="result !== null" class="stack" data-testid="stack-match">
        <p v-if="result.stacks.length === 0" class="muted">No tech stack on this shelf matches.</p>
        <p v-else>
          Matching tech stacks:
          <strong v-for="stack in result.stacks" :key="stack" class="chip on">{{ stack }}</strong>
        </p>
        <ul class="list">
          <li v-for="entry in result.items" :key="entry.item.id" class="list-row">
            <span class="badge">{{ KINDS[entry.item.kind].label }}</span>
            <span>{{ entry.item.title }}</span>
            <span v-if="entry.recommendedBy.length > 0" class="small muted">suggested by {{ entry.recommendedBy.join(", ") }}</span>
            <span class="spacer"></span>
            <span v-if="inProfile.has(entry.item.id)" class="small muted">✓ in the profile</span>
            <button v-else class="small" type="button" @click='emit("add", entry.item.id)'>Add</button>
          </li>
        </ul>
        <p
          v-for="profile in readRecommendedProfiles(result.profiles)"
          :key="profile.id"
          class="small"
        >
          The profile <strong>{{ profile.title }}</strong> fits it ({{ profile.items.length }} items).
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tester__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--spacing-size-4);
  align-items: start;
}
</style>
