<script setup lang="ts">
/**
 * One item. Its header and content come from the shelf's index, which is already in memory, so the page is whole the
 * moment it opens; its history, scans, and files come from the item's own query, and what installing it writes from a
 * compile of a profile holding only this item.
 */
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { execute } from "../api/graphql.ts";
import { pretty, readSource } from "../api/json.ts";
import { DeleteItemMutation, SetFavouriteMutation, WriteItemMutation } from "../api/operations.ts";
import DiffView from "../components/diff-view.vue";
import ExternalLink from "../components/external-link.ts";
import InstallPlaces from "../components/install-places.vue";
import ItemContent from "../components/item-content.vue";
import SkillFiles from "../components/skill-files.vue";
import KindGuide from "../components/kind-guide.vue";
import QueryState from "../components/query-state.vue";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { invalidate, shelfPrefix } from "../data/cache.ts";
import { patchIndexItem, useItem, useItemInstall, useShelfIndex } from "../data/shelf.ts";
import { disablesModelInvocation } from "../lib/prompt.ts";
import { param } from "../navigation.ts";
import {
  ago,
  installSentence,
  KIND_GUIDES,
  KINDS,
  RULES_NOTE,
  originLabel,
  scanLabel,
  shortRevision,
} from "../lib/vocabulary.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();
const id = computed(() => param(route.params.id));

const index = useShelfIndex(shelf);
const item = computed(() => index.data.value?.items.find((entry) => entry.id === id.value) ?? null);
const canWrite = computed(() => index.data.value?.viewerAccess.write === true);
const titles = computed(
  () => new Map((index.data.value?.items ?? []).map((entry) => [entry.id, entry.title])),
);

const detail = useItem(shelf, id);
const install = useItemInstall(shelf, item);
const source = computed(() => readSource(item.value?.source ?? null));

type Tab = "installs" | "history" | "origin" | "used" | "scans" | "files";
const tab = ref<Tab>("installs");

const revisions = computed(() => detail.data.value?.revisions ?? []);
const scans = computed(() => detail.data.value?.scans ?? []);
const files = computed(() => detail.data.value?.files ?? []);

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

const TABS = computed<readonly { tab: Tab; label: string }[]>(() => [
  { label: "What it installs", tab: "installs" },
  { label: `Used by (${dependentCount.value})`, tab: "used" },
  {
    label: revisions.value.length > 0 ? `History (${revisions.value.length})` : "History",
    tab: "history",
  },
  { label: "Origin", tab: "origin" },
  { label: scans.value.length > 0 ? `Scans (${scans.value.length})` : "Scans", tab: "scans" },
  { label: "Files", tab: "files" },
]);

// History: every file of the selected revision against the one before it.
const selectedRevision = ref(0);

function filesAt(at: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of revisions.value[at]?.files ?? []) {
    out.set(
      file.path,
      file.encoding === "base64" ? `(binary, sha256 ${file.sha256})` : file.contents,
    );
  }
  return out;
}

const revisionDiffs = computed(() => {
  const after = filesAt(selectedRevision.value);
  const before = filesAt(selectedRevision.value + 1);
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return paths
    .map((path) => ({ after: after.get(path) ?? "", before: before.get(path) ?? "", path }))
    .filter((entry) => entry.after !== entry.before);
});

const SCAN_TONE = { clean: "info", disputed: "warn", flagged: "danger", unscanned: "" } as const;

