<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { execute } from "../api/graphql.ts";
import { pretty, readSource } from "../api/json.ts";
import {
  DeleteItemMutation,
  ItemQuery,
  SetFavouriteMutation,
  WriteItemMutation,
} from "../api/operations.ts";
import DiffView from "../components/diff-view.vue";
import ExternalLink from "../components/external-link.ts";
import MarkdownView from "../components/markdown-view.ts";
import QueryState from "../components/query-state.vue";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { useQuery } from "../composables/use-query.ts";
import { param } from "../router.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();
const id = computed(() => param(route.params.id));

const query = useQuery(async () => {
  const data = await execute(ItemQuery, { id: id.value, shelf: shelf.value });
  return data.shelf;
}, [shelf, id]);

const item = computed(() => query.data.value?.item ?? null);
const canWrite = computed(() => query.data.value?.viewerAccess.write === true);
const source = computed(() => readSource(item.value?.source ?? null));

type Tab = "content" | "revisions" | "provenance" | "dependents" | "scans";
const tab = ref<Tab>("content");
const TABS: readonly { tab: Tab; label: string }[] = [
  { label: "Content", tab: "content" },
  { label: "Revisions", tab: "revisions" },
  { label: "Provenance", tab: "provenance" },
  { label: "Used by", tab: "dependents" },
  { label: "Scans", tab: "scans" },
];

/** The files shown under the rendered body: everything but item.json, which has its own block. */
const otherFiles = computed(() =>
  (item.value?.files ?? []).filter((file) => file.path !== "item.json"),
);

// Revisions: every file of the selected revision against the one before it.
const selectedRevision = ref(0);
const revisions = computed(() => item.value?.revisions ?? []);

function filesAt(at: number): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of revisions.value[at]?.files ?? []) {
    files.set(
      file.path,
      file.encoding === "base64" ? `(binary, sha256 ${file.sha256})` : file.contents,
    );
  }
  return files;
}

const revisionDiffs = computed(() => {
  const after = filesAt(selectedRevision.value);
  const before = filesAt(selectedRevision.value + 1);
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return paths
    .map((path) => ({ after: after.get(path) ?? "", before: before.get(path) ?? "", path }))
    .filter((entry) => entry.after !== entry.before);
});

const dependentCount = computed(() => {
  const dependents = item.value?.dependents;
  if (dependents === undefined) {
    return 0;
  }
  return (
    dependents.requiredBy.length +
    dependents.recommendedBy.length +
    dependents.bundles.length +
    dependents.profiles.length
  );
});

const SCAN_TONE = { clean: "info", disputed: "warn", flagged: "danger", unscanned: "" } as const;
const DRIFT_TONE = {
  authored: "",
  current: "info",
  error: "danger",
  gone: "danger",
  moved: "warn",
  unchecked: "",
} as const;

async function toggleFavourite(): Promise<void> {
  const current = item.value;
  if (current === null) {
    return;
  }
  try {
    await execute(SetFavouriteMutation, {
      favourite: !current.favourite,
      item: current.id,
      shelf: shelf.value,
    });
    await query.refresh();
  } catch (error) {
    notifyError(error);
  }
}

/** Delete the item; Undo writes it back, files and all, from what this page loaded. */
async function remove(): Promise<void> {
  const current = item.value;
  if (current === null) {
    return;
  }
  const { document } = current;
  const files = otherFiles.value.map((file) => ({
    contents: file.contents,
    encoding: file.encoding,
    path: file.path,
  }));
  const shelfId = shelf.value;
  try {
    const data = await execute(DeleteItemMutation, { id: current.id, shelf: shelfId });
    const result = data.deleteItem;
    if (!result.ok) {
      notify(
        result.errors.map((error) => error.message).join("; ") || (result.reason ?? "refused"),
        null,
        "error",
      );
      return;
    }
    await router.push({ name: "shelf", params: { shelf: shelfId } });
    notify(`Deleted “${current.title}”.`, async () => {
      const restored = await execute(WriteItemMutation, {
        document,
        files,
        message: "Undo delete",
        shelf: shelfId,
      });
      if (!restored.writeItem.ok) {
        throw new Error(restored.writeItem.reason ?? "the shelf refused to restore it");
      }
    });
  } catch (error) {
    notifyError(error);
  }
}

function when(timestamp: string | null | undefined): string {
  return timestamp === null || timestamp === undefined
    ? "never"
    : new Date(timestamp).toLocaleString();
}

interface ProvenanceRow {
  readonly label: string;
  readonly value: string;
}

