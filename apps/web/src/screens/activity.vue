<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import { execute } from "../api/graphql.ts";
import { ActivityQuery } from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { useShelfId } from "../composables/shelf-context.ts";
import { useQuery } from "../composables/use-query.ts";

const shelf = useShelfId();
const profile = ref("");

const query = useQuery(async () => {
  const data = await execute(ActivityQuery, {
    profile: profile.value === "" ? null : profile.value,
    shelf: shelf.value,
  });
  return data.shelf;
}, [shelf, profile]);

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

function when(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
</script>

<template>
  <main class="page">
    <header class="row">
      <h1>Activity</h1>
      <span class="spacer"></span>
      <label class="small muted" for="activity-profile">Profile</label>
      <select id="activity-profile" v-model="profile">
        <option value="">Every profile</option>
        <option v-for="entry in query.data.value?.profiles ?? []" :key="entry.id" :value="entry.id">{{ entry.title }}</option>
      </select>
    </header>
    <p class="small muted">
      Which repositories compiled which profile revision. A compile is recorded when it is written from the Compile
      screen, or reported by an agent through <code>shelf.report</code>.
    </p>
    <p
      v-if="latestByRepository.length > 0"
      class="small"
      :class='{ "severity-warning": staleCount > 0 }'
    >
      {{ latestByRepository.length }} repositories; {{ staleCount }} on a revision the profile has moved past.
    </p>
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="records.length === 0"
      empty-text="Nothing has been compiled yet."
    />
    <table v-if="records.length > 0" class="table" data-testid="activity">
      <thead>
        <tr>
          <th>When</th>
          <th>Repository</th>
          <th>Profile</th>
          <th>Revision</th>
          <th>Outcome</th>
          <th>apm.yml</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in records" :key="record.id">
          <td>{{ when(record.recordedAt) }}</td>
          <td class="mono">
            {{ record.repository }}
            <span v-if="record.commit" class="muted">@{{ record.commit.slice(0, 8) }}</span>
          </td>
          <td>
            <RouterLink :to='{ name: "compose", params: { shelf, profile: record.profile } }'>{{ record.profile }}</RouterLink>
          </td>
          <td class="mono">
            {{ record.profileRevision.slice(7, 19) }}
            <span v-if="record.stale" class="badge warn">stale</span>
            <span v-else class="badge info">current</span>
          </td>
          <td>
            <span class="badge" :class='{ danger: record.outcome === "failed" }'>{{ record.outcome }}</span>
            <div v-if="record.message" class="small muted">{{ record.message }}</div>
          </td>
          <td class="mono small muted">{{ record.apmYmlDigest.slice(7, 19) }}</td>
        </tr>
      </tbody>
    </table>
  </main>
</template>
