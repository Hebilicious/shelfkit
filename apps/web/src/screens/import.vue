<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import { pretty, readCandidates, readSources } from "../api/json.ts";
import type { ImportCandidate } from "../api/json.ts";
import {
  ImportJobsQuery,
  IndexRepositoryMutation,
  PickImportMutation,
  StartImportMutation,
} from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { invalidate, shelfKey, shelfPrefix, useQuery } from "../data/cache.ts";
import { importStatusLabel, KINDS, SOURCE_KINDS, sourceKindLabel } from "../lib/vocabulary.ts";

const shelf = useShelfId();

const query = useQuery(
  () => shelfKey(shelf.value, "imports"),
  async () => {
    const data = await execute(ImportJobsQuery, { shelf: shelf.value });
    return data.shelf;
  },
);

const jobs = computed(() => query.data.value?.importJobs ?? []);
const sources = computed(() => readSources(query.data.value?.sources ?? null));

// Starting an import: paste where it comes from, or pick a configured source.

/** What an import can read from here; a local folder is only reachable from `shelf.json`'s sources. */
const IMPORT_KINDS = SOURCE_KINDS.filter((entry) => entry.kind !== "path");

const form = reactive({
  kind: "git",
  path: "",
  profile: "",
  ref: "",
  repo: "",
  sourceId: "",
  url: "",
});
const starting = ref(false);
const startError = ref<string | null>(null);

interface ImportSourceInput {
  kind: string;
  path?: string;
  profile?: string;
  ref?: string;
  repo?: string;
  sourceId?: string;
  url?: string;
}

function sourceInput(): ImportSourceInput {
  const configured = sources.value.find((entry) => entry.id === form.sourceId);
  const input: ImportSourceInput = { kind: configured?.kind ?? form.kind };
  if (configured !== undefined) {
    input.sourceId = configured.id;
  }
  const fromSource = {
    path: configured?.path,
    profile: configured?.profile,
    ref: undefined,
    repo: configured?.repo,
    url: configured?.url,
  };
  for (const field of ["repo", "url", "ref", "path", "profile"] as const) {
    const value = form[field].trim() || (fromSource[field] ?? "");
    if (value !== "") {
      input[field] = value;
    }
  }
  return input;
}

async function start(): Promise<void> {
  starting.value = true;
  startError.value = null;
  try {
    await execute(StartImportMutation, { shelf: shelf.value, source: sourceInput() });
    notify("Looking for items. They appear below for you to choose from when the search finishes.");
    invalidate(shelfPrefix(shelf.value));
  } catch (error) {
    startError.value = messageOf(error);
  } finally {
    starting.value = false;
  }
}

// Picking: choose candidates, rename them, pin them to another ref or version.

interface PickDraft {
  chosen: boolean;
  id: string;
  ref: string;
  version: string;
}

const drafts = reactive(new Map<string, PickDraft>());

function draftFor(job: string, candidate: ImportCandidate): PickDraft {
  const key = `${job} ${candidate.key}`;
  let draft = drafts.get(key);
  if (draft === undefined) {
    draft = { chosen: false, id: candidate.id, ref: "", version: "" };
    drafts.set(key, draft);
  }
  return draft;
}

interface PickInput {
  candidate: string;
  id?: string;
  pin?: { ref?: string; version?: string };
}

async function pick(job: string, candidates: readonly ImportCandidate[]): Promise<void> {
  const picks: PickInput[] = [];
  for (const candidate of candidates) {
    const draft = draftFor(job, candidate);
    if (!draft.chosen) {
      continue;
    }
    const entry: PickInput = { candidate: candidate.key };
    if (draft.id !== candidate.id) {
      entry.id = draft.id;
    }
    if (draft.ref !== "" || draft.version !== "") {
      entry.pin = {};
      if (draft.ref !== "") {
        entry.pin.ref = draft.ref;
      }
      if (draft.version !== "") {
        entry.pin.version = draft.version;
      }
    }
    picks.push(entry);
  }
  try {
    await execute(PickImportMutation, { job, picks, shelf: shelf.value });
    notify(`Importing ${picks.length} ${picks.length === 1 ? "item" : "items"}.`);
    invalidate(shelfPrefix(shelf.value));
  } catch (error) {
    notifyError(error);
  }
}

// Indexing a whole shelf from GitHub.

const indexForm = reactive({ ref: "", repository: "", root: "" });

async function index(): Promise<void> {
  try {
    await execute(IndexRepositoryMutation, {
      ref: indexForm.ref.trim() === "" ? null : indexForm.ref.trim(),
      repository: indexForm.repository.trim(),
      root: indexForm.root.trim() === "" ? null : indexForm.root.trim(),
      shelf: shelf.value,
    });
    notify("Copying the shelf: this one updates when that finishes.");
  } catch (error) {
    notifyError(error);
  }
}

/**
 * The titles of the candidates one links to. It requires them, so a profile that selects it gets them: those imported
 * with it, and for one left out, the doc the shelf already has at its path (`requireLinked` in `@shelfkit/importers`).
 */
function linkedTitles(candidates: readonly ImportCandidate[], candidate: ImportCandidate): string {
  const linked = new Set(candidate.requires);
  return candidates
    .filter((entry) => linked.has(entry.key))
    .map((entry) => entry.title)
    .join(", ");
}

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
</script>

