<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import { WriteItemMutation } from "../api/operations.ts";
import { notify } from "../composables/toasts.ts";
import { placeholders } from "../lib/prompt.ts";
import { slugify } from "../lib/profile.ts";
import MarkdownView from "./markdown-view.ts";

const { shelf } = defineProps<{ shelf: string }>();
const emit = defineEmits<{ created: [id: string]; cancel: [] }>();

const title = ref("");
const id = ref("");
const idTouched = ref(false);
const description = ref("");
const body = ref("");
const problem = ref<string | null>(null);
const busy = ref(false);

watch(title, (value) => {
  if (!idTouched.value) {
    id.value = slugify(value);
  }
});

/** Every `{{name}}` pasted in becomes a declared variable, so the form asks for it. */
const variables = computed(() => placeholders(body.value));

/** The item.json of a new prompt. */
interface NewPromptDocument {
  id: string;
  kind: "prompt";
  title: string;
  description?: string;
  variables?: { name: string }[];
}

async function create(): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    const document: NewPromptDocument = { id: id.value, kind: "prompt", title: title.value.trim() };
    if (description.value.trim() !== "") {
      document.description = description.value.trim();
    }
    if (variables.value.length > 0) {
      document.variables = variables.value.map((name) => ({ name }));
    }
    const resultData = await execute(WriteItemMutation, {
      document,
      files: [{ contents: body.value, path: "prompt.md" }],
      message: "Create prompt",
      shelf,
    });
    const result = resultData.writeItem;
    if (!result.ok) {
      problem.value =
        result.errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n") ||
        (result.reason ?? "refused");
      return;
    }
    notify(`Created “${title.value.trim()}”.`);
    emit("created", id.value);
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form aria-label="New prompt" class="new" @submit.prevent="create">
    <div class="stack">
      <h2>New prompt</h2>
      <p class="small muted">Paste it from a chat or a doc. Write a variable as <code v-pre>{{name}}</code>.</p>
      <label class="field">Title <input v-model="title" name="title" required /></label>
      <label class="field">
        Id
        <input
          v-model="id"
          class="mono"
          name="id"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          required
          @input="idTouched = true"
        />
      </label>
      <label class="field">Description <input v-model="description" name="description" /></label>
      <div class="field">
        <label for="new-prompt-body">prompt.md</label>
        <textarea
          id="new-prompt-body"
          v-model="body"
          class="mono"
          name="body"
          required
          rows="14"
          spellcheck="false"
        />
      </div>
      <p v-if="variables.length > 0" class="small muted">Variables: {{ variables.join(", ") }}</p>
      <p v-if="problem !== null" class="error-text small" role="alert">{{ problem }}</p>
      <div class="row">
        <button class="primary" type="submit" :disabled="busy">Create prompt</button>
        <button type="button" @click='emit("cancel")'>Cancel</button>
      </div>
    </div>
    <div class="panel">
      <h3>Preview</h3>
      <MarkdownView :source="body" />
    </div>
  </form>
</template>

<style scoped>
.new {
  padding: var(--spacing-size-4) var(--spacing-size-6);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--spacing-size-4);
  align-items: start;
}
</style>
