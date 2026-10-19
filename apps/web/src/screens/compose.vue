<script setup lang="ts">
import type { Profile } from "@shelfkit/schema";
import { computed, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { execute, messageOf } from "../api/graphql.ts";
import { readBundles, readProfile } from "../api/json.ts";
import { ComposeQuery, SaveProfileMutation } from "../api/operations.ts";
import ComposeInventory from "../components/compose-inventory.vue";
import ComposePreview from "../components/compose-preview.vue";
import ComposeProfile from "../components/compose-profile.vue";
import ComposeRail from "../components/compose-rail.vue";
import QueryState from "../components/query-state.vue";
import StackTester from "../components/stack-tester.vue";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify } from "../composables/toasts.ts";
import { usePreview } from "../composables/use-preview.ts";
import { useQuery } from "../composables/use-query.ts";
import {
  addItems,
  emptyProfile,
  normalizeProfile,
  placeItem,
  refId,
  removeItem,
} from "../lib/profile.ts";
import { param } from "../router.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();
const profileId = computed(() => param(route.params.profile));

const query = useQuery(async () => {
  const data = await execute(ComposeQuery, { shelf: shelf.value });
  return data.shelf;
}, [shelf]);

const inventory = computed(() => query.data.value?.items.nodes.map((node) => node.item) ?? []);
const bundles = computed(() => readBundles(query.data.value?.bundles ?? []));
const otherProfiles = computed(() =>
  (query.data.value?.profiles ?? []).filter((profile) => profile.id !== profileId.value),
);
const canWrite = computed(() => {
  const access = query.data.value?.viewerAccess;
  return access !== undefined && (access.write || access.profiles.includes(profileId.value));
});
const entries = computed(() => query.data.value?.files ?? null);

/** The draft being composed, and the document it started from (the saved profile, or nothing for a new one). */
const draft = shallowRef<Profile | null>(null);
const saved = shallowRef<Profile | null>(null);
const isNew = computed(() => profileId.value === "");

