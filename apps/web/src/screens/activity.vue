<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import QueryState from "../components/query-state.vue";
import { useShelfId } from "../composables/shelf-context.ts";
import { useActivity } from "../data/shelf.ts";
import { ago, outcomeLabel, shortRevision } from "../lib/vocabulary.ts";

const shelf = useShelfId();
const profile = ref("");

const query = useActivity(shelf, profile);

const records = computed(() => query.data.value?.activity ?? []);

/** Each repository's latest record: what it runs now, and whether that is behind the profile. */
const latestByRepository = computed(() => {
  const latest = new Map<string, (typeof records.value)[number]>();
  for (const record of records.value) {
    const key = `${record.repository} ${record.profile}`;
    if (!latest.has(key)) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
});

const staleCount = computed(() => latestByRepository.value.filter((record) => record.stale).length);

const titles = computed(
  () => new Map((query.data.value?.profiles ?? []).map((entry) => [entry.id, entry.title])),
);

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
</script>

<template>
  <main class="page">
    <header class="row">
      <h1>Repositories</h1>
      <span class="spacer"></span>
      <label class="small muted" for="activity-profile">Profile</label>
      <select id="activity-profile" v-model="profile">
        <option value="">Every profile</option>
        <option v-for="entry in query.data.value?.profiles ?? []" :key="entry.id" :value="entry.id">{{ entry.title }}</option>
      </select>
    </header>
    <p class="muted">
      Which repositories installed which profile, and whether they have its latest version. An install is recorded
      when it is written from a profile's Install page, or reported by an agent with the <code>shelf.report</code> tool.
    </p>
    <p
      v-if="latestByRepository.length > 0"
      class="small"
      :class='{ "severity-warning": staleCount > 0 }'
    >
      {{ latestByRepository.length }} {{ latestByRepository.length === 1 ? "repository" : "repositories" }};
      {{ staleCount }} behind the latest version of their profile.
    </p>
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="records.length === 0"
      empty-text="No repository has installed a profile yet."
    />
    <table v-if="latestByRepository.length > 0" class="table" data-testid="activity">
      <thead>
        <tr>
          <th>Repository</th>
          <th>Profile</th>
          <th>Version it has</th>
          <th>Last installed</th>
          <th><span class="visually-hidden">Install again</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in latestByRepository" :key="record.id">
          <td class="mono">{{ record.repository }}</td>
          <td>
            {{ titles.get(record.profile) ?? record.profile }}
            <span class="mono small muted">{{ record.profile }}</span>
          </td>
          <td>
            <span class="mono" :title="record.profileRevision">{{ shortRevision(record.profileRevision) }}</span>
            <span v-if="record.stale" class="badge warn">behind</span>
            <span v-else class="badge info">latest</span>
          </td>
          <td class="small" :title="when(record.recordedAt)">{{ ago(record.recordedAt) }}</td>
          <td>
            <RouterLink
              class="button small"
              :class="{ primary: record.stale }"
              :to='{ name: "compile", params: { shelf, profile: record.profile } }'
            >
              {{ record.stale ? "Update…" : "Install…" }}
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
    <details v-if="records.length > 0">
      <summary>Every install ({{ records.length }})</summary>
      <table class="table" data-testid="activity-history">
        <thead>
          <tr>
            <th>When</th>
            <th>Repository</th>
            <th>Profile</th>
            <th>Version</th>
            <th>Result</th>
            <th>apm.yml fingerprint</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.id">
            <td>{{ when(record.recordedAt) }}</td>
            <td class="mono">
              {{ record.repository }}
              <span v-if="record.commit" class="muted" title="The commit it was installed on">@{{ record.commit.slice(0, 8) }}</span>
            </td>
            <td>
              <RouterLink :to='{ name: "compose", params: { shelf, profile: record.profile } }'>{{ record.profile }}</RouterLink>
            </td>
            <td class="mono" :title="record.profileRevision">{{ shortRevision(record.profileRevision) }}</td>
            <td>
              <span class="badge" :class='{ danger: record.outcome === "failed" }'>{{ outcomeLabel(record.outcome) }}</span>
              <div v-if="record.message" class="small muted">{{ record.message }}</div>
            </td>
            <td class="mono small muted" :title="record.apmYmlDigest">{{ shortRevision(record.apmYmlDigest) }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </main>
</template>
