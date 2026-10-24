<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { readVariables } from "../api/json.ts";
import {
  DeleteItemMutation,
  PromptQuery,
  RecordUseMutation,
  UpdatePromptMutation,
  WriteItemMutation,
} from "../api/operations.ts";
import { copyToClipboard } from "../composables/clipboard.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { useQuery } from "../composables/use-query.ts";
import { copyText, missingRequired, placeholders } from "../lib/prompt.ts";
import type { CopyFormat, PromptSource, PromptVariable } from "../lib/prompt.ts";
import DiffView from "./diff-view.vue";
import MarkdownView from "./markdown-view.ts";
import QueryState from "./query-state.vue";

const { shelf, id, changes } = defineProps<{ shelf: string; id: string; changes: number }>();
const emit = defineEmits<{ favourite: [id: string, favourite: boolean]; deleted: [] }>();

type PromptItem = NonNullable<NonNullable<ResultOf<typeof PromptQuery>["shelf"]>["item"]>;

const query = useQuery(async () => {
  const data = await execute(PromptQuery, { id, shelf });
  return data.shelf;
}, [() => changes]);
const item = computed<PromptItem | null>(() => query.data.value?.item ?? null);
const canWrite = computed(() => query.data.value?.viewerAccess.write === true);

const tab = ref<"use" | "edit" | "history">("use");

// Use: the variables form and the copy formats.

const values = reactive(new Map<string, string>());
const previewFormat = ref<CopyFormat>("text");
const previewRendered = ref(true);
const lastCopied = ref<string | null>(null);

const source = computed<PromptSource | null>(() => {
  const current = item.value;
  if (current === null) {
    return null;
  }
  return {
    body: current.body ?? "",
    description: current.description,
    id: current.id,
    title: current.title,
    variables: readVariables(current.variables),
  };
});

const variables = computed<readonly PromptVariable[]>(() => source.value?.variables ?? []);
const missing = computed(() => missingRequired(variables.value, values));
const output = computed(() =>
  source.value === null ? "" : copyText(source.value, previewFormat.value, values),
);

const FORMATS: readonly { format: CopyFormat; label: string; hint: string }[] = [
  { format: "text", hint: "The prompt with your values, as plain text", label: "Copy prompt" },
  {
    format: "skill",
    hint: "A SKILL.md with name and description frontmatter",
    label: "Copy as skill",
  },
  {
    format: "command",
    hint: "A slash command file; variables become $1, $2, …",
    label: "Copy as command",
  },
];

const COPIED: Readonly<Record<CopyFormat, string>> = {
  command: "Copied as a slash command.",
  skill: "Copied as SKILL.md.",
  text: "Prompt copied.",
};

async function copy(format: CopyFormat): Promise<void> {
  if (source.value === null) {
    return;
  }
  if (format !== "command" && missing.value.length > 0) {
    notify(`Fill in ${missing.value.join(", ")} first.`, null, "error");
    return;
  }
  const text = copyText(source.value, format, values);
  try {
    await copyToClipboard(text);
    lastCopied.value = format;
    previewFormat.value = format;
    notify(COPIED[format]);
    await execute(RecordUseMutation, { item: id, shelf });
  } catch (error) {
    notifyError(error);
  }
}

// Edit: the prompt's fields, its variables, and its body, saved as a new revision.

interface Draft {
  title: string;
  description: string;
  tags: string;
  asCommand: boolean;
  body: string;
  message: string;
  variables: { name: string; default: string; description: string; required: boolean }[];
}

const draft = reactive<Draft>({
  asCommand: false,
  body: "",
  description: "",
  message: "",
  tags: "",
  title: "",
  variables: [],
});
const saving = ref(false);
const saveError = ref<string | null>(null);

function resetDraft(): void {
  const current = item.value;
  if (current === null) {
    return;
  }
  draft.title = current.title;
  draft.description = current.description;
  draft.tags = current.tags.join(", ");
  draft.asCommand = current.asCommand === true;
  draft.body = current.body ?? "";
  draft.message = "";
  draft.variables = readVariables(current.variables).map((variable) => ({
    default: variable.default ?? "",
    description: variable.description ?? "",
    name: variable.name,
    required: variable.required === true,
  }));
}

