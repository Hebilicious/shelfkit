<script setup lang="ts">
import type { Profile } from "@shelfkit/schema";
import { computed, ref } from "vue";

import type { BundleDocument } from "../api/json.ts";
import type { InventoryItem, ProfileOption } from "../api/types.ts";
import { ITEM_DRAG_TYPE } from "../api/types.ts";
import {
  CANONICAL_TARGETS,
  CLI_ONLY_TARGETS,
  moveItem,
  pinItem,
  refId,
  refRevision,
  slugify,
  toggle,
} from "../lib/profile.ts";

const { profile, isNew, inventory, bundles, profiles } = defineProps<{
  profile: Profile;
  isNew: boolean;
  inventory: readonly InventoryItem[];
  bundles: readonly BundleDocument[];
  profiles: readonly ProfileOption[];
}>();
const emit = defineEmits<{
  update: [profile: Profile];
  remove: [id: string];
  place: [id: string, at: number];
}>();

const byId = computed(() => new Map(inventory.map((item) => [item.id, item])));
const idTouched = ref(!isNew);

type Compile = Profile["compile"];

function set(patch: Partial<Profile>): void {
  emit("update", { ...profile, ...patch });
}

function setCompile(patch: Partial<Compile>): void {
  const compile: Compile = { ...profile.compile, ...patch };
  emit("update", { ...profile, compile });
}

function setTitle(title: string): void {
  if (isNew && !idTouched.value) {
    set({ id: slugify(title) || "new-profile", title });
  } else {
    set({ title });
  }
}

/** The profile's items grouped by kind, each with its place in the profile's order. */
const groups = computed(() => {
  const grouped = new Map<
    string,
    { itemRef: string; id: string; at: number; item: InventoryItem | undefined }[]
  >();
  for (const [at, itemRef] of profile.items.entries()) {
    const id = refId(itemRef);
    const item = byId.value.get(id);
    const kind = item?.kind ?? "missing";
    const group = grouped.get(kind) ?? [];
    group.push({ at, id, item, itemRef });
    grouped.set(kind, group);
  }
  return [...grouped.entries()].map(([kind, entries]) => ({ entries, kind }));
});

const dropping = ref<number | null>(null);

function onDragStart(event: DragEvent, id: string): void {
  event.dataTransfer?.setData(ITEM_DRAG_TYPE, id);
}

function onDrop(event: DragEvent, at: number): void {
  dropping.value = null;
  const id = event.dataTransfer?.getData(ITEM_DRAG_TYPE) ?? "";
  if (id !== "") {
    emit("place", id, at);
  }
}

function togglePin(id: string, itemRef: string): void {
  const current = byId.value.get(id)?.revision ?? null;
  emit("update", pinItem(profile, id, refRevision(itemRef) === null ? current : null));
}

const targets = computed(() => profile.compile.targets ?? []);

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : "";
}

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
    ? event.target.value
    : "";
}

function setPin(event: Event): void {
  const value = selectValue(event);
  setCompile({ pin: value === "revision" || value === "latest" ? value : undefined });
}

function setOnConflict(event: Event): void {
  const value = selectValue(event);
  setCompile({
    onConflict:
      value === "fail" || value === "shelf-wins" || value === "local-wins" ? value : undefined,
  });
}

function setVendorAuthored(event: Event): void {
  const value = selectValue(event);
  setCompile({ vendorAuthored: value === "" ? undefined : value === "yes" });
}

function setTargets(slug: string): void {
  const next = toggle(targets.value, slug);
  setCompile({ targets: next.length === 0 ? undefined : next });
}
</script>

