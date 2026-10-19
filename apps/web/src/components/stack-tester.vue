<script setup lang="ts">
import { ref } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { readRecommendedProfiles } from "../api/json.ts";
import { StackMatchQuery } from "../api/operations.ts";

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
  <section aria-label="Stack-marker tester" class="panel tester">
    <h2>Stack-marker tester</h2>
    <p class="small muted">Paste a repository's package.json to see which stacks match and what they recommend.</p>
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
          <button type="submit" :disabled="busy">Test markers</button>
        </div>
        <p v-if="problem !== null" class="error-text small">{{ problem }}</p>
      </form>
      <div v-if="result !== null" class="stack" data-testid="stack-match">
        <p v-if="result.stacks.length === 0" class="muted">No stack matches.</p>
        <p v-else>
          Matches:
          <strong v-for="stack in result.stacks" :key="stack" class="chip on">{{ stack }}</strong>
        </p>
        <ul class="list">
          <li v-for="entry in result.items" :key="entry.item.id" class="list-row">
            <span class="badge">{{ entry.item.kind }}</span>
            <span>{{ entry.item.title }}</span>
            <span v-if="entry.recommendedBy.length > 0" class="small muted">recommended by {{ entry.recommendedBy.join(", ") }}</span>
            <span class="spacer" />
            <span v-if="inProfile.has(entry.item.id)" class="small muted">✓ in the profile</span>
            <button v-else class="small" type="button" @click='emit("add", entry.item.id)'>Add</button>
          </li>
        </ul>
        <p
          v-for="profile in readRecommendedProfiles(result.profiles)"
          :key="profile.id"
          class="small"
        >
          Profile <strong>{{ profile.title }}</strong> fits ({{ profile.items.length }} items).
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