watch(item, (current, previous) => {
  if (current !== null && (previous === null || tab.value !== "edit")) {
    resetDraft();
  }
});

const undeclared = computed(() => {
  const declared = new Set(draft.variables.map((variable) => variable.name));
  return placeholders(draft.body).filter((name) => !declared.has(name));
});

function declare(name: string): void {
  draft.variables.push({ default: "", description: "", name, required: false });
}

/** A variable as `item.json` stores it: optional fields left out when empty. */
interface PromptVariableDraft {
  name: string;
  default?: string;
  description?: string;
  required?: boolean;
}

function draftVariables(): PromptVariable[] {
  return draft.variables
    .filter((variable) => variable.name.trim() !== "")
    .map((variable) => {
      const out: PromptVariableDraft = { name: variable.name.trim() };
      if (variable.required) {
        out.required = true;
      } else if (variable.default !== "") {
        out.default = variable.default;
      }
      if (variable.description.trim() !== "") {
        out.description = variable.description.trim();
      }
      return out;
    });
}

const draftSource = computed<PromptSource>(() => ({
  body: draft.body,
  description: draft.description,
  id,
  title: draft.title,
  variables: draftVariables(),
}));

function problemText(result: {
  reason: string | null;
  errors: readonly { path: string; message: string }[];
}): string {
  const errors = result.errors.map((error) => `${error.path}: ${error.message}`);
  return errors.length > 0 ? errors.join("\n") : (result.reason ?? "the shelf refused the change");
}

async function save(): Promise<void> {
  saving.value = true;
  saveError.value = null;
  try {
    const resultData = await execute(UpdatePromptMutation, {
      asCommand: draft.asCommand,
      body: draft.body,
      description: draft.description,
      id,
      message: draft.message.trim() === "" ? null : draft.message.trim(),
      shelf,
      tags: draft.tags
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
      title: draft.title,
      variables: draftVariables(),
    });
    const result = resultData.updatePrompt;
    if (!result.ok) {
      saveError.value = problemText(result);
      return;
    }
    notify("Saved as a new revision.");
    tab.value = "use";
    await query.refresh();
    resetDraft();
  } catch (error) {
    saveError.value = messageOf(error);
  } finally {
    saving.value = false;
  }
}

/** Delete the prompt; Undo writes it back from what was loaded, as a new revision. */
async function remove(): Promise<void> {
  const current = item.value;
  if (current === null) {
    return;
  }
  const { document } = current;
  const files = current.files
    .filter((file) => file.path !== "item.json")
    .map((file) => ({ contents: file.contents, encoding: file.encoding, path: file.path }));
  try {
    const resultData = await execute(DeleteItemMutation, { id, shelf });
    const result = resultData.deleteItem;
    if (!result.ok) {
      notify(problemText(result), null, "error");
      return;
    }
    emit("deleted");
    notify(`Deleted “${current.title}”.`, async () => {
      const restoredData = await execute(WriteItemMutation, {
        document,
        files,
        message: "Undo delete",
        shelf,
      });
      const restored = restoredData.writeItem;
      if (!restored.ok) {
        throw new Error(problemText(restored));
      }
      emit("deleted");
    });
  } catch (error) {
    notifyError(error);
  }
}

// History: every revision of prompt.md, diffed against the one before it.

const revisions = computed(() => item.value?.revisions ?? []);
const selectedRevision = ref(0);

function fileAt(at: number, path: string): string {
  return revisions.value[at]?.files.find((file) => file.path === path)?.contents ?? "";
}

async function restore(at: number): Promise<void> {
  const revision = revisions.value[at];
  if (revision === undefined) {
    return;
  }
  const body = fileAt(at, "prompt.md");
  try {
    const resultData = await execute(UpdatePromptMutation, {
      body,
      id,
      message: `Restore ${revision.revision.slice(0, 19)}`,
      shelf,
    });
    const result = resultData.updatePrompt;
    if (!result.ok) {
      notify(problemText(result), null, "error");
      return;
    }
    // The same files are the same revision: restoring one makes it current again, rather than a copy of it.
    notify("Restored. The prompt is at that revision again.");
    selectedRevision.value = 0;
    await query.refresh();
    // The editor holds what was typed before the restore; saving it would undo the restore.
    resetDraft();
  } catch (error) {
    notifyError(error);
  }
}

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
</script>