<template>
  <section aria-label="Profile" class="panel profile">
    <div class="grid">
      <label class="field">
        Title
        <input :value="profile.title" name="title" @input="setTitle(inputValue($event))" />
      </label>
      <label class="field">
        Id
        <input
          :value="profile.id"
          class="mono"
          name="id"
          :readonly="!isNew"
          @input="
            idTouched = true;
            set({ id: inputValue($event) });
          "
        />
      </label>
      <label class="field wide">
        Description
        <input
          :value='profile.description ?? ""'
          name="description"
          @input="set({ description: inputValue($event) })"
        />
      </label>
    </div>
    <div class="items-head row">
      <h2>Items</h2>
      <span class="small muted">{{ profile.items.length }} named directly</span>
    </div>
    <div
      class="dropzone"
      :class='{ "dropzone--over": dropping === profile.items.length }'
      data-testid="profile-items"
      @dragover.prevent="dropping = profile.items.length"
      @dragleave="dropping = null"
      @drop.prevent="onDrop($event, profile.items.length)"
    >
      <p v-if="profile.items.length === 0" class="muted small">Drop items here, or add them from the inventory.</p>
      <div v-for="group in groups" :key="group.kind" class="group">
        <h3 class="small muted">{{ group.kind }}</h3>
        <ul class="list">
          <li
            v-for="entry in group.entries"
            :key="entry.id"
            draggable="true"
            :class='{ "drop-before": dropping === entry.at }'
            :data-profile-item="entry.id"
            @dragstart="onDragStart($event, entry.id)"
            @dragover.prevent.stop="dropping = entry.at"
            @drop.prevent.stop="onDrop($event, entry.at)"
          >
            <div class="list-row">
              <span class="ellipsis">{{ entry.item?.title ?? entry.id }}</span>
              <span class="mono small muted">{{ entry.id }}</span>
              <span v-if="entry.item === undefined" class="badge danger">not in the shelf</span>
              <span class="spacer" />
              <button
                class="quiet small"
                type="button"
                :aria-pressed="refRevision(entry.itemRef) !== null"
                :title='refRevision(entry.itemRef) === null
                  ? "Pin to the current revision"
                  : `Pinned to ${refRevision(entry.itemRef)}`'
                @click="togglePin(entry.id, entry.itemRef)"
              >
                {{ refRevision(entry.itemRef) === null ? "pin" : "pinned" }}
              </button>
              <button
                class="quiet small"
                type="button"
                :aria-label="`Move ${entry.id} up`"
                @click='emit("update", moveItem(profile, entry.id, -1))'
              >
                ↑
              </button>
              <button
                class="quiet small"
                type="button"
                :aria-label="`Move ${entry.id} down`"
                @click='emit("update", moveItem(profile, entry.id, 1))'
              >
                ↓
              </button>
              <button
                class="quiet small danger"
                type="button"
                :aria-label="`Remove ${entry.id}`"
                @click='emit("remove", entry.id)'
              >
                ✕
              </button>
            </div>
          </li>
        </ul>
      </div>
    </div>
    <fieldset v-if="bundles.length > 0">
      <legend>Bundles</legend>
      <label v-for="bundle in bundles" :key="bundle.id" class="row small">
        <input
          type="checkbox"
          :checked="profile.bundles.includes(bundle.id)"
          @change="set({ bundles: toggle(profile.bundles, bundle.id) })"
        />
        {{ bundle.title }} <span class="muted">({{ bundle.items.length }} items)</span>
      </label>
    </fieldset>
    <fieldset v-if="profiles.length > 0">
      <legend>Extends</legend>
      <label v-for="other in profiles" :key="other.id" class="row small">
        <input
          type="checkbox"
          :checked="profile.extends.includes(other.id)"
          @change="set({ extends: toggle(profile.extends, other.id) })"
        />
        {{ other.title }} <span class="mono muted">{{ other.id }}</span>
      </label>
    </fieldset>
    <fieldset>
      <legend>Compile</legend>
      <div class="grid">
        <label class="field">
          Package name
          <input
            :value='profile.compile.name ?? ""'
            placeholder="the profile id"
            @input="setCompile({ name: inputValue($event) || undefined })"
          />
        </label>
        <label class="field">
          Version
          <input
            :value='profile.version ?? ""'
            placeholder="from the revision"
            @input="set({ version: inputValue($event) || undefined })"
          />
        </label>
        <div class="field">
          <label for="compile-pin">Pin</label>
          <select id="compile-pin" :value='profile.compile.pin ?? ""' @change="setPin">
            <option value="">default (revision)</option>
            <option value="revision">revision</option>
            <option value="latest">latest</option>
          </select>
        </div>
        <div class="field">
          <label for="compile-on-conflict">On conflict</label>
          <select
            id="compile-on-conflict"
            :value='profile.compile.onConflict ?? ""'
            @change="setOnConflict"
          >
            <option value="">default (fail)</option>
            <option value="fail">fail</option>
            <option value="shelf-wins">shelf wins</option>
            <option value="local-wins">local wins</option>
          </select>
        </div>
        <div class="field">
          <label for="compile-vendor">Vendor authored items</label>
          <select
            id="compile-vendor"
            :value='profile.compile.vendorAuthored === undefined
              ? ""
              : profile.compile.vendorAuthored
                ? "yes"
                : "no"'
            @change="setVendorAuthored"
          >
            <option value="">default</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </div>
      </div>
      <div class="stack">
        <span class="small muted">Targets (none: APM detects the harnesses)</span>
        <div aria-label="Targets" class="row" role="group">
          <button
            v-for="slug in CANONICAL_TARGETS"
            :key="slug"
            class="chip"
            type="button"
            :aria-pressed="targets.includes(slug)"
            @click="setTargets(slug)"
          >
            {{ slug }}
          </button>
        </div>
        <div aria-label="Targets outside the producer set" class="row" role="group">
          <span class="small muted">Outside the OpenAPM v0.1 producer set:</span>
          <button
            v-for="slug in CLI_ONLY_TARGETS"
            :key="slug"
            class="chip"
            type="button"
            :aria-pressed="targets.includes(slug)"
            @click="setTargets(slug)"
          >
            {{ slug }}
          </button>
          <label class="row small">
            <input
              type="checkbox"
              :checked="profile.compile.allowNonconformantTargets === true"
              @change="setCompile({
                allowNonconformantTargets: profile.compile.allowNonconformantTargets === true ? undefined : true,
              })"
            />
            opt in
          </label>
        </div>
      </div>
    </fieldset>
  </section>
</template>

<style scoped>
.profile {
  min-width: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--layout-measure-rail), 1fr));
  gap: var(--spacing-size-3);
}

.wide {
  grid-column: 1 / -1;
}

.dropzone {
  min-height: var(--spacing-size-16);
  padding: var(--spacing-size-2);
  border: var(--layout-border-thick) dashed var(--border-subtle);
  border-radius: var(--layout-radius-m);
  display: grid;
  gap: var(--spacing-size-2);
}

.dropzone--over {
  border-color: var(--accent-base);
}

.drop-before {
  box-shadow: inset 0 var(--layout-border-thick) 0 var(--accent-base);
}

.group h3 {
  text-transform: uppercase;
}

li[draggable="true"] {
  cursor: grab;
}
</style>
