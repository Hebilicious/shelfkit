<script setup lang="ts">
import type { ConflictSeverity as Severity } from "@shelfkit/engine";
import { computed } from "vue";

import type { Preview } from "../composables/use-preview.ts";
import type { IndexItem } from "../data/shelf.ts";
import { KINDS, shortRevision } from "../lib/vocabulary.ts";

const { preview, inventory, error, profile } = defineProps<{
  preview: Preview | null;
  inventory: readonly IndexItem[];
  error: string | null;
  /** The id of the profile being edited, to tell its own items from those another profile brings in. */
  profile: string;
}>();

const byId = computed(() => new Map(inventory.map((item) => [item.id, item])));
const items = computed(() => preview?.resolution?.items ?? []);
const following = computed(() => items.value.filter((item) => !item.pinned));

const SEVERITIES: readonly { severity: Severity; label: string }[] = [
  { label: "Must fix before it installs", severity: "error" },
  { label: "Warnings", severity: "warning" },
  { label: "Notes", severity: "info" },
];

const bySeverity = computed(() => {
  const groups = new Map<Severity, Preview["conflicts"][number][]>();
  for (const conflict of preview?.conflicts ?? []) {
    groups.set(conflict.severity, [...(groups.get(conflict.severity) ?? []), conflict]);
  }
  return groups;
});

type Origin = NonNullable<Preview["resolution"]>["items"][number]["origin"];

/** Why an item is in the profile: chosen here, or brought in by a group, another item, or another profile. */
function why(origin: Origin): string {
  if (origin.via === "bundle") {
    return `from the group ${origin.bundle}`;
  }
  if (origin.via === "requires") {
    return `needed by ${titleOf(origin.item)}`;
  }
  return origin.profile === profile ? "chosen here" : `from the profile ${origin.profile}`;
}

function titleOf(id: string): string {
  return byId.value.get(id)?.title ?? id;
}

/** Where the item lands in the repository, in a few words. */
function installsAs(id: string): string {
  const found = byId.value.get(id)?.coordinate;
  if (found === undefined) {
    return "";
  }
  if (found.kind === "vendored") {
    return `copied into vendor/${profile}/`;
  }
  if (found.kind === "unresolvable") {
    return "cannot be installed: nowhere to fetch it from";
  }
  return found.name ?? found.entry?.trim() ?? "";
}
</script>

<template>
  <aside aria-label="What this profile installs" class="panel rail">
    <h2>What this profile installs</h2>
    <p v-if="error !== null" class="small severity-warning" role="status">{{ error }}</p>
    <p v-if="preview?.resolution" class="small muted">
      {{ items.length }} {{ items.length === 1 ? "item" : "items" }}: {{ items.length - following.length }} locked to a
      version, {{ following.length }} following the latest.
      <br />
      <span :title="preview.resolution.revision">Profile version <span class="mono">{{ shortRevision(preview.resolution.revision) }}</span></span>
    </p>
    <section class="stack" data-testid="conflicts">
      <h3>Problems</h3>
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
              <div>{{ conflict.message }}</div>
              <div class="mono muted" :title="conflict.code">{{ conflict.path }}</div>
            </li>
          </ul>
        </div>
      </template>
    </section>
    <section class="stack">
      <h3>Items</h3>
      <ul class="list" data-testid="resolved">
        <li v-for="item in items" :key="item.id" class="small resolved">
          <div class="row">
            <span class="badge">{{ KINDS[item.kind].label }}</span>
            <span>{{ titleOf(item.id) }}</span>
            <span class="mono muted">{{ item.id }}</span>
            <span
              v-if="item.pinned"
              class="badge info"
              :title="`Locked to version ${shortRevision(item.revision)}`"
            >locked</span>
          </div>
          <div class="muted">{{ why(item.origin) }}</div>
          <div
            v-if='installsAs(item.id) !== ""'
            class="mono muted ellipsis"
            :title="installsAs(item.id)"
          >→ {{ installsAs(item.id) }}</div>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.rail {
  min-width: 0;
  overflow-wrap: anywhere;
  max-height: calc(100dvh - var(--layout-offset-panes));
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