<template>
  <section aria-label="Prompt" class="detail">
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="item === null"
      empty-text="No such prompt."
    />
    <template v-if="item !== null && source !== null">
      <header class="detail__header">
        <div class="stack">
          <div class="row">
            <h2 data-testid="prompt-title">{{ item.title }}</h2>
            <button
              class="quiet"
              type="button"
              :aria-pressed="item.favourite"
              :title='item.favourite ? "Remove from favourites (f)" : "Add to favourites (f)"'
              @click='emit("favourite", item.id, !item.favourite)'
            >
              {{ item.favourite ? "★" : "☆" }}
            </button>
            <span v-if="item.asCommand" class="badge">command</span>
            <span v-for="entry in item.tags" :key="entry" class="chip">#{{ entry }}</span>
          </div>
          <p class="muted">{{ item.description }}</p>
        </div>
        <div class="tabs" role="tablist">
          <button role="tab" type="button" :aria-selected='tab === "use"' @click='tab = "use"'>Use</button>
          <button
            v-if="canWrite"
            role="tab"
            type="button"
            :aria-selected='tab === "edit"'
            @click="tab = 'edit'; resetDraft()"
          >
            Edit
          </button>
          <button
            role="tab"
            type="button"
            :aria-selected='tab === "history"'
            @click='tab = "history"'
          >
            History ({{ revisions.length }})
          </button>
        </div>
      </header>
      <div v-if='tab === "use"' class="detail__panes">
        <div class="stack">
          <form
            v-if="variables.length > 0"
            aria-label="Variables"
            class="panel"
            @submit.prevent='copy("text")'
          >
            <h3>Variables</h3>
            <label v-for="variable in variables" :key="variable.name" class="field">
              <span>
                {{ variable.name }}
                <span v-if="variable.required" aria-label="required" class="severity-error">*</span>
                <span v-if="variable.description" class="muted"> — {{ variable.description }}</span>
              </span>
              <input
                :name="`var-${variable.name}`"
                :value='values.get(variable.name) ?? ""'
                :placeholder='variable.default ?? ""'
                :required="variable.required"
                :aria-invalid="missing.includes(variable.name)"
                @input="values.set(variable.name, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </form>
          <div class="panel">
            <h3>Copy</h3>
            <div class="stack">
              <button
                v-for="entry in FORMATS"
                :key="entry.format"
                type="button"
                :class='{ primary: entry.format === "text" }'
                :title="entry.hint"
                :disabled='entry.format !== "command" && missing.length > 0'
                :data-testid="`copy-${entry.format}`"
                @click="copy(entry.format)"
              >
                {{ entry.label }}
              </button>
            </div>
            <p v-if="missing.length > 0" class="small severity-error">Required: {{ missing.join(", ") }}</p>
            <p v-if="lastCopied !== null" class="small muted" role="status">Copied ({{ lastCopied }}).</p>
          </div>
        </div>
        <div class="panel preview">
          <div class="row">
            <h3>Preview</h3>
            <span class="spacer"></span>
            <select v-model="previewFormat" aria-label="Preview format">
              <option value="text">Prompt</option>
              <option value="skill">SKILL.md</option>
              <option value="command">Slash command</option>
            </select>
            <button class="small" type="button" @click="previewRendered = !previewRendered">
              {{ previewRendered ? "Source" : "Rendered" }}
            </button>
          </div>
          <MarkdownView v-if='previewRendered && previewFormat === "text"' :source="output" />
          <pre v-else data-testid="prompt-output">{{ output }}</pre>
        </div>
      </div>
      <form
        v-else-if='tab === "edit"'
        aria-label="Edit prompt"
        class="detail__panes"
        @submit.prevent="save"
      >
        <div class="stack">
          <label class="field">Title <input v-model="draft.title" name="title" required /></label>
          <label class="field">Description <input v-model="draft.description" name="description" /></label>
          <label class="field">Tags, comma-separated <input v-model="draft.tags" name="tags" /></label>
          <label class="row small"><input v-model="draft.asCommand" type="checkbox" /> Offer as a slash command</label>
          <div class="field">
            <label for="prompt-body">prompt.md — write a variable as <code v-pre>{{name}}</code></label>
            <textarea
              id="prompt-body"
              v-model="draft.body"
              class="mono"
              name="body"
              rows="14"
              spellcheck="false"
            />
          </div>
          <div v-if="undeclared.length > 0" class="row small">
            <span class="severity-warning">Used but not declared:</span>
            <button
              v-for="name in undeclared"
              :key="name"
              class="chip"
              type="button"
              @click="declare(name)"
            >
              + {{ name }}
            </button>
          </div>
          <fieldset>
            <legend>Variables</legend>
            <div v-for="(variable, at) in draft.variables" :key="at" class="row variable-row">
              <input v-model="variable.name" aria-label="Name" placeholder="name" />
              <input
                v-model="variable.default"
                aria-label="Default"
                placeholder="default"
                :disabled="variable.required"
              />
              <input
                v-model="variable.description"
                aria-label="Description"
                placeholder="what it is for"
              />
              <label class="row small"><input v-model="variable.required" type="checkbox" /> required</label>
              <button
                aria-label="Remove variable"
                class="quiet danger"
                type="button"
                @click="draft.variables.splice(at, 1)"
              >
                ✕
              </button>
            </div>
            <button class="small" type="button" @click='declare("")'>Add variable</button>
          </fieldset>
          <label class="field">Revision message <input v-model="draft.message" name="message" placeholder="optional" /></label>
          <p v-if="saveError !== null" class="error-text small" role="alert">{{ saveError }}</p>
          <div class="row">
            <button class="primary" type="submit" :disabled="saving">Save revision</button>
            <button type="button" @click='tab = "use"'>Cancel</button>
            <span class="spacer"></span>
            <button class="danger" type="button" @click="remove">Delete prompt</button>
          </div>
        </div>
        <div class="panel preview">
          <h3>Preview</h3>
          <MarkdownView :source='copyText(draftSource, "text", values)' />
        </div>
      </form>
      <div v-else class="detail__panes">
        <ol aria-label="Revisions" class="list panel">
          <li v-for="(revision, at) in revisions" :key="revision.revision">
            <button
              class="list-row quiet revision-row"
              type="button"
              :class="{ active: at === selectedRevision }"
              @click="selectedRevision = at"
            >
              <span class="mono small">{{ revision.revision.slice(7, 19) }}</span>
              <span class="small ellipsis">{{ revision.message ?? (at === revisions.length - 1 ? "created" : "edited") }}</span>
              <span class="spacer"></span>
              <span class="small muted">{{ when(revision.createdAt) }}</span>
              <span v-if="at === 0" class="badge">current</span>
            </button>
          </li>
        </ol>
        <div class="panel">
          <DiffView
            label="prompt.md"
            :before='fileAt(selectedRevision + 1, "prompt.md")'
            :after='fileAt(selectedRevision, "prompt.md")'
          />
          <DiffView
            label="item.json"
            :before='fileAt(selectedRevision + 1, "item.json")'
            :after='fileAt(selectedRevision, "item.json")'
          />
          <div v-if="canWrite && selectedRevision > 0" class="row">
            <button type="button" @click="restore(selectedRevision)">Restore this revision</button>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.detail {
  padding: var(--spacing-size-4) var(--spacing-size-6);
  display: grid;
  gap: var(--spacing-size-4);
  align-content: start;
  min-width: 0;
}

.detail__header {
  display: grid;
  gap: var(--spacing-size-3);
}

.detail__panes {
  display: grid;
  grid-template-columns: minmax(0, var(--layout-measure-pane)) minmax(0, 1fr);
  gap: var(--spacing-size-4);
  align-items: start;
}

.preview pre {
  white-space: pre-wrap;
}

.variable-row input {
  flex: 1;
  min-width: 0;
}

.revision-row {
  width: 100%;
  border: none;
  border-radius: 0;
}

input[aria-invalid="true"] {
  border-color: var(--signal-danger);
}
</style>