<template>
  <main class="page">
    <h1>Import</h1>
    <p class="muted">
      Bring items into this shelf from somewhere else: a Git repository, an APM registry, an MCP server catalog, a
      plugin marketplace, or another shelf. ShelfKit looks through the source in the background; you then choose what
      to keep. An item whose licence does not allow copying is kept as a link to where it lives, not as a copy.
    </p>
    <div class="columns">
      <form aria-label="Start an import" class="panel" @submit.prevent="start">
        <h2>Import from a source</h2>
        <div v-if="sources.length > 0" class="field">
          <label for="import-source">A saved source</label>
          <select id="import-source" v-model="form.sourceId">
            <option value="">None: enter one below</option>
            <option v-for="entry in sources" :key="entry.id" :value="entry.id">{{ entry.id }} ({{ sourceKindLabel(entry.kind) }})</option>
          </select>
        </div>
        <div v-if='form.sourceId === ""' class="field">
          <label for="import-kind">What it is</label>
          <select id="import-kind" v-model="form.kind">
            <option v-for="entry in IMPORT_KINDS" :key="entry.kind" :value="entry.kind">{{ entry.label }}</option>
          </select>
        </div>
        <label class="field">Repository <input v-model="form.repo" name="repo" placeholder="https://github.com/owner/repo" /></label>
        <label class="field">URL <input v-model="form.url" name="url" placeholder="https://registry.example/…" /></label>
        <div class="row">
          <label class="field">Branch, tag or commit <input v-model="form.ref" name="ref" placeholder="main, v1.2.0, a commit" /></label>
          <label class="field">Folder in it <input v-model="form.path" name="path" placeholder="skills/" /></label>
          <label v-if='form.kind === "shelfkit"' class="field">Profile <input v-model="form.profile" name="profile" /></label>
        </div>
        <p v-if="startError !== null" class="error-text small" role="alert">{{ startError }}</p>
        <div class="row">
          <button class="primary" type="submit" :disabled="starting">Look for items</button>
        </div>
      </form>
      <form aria-label="Copy a whole shelf from GitHub" class="panel" @submit.prevent="index">
        <h2>Copy a whole shelf from GitHub</h2>
        <p class="small muted">
          Read every item and profile of a shelf (a folder with a <code>shelf.json</code>) in a GitHub repository into
          this one.
        </p>
        <label class="field">Repository <input v-model="indexForm.repository" placeholder="owner/repo" required /></label>
        <div class="row">
          <label class="field">Branch, tag or commit <input v-model="indexForm.ref" placeholder="the default branch" /></label>
          <label class="field">Folder <input v-model="indexForm.root" placeholder="the root" /></label>
        </div>
        <div class="row">
          <button type="submit">Copy the shelf</button>
        </div>
      </form>
    </div>
    <h2>Imports</h2>
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="jobs.length === 0"
      empty-text="No imports yet."
    />
    <section v-for="job in jobs" :key="job.id" class="panel" :data-job="job.id">
      <div class="row">
        <span class="badge" :class='{ danger: job.status === "failed", info: job.status === "done" }'>{{ importStatusLabel(job.status) }}</span>
        <code class="small">{{ pretty(job.source) }}</code>
        <span class="spacer"></span>
        <span class="small muted">{{ when(job.updatedAt) }}</span>
      </div>
      <p v-if="job.error" class="error-text small">{{ job.error }}</p>
      <ul v-if="job.warnings.length > 0" class="small severity-warning">
        <li v-for="warning in job.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <p v-if="job.imported.length > 0" class="small">Imported: <span class="mono">{{ job.imported.join(", ") }}</span></p>
      <template v-if='job.status === "ready" && readCandidates(job.candidates).length > 0'>
        <p class="small muted">
          Tick what to keep. You can give an item another id on this shelf, and lock it to a branch, tag, commit or
          version of the source; left empty, it follows what the source holds now.
        </p>
        <table class="table">
          <thead>
            <tr>
              <th><span class="visually-hidden">Import</span></th>
              <th>Item</th>
              <th>Id on this shelf</th>
              <th>Licence</th>
              <th>Branch, tag or commit</th>
              <th>Version</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="candidate in readCandidates(job.candidates)" :key="candidate.key">
              <td>
                <input
                  v-model="draftFor(job.id, candidate).chosen"
                  type="checkbox"
                  :aria-label="`Import ${candidate.title}`"
                />
              </td>
              <td>
                <span class="badge">{{ KINDS[candidate.kind].label }}</span> {{ candidate.title }}
                <div class="small muted">{{ candidate.description ?? candidate.path ?? "" }}</div>
                <div
                  v-if='linkedTitles(readCandidates(job.candidates), candidate) !== ""'
                  class="small muted"
                >
                  Links to {{ linkedTitles(readCandidates(job.candidates), candidate) }}. Ticked, they come with it; left
                  unticked, it uses the doc this shelf already has at the same path, if there is one.
                </div>
              </td>
              <td><input
                  v-model="draftFor(job.id, candidate).id"
                  class="mono"
                  :aria-label="`Id for ${candidate.title}`"
                /></td>
              <td class="small">
                {{ candidate.licenseId ?? candidate.license ?? "none" }}
                <span
                  v-if="candidate.linkOnly"
                  class="badge warn"
                  title="No licence that allows copying: imported as a link"
                >link only</span>
              </td>
              <td>
                <input
                  v-model="draftFor(job.id, candidate).ref"
                  :placeholder='candidate.upstream?.ref ?? ""'
                  :aria-label="`Ref for ${candidate.title}`"
                />
              </td>
              <td>
                <input
                  v-model="draftFor(job.id, candidate).version"
                  :placeholder='candidate.upstream?.version ?? ""'
                  :aria-label="`Version for ${candidate.title}`"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <div class="row">
          <button class="primary" type="button" @click="pick(job.id, readCandidates(job.candidates))">Import the ticked items</button>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--layout-measure-pane)), 1fr));
  gap: var(--spacing-size-4);
  align-items: start;
}
</style>