function itemsFromQuery(): string[] {
  const { add: requested } = route.query;
  const text = Array.isArray(requested) ? requested.join(",") : (requested ?? "");
  return text
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

/** Start the draft once the shelf has loaded, and again when the route names another profile. */
watch(
  [() => query.data.value !== null, profileId],
  ([loaded, id], [wasLoaded, previousId]) => {
    if (!loaded || (wasLoaded && id === previousId && draft.value !== null)) {
      return;
    }
    // Saving a new profile moves the route to its id: the draft is already that profile.
    if (draft.value !== null && draft.value.id === id) {
      return;
    }
    const existing = (query.data.value?.profiles ?? []).find((profile) => profile.id === id);
    const document = existing === undefined ? null : readProfile(existing.document);
    saved.value = document;
    const start = document ?? emptyProfile("new-profile", "New profile");
    draft.value = addItems(start, itemsFromQuery());
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    draft.value !== null &&
    JSON.stringify(normalizeProfile(draft.value)) !==
      JSON.stringify(saved.value === null ? null : normalizeProfile(saved.value)),
);

const normalized = computed(() => (draft.value === null ? null : normalizeProfile(draft.value)));
const { error: previewError, preview, running } = usePreview(shelf, entries, normalized);

function update(next: Profile): void {
  draft.value = next;
}

function add(id: string, at: number | null): void {
  if (draft.value === null) {
    return;
  }
  draft.value = at === null ? addItems(draft.value, [id]) : placeItem(draft.value, id, at);
}

/** Take an item out of the profile; Undo puts the draft back as it was. */
function remove(id: string): void {
  const before = draft.value;
  if (before === null) {
    return;
  }
  draft.value = removeItem(before, id);
  notify(`Removed ${id} from the profile.`, async () => {
    draft.value = before;
    await Promise.resolve();
  });
}

const inProfile = computed(
  () => new Set((draft.value?.items ?? []).map((itemRef) => refId(itemRef))),
);

// Saving.

const message = ref("");
const saving = ref(false);
const saveErrors = ref<string[]>([]);

async function save(): Promise<void> {
  const document = normalized.value;
  if (document === null) {
    return;
  }
  saving.value = true;
  saveErrors.value = [];
  try {
    const data = await execute(SaveProfileMutation, {
      document,
      message: message.value.trim() === "" ? null : message.value.trim(),
      shelf: shelf.value,
    });
    const result = data.saveProfile;
    if (!result.ok) {
      saveErrors.value =
        result.errors.length > 0
          ? result.errors.map((error) => `${error.path}: ${error.message}`)
          : [result.reason ?? "the shelf refused the profile"];
      return;
    }
    saved.value = document;
    message.value = "";
    notify(`Saved profile “${document.title}”.`);
    if (profileId.value !== document.id) {
      await router.replace({
        name: "compose",
        params: { profile: document.id, shelf: shelf.value },
      });
    }
  } catch (error) {
    saveErrors.value = [messageOf(error)];
  } finally {
    saving.value = false;
  }
}

function revert(): void {
  const before = draft.value;
  draft.value = saved.value ?? emptyProfile("new-profile", "New profile");
  if (before !== null) {
    notify("Reverted to the saved profile.", async () => {
      draft.value = before;
      await Promise.resolve();
    });
  }
}

const idTaken = computed(
  () =>
    isNew.value &&
    draft.value !== null &&
    (query.data.value?.profiles ?? []).some((profile) => profile.id === draft.value?.id),
);
</script>

<template>
  <main class="compose">
    <QueryState :loading="query.loading.value" :error="query.error.value" :empty="draft === null" />
    <template v-if="draft !== null">
      <header class="compose__header row">
        <h1>{{ isNew ? "New profile" : draft.title }}</h1>
        <span v-if="dirty" class="badge warn" data-testid="dirty">unsaved</span>
        <span class="spacer" />
        <span class="small muted" data-testid="preview-runner">
          {{
            running
              ? "compiling…"
              : preview?.runner === "browser"
                ? "compiled in your browser"
                : preview?.runner === "server"
                  ? "compiled on the server"
                  : ""
          }}
        </span>
        <template v-if="canWrite">
          <input
            v-model="message"
            aria-label="Revision message"
            class="message"
            placeholder="Revision message (optional)"
          />
          <button type="button" :disabled="!dirty" @click="revert">Revert</button>
          <button
            class="primary"
            type="button"
            :disabled="saving || idTaken"
            data-testid="save-profile"
            @click="save"
          >
            Save profile
          </button>
        </template>
      </header>
      <p v-if="idTaken" class="error-text small" role="alert">A profile with the id <code>{{ draft.id }}</code> exists. Pick another id.</p>
      <ul v-if="saveErrors.length > 0" class="error-text small" role="alert">
        <li v-for="error in saveErrors" :key="error">{{ error }}</li>
      </ul>
      <div class="compose__panes">
        <ComposeInventory :items="inventory" :in-profile="inProfile" @add="add($event, null)" />
        <ComposeProfile
          :profile="draft"
          :is-new="isNew"
          :inventory="inventory"
          :bundles="bundles"
          :profiles="otherProfiles"
          @update="update"
          @remove="remove"
          @place="add"
        />
        <ComposeRail :preview="preview" :inventory="inventory" :error="previewError" />
      </div>
      <ComposePreview :preview="preview" :running="running" />
      <StackTester :shelf="shelf" :in-profile="inProfile" @add="add($event, null)" />
    </template>
  </main>
</template>

<style scoped>
.compose {
  padding: var(--spacing-size-4) var(--spacing-size-6);
  display: grid;
  gap: var(--spacing-size-4);
  align-content: start;
}

.compose__header {
  gap: var(--spacing-size-3);
}
/* Three panes side by side when they fit; on a narrower screen the rail wraps below rather than covering the profile. */
.compose__panes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-size-4);
  align-items: flex-start;
}

.compose__panes > :first-child, .compose__panes > :nth-child(3) {
  flex: 1 0 var(--layout-measure-rail);
  max-width: var(--layout-measure-pane);
}

.compose__panes > :nth-child(2) {
  flex: 3 0 var(--layout-measure-pane);
  min-width: 0;
}

.message {
  min-width: var(--layout-measure-rail);
}
</style>