/** The provenance fields the item carries, labelled, in reading order. */
const provenanceRows = computed(() => {
  const current = source.value;
  if (current === null) {
    return [];
  }
  const rows = PROVENANCE_FIELDS.flatMap(([field, label]): ProvenanceRow[] => {
    const value = current[field];
    return value === undefined ? [] : [{ label, value }];
  });
  if (current.shareAlike !== undefined) {
    rows.push({ label: "Share-alike", value: current.shareAlike ? "yes" : "no" });
  }
  return rows;
});

const PROVENANCE_FIELDS = [
  ["repo", "Repository"],
  ["ref", "Ref"],
  ["resolvedCommit", "Commit"],
  ["path", "Path"],
  ["url", "URL"],
  ["version", "Version"],
  ["digest", "Digest"],
  ["license", "Licence"],
  ["licenseId", "SPDX"],
  ["creditText", "Credit"],
  ["linkTarget", "Credit link"],
  ["recordUrl", "Record"],
  ["id", "Source"],
] as const;
</script>

<template>
  <main class="page">
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="item === null"
      empty-text="No such item."
    />
    <template v-if="item !== null">
      <header class="stack">
        <div class="row">
          <RouterLink class="small" :to='{ name: "shelf", params: { shelf } }'>← Shelf</RouterLink>
        </div>
        <div class="row">
          <span class="badge">{{ item.kind }}</span>
          <h1>{{ item.title }}</h1>
          <button class="quiet" type="button" :aria-pressed="item.favourite" @click="toggleFavourite">
            {{ item.favourite ? "★" : "☆" }}
          </button>
          <span class="spacer" />
          <RouterLink
            v-if='item.kind === "prompt"'
            class="button"
            :to='{ name: "prompts", params: { shelf, id: item.id } }'
          >
            Open in prompts
          </RouterLink>
          <RouterLink
            class="button"
            :to='{ name: "compose", params: { shelf }, query: { add: item.id } }'
          >
            Add to a profile
          </RouterLink>
          <button v-if="canWrite" class="danger" type="button" @click="remove">Delete</button>
        </div>
        <p class="muted">{{ item.description }}</p>
        <div class="row small">
          <span class="mono muted">{{ item.id }}</span>
          <span class="mono muted" :title="item.revision">{{ item.revision.slice(0, 19) }}…</span>
          <span class="badge" :class="SCAN_TONE[item.scanStatus]" title="Scan state of this revision">
            scan: {{ item.scanStatus }}
          </span>
          <span class="badge" :class="DRIFT_TONE[item.drift.status]" title="Upstream drift">
            upstream: {{ item.drift.status }}
          </span>
          <span v-for="entry in item.tags" :key="entry" class="chip">#{{ entry }}</span>
          <span v-for="entry in item.targets" :key="entry" class="chip">→ {{ entry }}</span>
        </div>
        <div class="panel coordinate" data-testid="coordinate">
          <div class="row small">
            <strong>Compiles to</strong>
            <span class="badge">{{ item.coordinate.kind }}</span>
            <span v-if="item.coordinate.name" class="mono">{{ item.coordinate.name }}</span>
            <span v-if="item.coordinate.message" class="severity-error">{{ item.coordinate.message }}</span>
          </div>
          <pre v-if="item.coordinate.entry">{{ item.coordinate.entry }}</pre>
          <p v-else-if='item.coordinate.kind === "vendored"' class="small muted">
            Its content is vendored into the profile's own package, under <code>vendor/&lt;profile&gt;/</code>.
          </p>
        </div>
      </header>
      <div class="tabs" role="tablist">
        <button
          v-for="entry in TABS"
          :key="entry.tab"
          role="tab"
          type="button"
          :aria-selected="tab === entry.tab"
          @click="tab = entry.tab"
        >
          {{ entry.label }}
          <template v-if='entry.tab === "revisions"'> ({{ revisions.length }})</template>
          <template v-else-if='entry.tab === "dependents"'> ({{ dependentCount }})</template>
          <template v-else-if='entry.tab === "scans"'> ({{ item.scans.length }})</template>
        </button>
      </div>
      <section v-if='tab === "content"' class="content">
        <div v-if="item.body !== null && item.body !== undefined" class="panel">
          <MarkdownView :source="item.body" />
        </div>
        <details v-for="file in otherFiles" :key="file.path" class="panel">
          <summary class="mono small">{{ file.path }} <span class="muted">{{ file.size }} bytes</span></summary>
          <pre v-if='file.encoding === "base64"' class="muted">Binary file, sha256 {{ file.sha256 }}</pre>
          <pre v-else>{{ file.contents }}</pre>
        </details>
        <details class="panel" open>
          <summary class="mono small">item.json</summary>
          <pre>{{ pretty(item.document) }}</pre>
        </details>
      </section>
      <section v-else-if='tab === "revisions"' class="split">
        <ol class="list panel">
          <li v-for="(revision, at) in revisions" :key="revision.revision">
            <button
              class="list-row quiet full"
              type="button"
              :class="{ active: at === selectedRevision }"
              @click="selectedRevision = at"
            >
              <span class="mono small">{{ revision.revision.slice(7, 19) }}</span>
              <span class="small ellipsis">{{ revision.message ?? "" }}</span>
              <span class="spacer" />
              <span class="small muted">{{ when(revision.createdAt) }}</span>
              <span v-if="at === 0" class="badge">current</span>
            </button>
          </li>
        </ol>
        <div class="panel">
          <p v-if="revisionDiffs.length === 0" class="muted small">No file changed in this revision.</p>
          <DiffView
            v-for="diff in revisionDiffs"
            :key="diff.path"
            :label="diff.path"
            :before="diff.before"
            :after="diff.after"
          />
        </div>
      </section>
      <section v-else-if='tab === "provenance"' class="panel">
        <p v-if="source === null" class="muted">Authored in this shelf.</p>
        <table v-else class="table">
          <tbody>
            <tr v-for="row in provenanceRows" :key="row.label">
              <th scope="row">{{ row.label }}</th>
              <td class="mono">{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if='item.drift.status !== "authored"' class="stack small">
          <strong>Upstream</strong>
          <span>Status: {{ item.drift.status }} · checked {{ when(item.drift.checkedAt) }}</span>
          <span v-if="item.drift.error" class="error-text">{{ item.drift.error }}</span>
          <pre v-if="item.drift.latest">{{ pretty(item.drift.latest) }}</pre>
        </div>
      </section>
      <section v-else-if='tab === "dependents"' class="panel">
        <p v-if="dependentCount === 0" class="muted">Nothing in the shelf names this item.</p>
        <dl class="dependents">
          <template v-if="item.dependents.profiles.length > 0">
            <dt>Profiles</dt>
            <dd class="row">
              <RouterLink
                v-for="profile in item.dependents.profiles"
                :key="profile"
                :to='{ name: "compose", params: { shelf, profile } }'
              >
                {{ profile }}
              </RouterLink>
            </dd>
          </template>
          <template v-if="item.dependents.bundles.length > 0">
            <dt>Bundles</dt>
            <dd class="row mono">{{ item.dependents.bundles.join(", ") }}</dd>
          </template>
          <template v-if="item.dependents.requiredBy.length > 0">
            <dt>Required by</dt>
            <dd class="row">
              <RouterLink
                v-for="other in item.dependents.requiredBy"
                :key="other"
                :to='{ name: "item", params: { shelf, id: other } }'
              >
                {{ other }}
              </RouterLink>
            </dd>
          </template>
          <template v-if="item.dependents.recommendedBy.length > 0">
            <dt>Recommended by</dt>
            <dd class="row">
              <RouterLink
                v-for="other in item.dependents.recommendedBy"
                :key="other"
                :to='{ name: "item", params: { shelf, id: other } }'
              >
                {{ other }}
              </RouterLink>
            </dd>
          </template>
        </dl>
      </section>
      <section v-else class="panel">
        <p class="small muted">
          Every verdict on every revision, recorded against the hash ShelfKit computed. <em>unscanned</em> is not
          <em>clean</em>.
        </p>
        <table v-if="item.scans.length > 0" class="table">
          <thead>
            <tr>
              <th>Scanner</th>
              <th>Verdict</th>
              <th>Revision</th>
              <th>Summary</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="scan in item.scans" :key="scan.id">
              <td>{{ scan.scanner }}</td>
              <td>
                <span class="badge">{{ scan.verdict }}</span>
              </td>
              <td class="mono">
                {{ scan.revision.slice(7, 19) }}
                <span v-if="scan.revision === item.revision" class="badge info">current</span>
              </td>
              <td>
                {{ scan.summary ?? "" }}
                <ExternalLink v-if="scan.detailsUrl" :address="scan.detailsUrl">details</ExternalLink>
              </td>
              <td>{{ when(scan.recordedAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">No scanner has seen this item.</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.content {
  display: grid;
  gap: var(--spacing-size-3);
  max-width: calc(var(--shape-measure-prose) * 1.4);
}

.split {
  display: grid;
  grid-template-columns: var(--shape-measure-pane) minmax(0, 1fr);
  gap: var(--spacing-size-4);
  align-items: start;
}

.full {
  width: 100%;
  border: none;
  border-radius: 0;
}

.coordinate {
  padding: var(--spacing-size-2) var(--spacing-size-3);
}

.dependents {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--spacing-size-2) var(--spacing-size-4);
  margin: 0;
}

.dependents dd {
  margin: 0;
}
</style>