async function toggleFavourite(): Promise<void> {
  const current = item.value;
  if (current === null) {
    return;
  }
  const favourite = !current.favourite;
  patchIndexItem(shelf.value, current.id, (entry) => ({ ...entry, favourite }));
  try {
    const data = await execute(SetFavouriteMutation, {
      favourite,
      item: current.id,
      shelf: shelf.value,
    });
    if (!data.setFavourite) {
      patchIndexItem(shelf.value, current.id, (entry) => ({ ...entry, favourite: !favourite }));
      notify("Favourites are kept per account: sign in to keep them.", null, "error");
    }
  } catch (error) {
    patchIndexItem(shelf.value, current.id, (entry) => ({ ...entry, favourite: !favourite }));
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
  const kept = files.value
    .filter((file) => file.path !== "item.json")
    .map((file) => ({ contents: file.contents, encoding: file.encoding, path: file.path }));
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
    invalidate(shelfPrefix(shelfId));
    await router.push({ name: "shelf", params: { shelf: shelfId } });
    notify(`Deleted “${current.title}”.`, async () => {
      const restored = await execute(WriteItemMutation, {
        document,
        files: kept,
        message: "Undo delete",
        shelf: shelfId,
      });
      if (!restored.writeItem.ok) {
        throw new Error(restored.writeItem.reason ?? "the shelf refused to restore it");
      }
      invalidate(shelfPrefix(shelfId));
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
      :loading="index.loading.value"
      :error="index.error.value"
      :empty="item === null"
      empty-text="This shelf has no such item."
    />
    <template v-if="item !== null">
      <header class="stack">
        <RouterLink
          class="small"
          :to='item.kind === "prompt"
            ? { name: "prompts", params: { shelf } }
            : { name: "kind", params: { shelf, kind: KIND_GUIDES[item.kind].slug } }'
        >
          ← {{ KINDS[item.kind].plural }}
        </RouterLink>
        <div class="row">
          <h1>{{ item.title }}</h1>
          <button
            class="quiet"
            type="button"
            :aria-pressed="item.favourite"
            :title='item.favourite ? "Remove from favourites" : "Add to favourites"'
            @click="toggleFavourite"
          >
            {{ item.favourite ? "★" : "☆" }}
          </button>
          <span class="spacer"></span>
          <RouterLink
            v-if='item.kind === "prompt"'
            class="button"
            :to='{ name: "prompts", params: { shelf, id: item.id } }'
          >
            Use this prompt
          </RouterLink>
          <RouterLink
            class="button primary"
            :to='{ name: "compose", params: { shelf }, query: { add: item.id } }'
          >
            Add to a profile
          </RouterLink>
          <button v-if="canWrite" class="danger" type="button" @click="remove">Delete</button>
        </div>
        <p v-if="item.description" class="lead">{{ item.description }}</p>
        <div class="row small muted">
          <span>{{ originLabel(item.drift.status) }}</span>
          <span>·</span>
          <span :title="item.revision">version {{ shortRevision(item.revision) }}, updated {{ ago(item.updatedAt) }}</span>
          <span
            v-if="scanLabel(item.scanStatus) !== null"
            class="badge"
            :class="SCAN_TONE[item.scanStatus]"
          >
            {{ scanLabel(item.scanStatus) }}
          </span>
          <span v-for="entry in item.tags" :key="entry" class="chip">#{{ entry }}</span>
          <span v-if="item.targets.length > 0">· only for {{ item.targets.join(", ") }}</span>
        </div>
      </header>
      <KindGuide compact :kind="item.kind" :shelf="shelf" />
      <SkillFiles
        v-if='item.kind === "skill"'
        :files='files.length > 0
          ? files
          : [
              {
                contents: item.body ?? "",
                encoding: "utf-8",
                path: "SKILL.md",
                size: (item.body ?? "").length,
              },
            ]'
      />
      <ItemContent :body="item.body" :document="item.document" :shelf="shelf" :titles="titles" />
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
        </button>
      </div>
      <section v-if='tab === "installs"' class="stack" data-testid="coordinate">
        <p class="small">
          Installing a profile that includes it puts it in these files of the repository:
        </p>
        <InstallPlaces :id="item.id" :kind="item.kind" />
        <p
          v-if='item.kind === "instructions" || item.kind === "stack" || item.kind === "library"'
          class="small muted"
        >
          {{ RULES_NOTE }}
        </p>
        <p
          v-if='item.kind === "skill" && disablesModelInvocation(item.body ?? "")'
          class="small"
          data-testid="asked-only"
        >
          <strong>Only when asked.</strong> SKILL.md sets <code>disable-model-invocation: true</code>, so no agent
          uses this skill on its own; you run it by name. Claude Code, Cursor, and Copilot read that from SKILL.md, and
          Codex from <code>agents/openai.yaml</code>, which the installed skill gets.
        </p>
        <p class="small muted">
          {{ installSentence(item.coordinate) }}
          <span v-if="item.coordinate.message" class="severity-error">{{ item.coordinate.message }}</span>
        </p>
        <QueryState :loading="install.loading.value" :error="install.error.value" />
        <template v-if="install.data.value !== null">
          <p v-for="error in install.data.value.errors" :key="error" class="error-text small">{{ error }}</p>
          <details v-for="file in install.data.value.files" :key="file.path" class="panel" open>
            <summary class="small">
              The text the agent gets <span class="mono muted">· {{ file.path }} in the profile's package</span>
            </summary>
            <pre class="wrap">{{ file.contents }}</pre>
          </details>
        </template>
      </section>
      <section v-else-if='tab === "used"' class="panel">
        <p v-if="dependentCount === 0" class="muted">No profile uses this item yet, and nothing else names it.</p>
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
            <dt>Needed by</dt>
            <dd class="row">
              <RouterLink
                v-for="other in item.dependents.requiredBy"
                :key="other"
                :to='{ name: "item", params: { shelf, id: other } }'
              >
                {{ titles.get(other) ?? other }}
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
                {{ titles.get(other) ?? other }}
              </RouterLink>
            </dd>
          </template>
        </dl>
      </section>
      <section v-else-if='tab === "history"' class="split">
        <QueryState
          :loading="detail.loading.value"
          :error="detail.error.value"
          :empty="revisions.length === 0"
          empty-text="No history."
        />
        <ol v-if="revisions.length > 0" class="list panel">
          <li v-for="(revision, at) in revisions" :key="revision.revision">
            <button
              class="list-row quiet full"
              type="button"
              :class="{ active: at === selectedRevision }"
              @click="selectedRevision = at"
            >
              <span class="mono small">{{ shortRevision(revision.revision) }}</span>
              <span class="small ellipsis">{{ revision.message ?? "" }}</span>
              <span class="spacer"></span>
              <span class="small muted">{{ when(revision.createdAt) }}</span>
              <span v-if="at === 0" class="badge">current</span>
            </button>
          </li>
        </ol>
        <div v-if="revisions.length > 0" class="panel">
          <p v-if="revisionDiffs.length === 0" class="muted small">No file changed in this version.</p>
          <DiffView
            v-for="diff in revisionDiffs"
            :key="diff.path"
            :label="diff.path"
            :before="diff.before"
            :after="diff.after"
          />
        </div>
      </section>
      <section v-else-if='tab === "origin"' class="panel">
        <p v-if="source === null" class="muted">Written in this shelf, not imported.</p>
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
          <span>{{ originLabel(item.drift.status) }} · checked {{ when(detail.data.value?.drift.checkedAt) }}</span>
          <span v-if="detail.data.value?.drift.error" class="error-text">{{ detail.data.value.drift.error }}</span>
          <pre v-if="detail.data.value?.drift.latest">{{ pretty(detail.data.value.drift.latest) }}</pre>
        </div>
      </section>
      <section v-else-if='tab === "scans"' class="panel">
        <p class="small muted">
          What security scanners said about each version of this item. Not scanned is not the same as clean.
        </p>
        <QueryState :loading="detail.loading.value" :error="detail.error.value" />
        <table v-if="scans.length > 0" class="table">
          <thead>
            <tr>
              <th>Scanner</th>
              <th>Verdict</th>
              <th>Version</th>
              <th>Summary</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="scan in scans" :key="scan.id">
              <td>{{ scan.scanner }}</td>
              <td>
                <span class="badge">{{ scan.verdict }}</span>
              </td>
              <td class="mono">
                {{ shortRevision(scan.revision) }}
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
        <p v-else-if="detail.data.value !== null" class="muted">No scanner has looked at this item.</p>
      </section>
      <section v-else class="stack">
        <p class="small muted">
          The files that define this item in the shelf's repository, under <code>{{ item.id }}</code>.
        </p>
        <QueryState :loading="detail.loading.value" :error="detail.error.value" />
        <details
          v-for="file in files"
          :key="file.path"
          class="panel"
          :open='file.path === "item.json"'
        >
          <summary class="mono small">{{ file.path }} <span class="muted">{{ file.size }} bytes</span></summary>
          <pre v-if='file.encoding === "base64"' class="muted">Binary file, sha256 {{ file.sha256 }}</pre>
          <pre v-else-if='file.path === "item.json"'>{{ pretty(item.document) }}</pre>
          <pre v-else>{{ file.contents }}</pre>
        </details>
      </section>
    </template>
  </main>
</template>

<style scoped>
.lead {
  margin: 0;
  font-size: var(--typography_fluid-sans-text-l);
}

.wrap {
  white-space: pre-wrap;
}

.split {
  display: grid;
  grid-template-columns: var(--layout-measure-pane) minmax(0, 1fr);
  gap: var(--spacing-size-4);
  align-items: start;
}

.full {
  width: 100%;
  border: none;
  border-radius: 0;
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
