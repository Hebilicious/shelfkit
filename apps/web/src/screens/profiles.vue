<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { execute } from "../api/graphql.ts";
import { DeleteProfileMutation, ProfilesQuery, SaveProfileMutation } from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { copyToClipboard } from "../composables/clipboard.ts";
import { useListNav } from "../composables/list-nav.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { useQuery } from "../composables/use-query.ts";

const shelf = useShelfId();
const router = useRouter();

const query = useQuery(async () => {
  const data = await execute(ProfilesQuery, { shelf: shelf.value });
  return data.shelf;
}, [shelf]);

const profiles = computed(() => query.data.value?.profiles ?? []);
const canWrite = computed(() => query.data.value?.viewerAccess.write === true);

interface ConflictCounts {
  readonly errors: number;
  readonly warnings: number;
}

function counts(conflicts: readonly { severity: string }[]): ConflictCounts {
  return {
    errors: conflicts.filter((conflict) => conflict.severity === "error").length,
    warnings: conflicts.filter((conflict) => conflict.severity === "warning").length,
  };
}

async function copyCoordinate(coordinate: string): Promise<void> {
  try {
    await copyToClipboard(coordinate);
    notify("Registry coordinate copied.");
  } catch (error) {
    notifyError(error);
  }
}

/**
 * Delete a profile; Undo saves its document back.
 * BOUNDARY: `document` is the profile's `JSON` exactly as the service gave it, handed back to it unchanged.
 */
async function remove(id: string, title: string, document: unknown): Promise<void> {
  const shelfId = shelf.value;
  try {
    const data = await execute(DeleteProfileMutation, { id, shelf: shelfId });
    if (!data.deleteProfile.ok) {
      notify(data.deleteProfile.reason ?? "the shelf refused the delete", null, "error");
      return;
    }
    await query.refresh();
    notify(`Deleted profile “${title}”.`, async () => {
      const restored = await execute(SaveProfileMutation, {
        document,
        message: "Undo delete",
        shelf: shelfId,
      });
      if (!restored.saveProfile.ok) {
        throw new Error(restored.saveProfile.reason ?? "the shelf refused to restore it");
      }
      await query.refresh();
    });
  } catch (error) {
    notifyError(error);
  }
}

const index = useListNav({
  length: () => profiles.value.length,
  open: (at) => {
    const profile = profiles.value[at];
    if (profile !== undefined) {
      void router.push({ name: "compose", params: { profile: profile.id, shelf: shelf.value } });
    }
  },
});
</script>

<template>
  <main class="page">
    <header class="row">
      <h1>Profiles</h1>
      <span class="spacer"></span>
      <RouterLink v-if="canWrite" class="button primary" :to='{ name: "compose", params: { shelf } }'>New profile</RouterLink>
    </header>
    <p class="small muted">
      A profile is what a repository installs: items, bundles and compile settings, compiled to one <code>apm.yml</code>.
    </p>
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="profiles.length === 0"
      empty-text="No profiles yet. Compose one from the shelf's items."
    />
    <ul class="list panel" data-testid="profile-list">
      <li v-for="(profile, at) in profiles" :key="profile.id">
        <div class="list-row" data-list-row :aria-current='at === index ? "true" : undefined'>
          <div class="stack profile-row__text">
            <div class="row">
              <RouterLink
                class="profile-row__title"
                :to='{ name: "compose", params: { shelf, profile: profile.id } }'
              >
                {{ profile.title }}
              </RouterLink>
              <span class="mono small muted">{{ profile.id }}</span>
              <span v-if="query.data.value?.defaultProfile === profile.id" class="badge">default</span>
              <span v-if="profile.version" class="badge">v{{ profile.version }}</span>
            </div>
            <span class="small muted ellipsis">{{ profile.description }}</span>
            <div class="row small">
              <span>{{ profile.resolution.items.length }} items</span>
              <span v-if="counts(profile.resolution.conflicts).errors > 0" class="severity-error">
                {{ counts(profile.resolution.conflicts).errors }} errors
              </span>
              <span v-if="counts(profile.resolution.conflicts).warnings > 0" class="severity-warning">
                {{ counts(profile.resolution.conflicts).warnings }} warnings
              </span>
              <span v-if="profile.published" class="muted">
                published as {{ profile.published.package }}
              </span>
              <button
                class="quiet small mono"
                title="Copy the registry coordinate"
                type="button"
                @click="copyCoordinate(profile.apmCoordinate)"
              >
                {{ profile.apmCoordinate }}
              </button>
            </div>
          </div>
          <span class="spacer"></span>
          <RouterLink
            class="button"
            :to='{ name: "compose", params: { shelf, profile: profile.id } }'
          >Compose</RouterLink>
          <RouterLink
            class="button"
            :to='{ name: "compile", params: { shelf, profile: profile.id } }'
          >Compile</RouterLink>
          <button
            v-if="canWrite"
            class="danger"
            type="button"
            @click="remove(profile.id, profile.title, profile.document)"
          >
            Delete
          </button>
        </div>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.profile-row__text {
  min-width: 0;
  gap: var(--spacing-size-1);
}

.profile-row__title {
  color: var(--text-primary);
  font-weight: var(--typography-weight-sans-bold);
  text-decoration: none;
}
</style>
