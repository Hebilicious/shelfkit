<script setup lang="ts">
import { computed } from "vue";

import type { InventoryItem } from "../api/types.ts";
import type { Preview } from "../composables/use-preview.ts";
import type { Severity } from "../lib/conflicts.ts";

const { preview, inventory, error } = defineProps<{
  preview: Preview | null;
  inventory: readonly InventoryItem[];
  error: string | null;
}>();

const byId = computed(() => new Map(inventory.map((item) => [item.id, item])));
const items = computed(() => preview?.resolution?.items ?? []);
const unpinned = computed(() => items.value.filter((item) => !item.pinned));

const SEVERITIES: readonly { severity: Severity; label: string }[] = [
  { label: "Errors", severity: "error" },
  { label: "Warnings", severity: "warning" },
  { label: "Info", severity: "info" },
];

const bySeverity = computed(() => {
  const groups = new Map<Severity, Preview["conflicts"][number][]>();
  for (const conflict of preview?.conflicts ?? []) {
    groups.set(conflict.severity, [...(groups.get(conflict.severity) ?? []), conflict]);
  }
  return groups;
});

type Origin = NonNullable<Preview["resolution"]>["items"][number]["origin"];

function why(origin: Origin): string {
  if (origin.via === "bundle") {
    return `bundle ${origin.bundle}`;
  }
  if (origin.via === "requires") {
    return `required by ${origin.item}`;
  }
  return `profile ${origin.profile}`;
}

function coordinate(id: string): string {
  const found = byId.value.get(id)?.coordinate;
  if (found === undefined) {
    return "";
  }
  return found.name ?? found.entry?.trim() ?? found.kind;
}
</script>

<template>
  <aside aria-label="Resolution" class="panel rail">
    <h2>Resolution</h2>
    <p v-if="error !== null" class="small severity-warning" role="status">{{ error }}</p>
    <p v-if="preview?.resolution" class="small muted">
      {{ items.length }} items · {{ items.length - unpinned.length }} pinned · {{ unpinned.length }} unpinned
      <br />
      <span class="mono" :title="preview.resolution.revision">{{ preview.resolution.revision.slice(0, 19) }}…</span>
    </p>
    <section class="stack" data-testid="conflicts">
      <h3>Conflicts</h3>
      <p v-if="(preview?.conflicts.length ?? 0) === 0" class="small muted">None.</p>
      <template v-for="group in SEVERITIES" :key="group.severity">
        <div v-if="bySeverity.has(group.severity)" class="stack">
          <strong class="small" :class="`severity-${group.severity}`">
            {{ group.label }} ({{ bySeverity.get(group.severity)?.length }})
          </strong>
          <ul class="conflicts">
            <li
              v-for="conflict in bySeverity.get(group.severity)"
              :key="`${conflict.code} ${conflict.path} ${conflict.message}`"
              class="small"
            >
              <span class="mono" :class="`severity-${conflict.severity}`">{{ conflict.code }}</span>
              <span class="mono muted"> {{ conflict.path }}</span>
              <div>{{ conflict.message }}</div>
            </li>
          </ul>
        </div>
      </template>
    </section>
    <section class="stack">
      <h3>Resolved</h3>
      <ul class="list" data-testid="resolved">
        <li v-for="item in items" :key="item.id" class="small resolved">
          <div class="row">
            <span class="badge">{{ item.kind }}</span>
            <span class="mono">{{ item.id }}</span>
            <span v-if="item.pinned" class="badge info">pinned</span>
          </div>
          <div class="muted">via {{ why(item.origin) }}</div>
          <div
            v-if='coordinate(item.id) !== ""'
            class="mono muted ellipsis"
            :title="coordinate(item.id)"
          >→ {{ coordinate(item.id) }}</div>
        </li>
      </ul>
    </section>
    <section v-if="unpinned.length > 0" class="stack">
      <h3>Unpinned</h3>
      <p class="small muted">Named by id alone: they compile at the shelf's current revision.</p>
      <p class="small mono">{{ unpinned.map((item) => item.id).join(", ") }}</p>
    </section>
  </aside>
</template>

<style scoped>
.rail {
  max-height: calc(100dvh - var(--spacing-size-16) * 2);
  overflow: auto;
}

.conflicts {
  margin: 0;
  padding-inline-start: var(--spacing-size-4);
  display: grid;
  gap: var(--spacing-size-1);
}

.resolved {
  padding: var(--spacing-size-1) 0;
}
</style>
