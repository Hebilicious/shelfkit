<script setup lang="ts">
import type { Profile } from "@shelfkit/schema";
import { computed, ref } from "vue";

import type { BundleDocument } from "../api/json.ts";
import type { ProfileOption } from "../api/types.ts";
import { ITEM_DRAG_TYPE } from "../api/types.ts";
import type { IndexItem, ItemKind } from "../data/shelf.ts";
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
import { conflictSentence, KIND_ORDER, KINDS, shortRevision } from "../lib/vocabulary.ts";

const { profile, isNew, inventory, bundles, profiles } = defineProps<{
  profile: Profile;
  isNew: boolean;
  inventory: readonly IndexItem[];
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

interface Entry {
  readonly itemRef: string;
  readonly id: string;
  readonly at: number;
  readonly item: IndexItem | undefined;
}

/**
 * The profile's items grouped by kind, each with its place in the profile's order. The groups follow the kinds'
 * usual order; items no longer on the shelf come last.
 */
const groups = computed(() => {
  const grouped = new Map<ItemKind | "missing", Entry[]>();
  for (const [at, itemRef] of profile.items.entries()) {
    const id = refId(itemRef);
    const item = byId.value.get(id);
    const kind = item?.kind ?? "missing";
    const group = grouped.get(kind) ?? [];
    group.push({ at, id, item, itemRef });
    grouped.set(kind, group);
  }
  const order: readonly (ItemKind | "missing")[] = [...KIND_ORDER, "missing"];
  return order.flatMap((kind) => {
    const entries = grouped.get(kind);
    return entries === undefined
      ? []
      : [{ entries, kind, title: kind === "missing" ? "Not on this shelf" : KINDS[kind].plural }];
  });
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
      <h2>Items in this profile</h2>
      <span class="small muted">{{ profile.items.length }} chosen here</span>
    </div>
    <div
      class="dropzone"
      :class='{ "dropzone--over": dropping === profile.items.length }'
      data-testid="profile-items"
      @dragover.prevent="dropping = profile.items.length"
      @dragleave="dropping = null"
      @drop.prevent="onDrop($event, profile.items.length)"
    >
      <p v-if="profile.items.length === 0" class="muted small">Drop items here, or add them from the list of items on this shelf.</p>
      <div v-for="group in groups" :key="group.kind" class="group">
        <h3 class="small muted">{{ group.title }}</h3>
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
              <span class="mono small muted ellipsis">{{ entry.id }}</span>
              <span v-if="entry.item === undefined" class="badge danger">not on this shelf</span>
              <span class="spacer"></span>
              <button
                class="quiet small"
                type="button"
                :aria-pressed="refRevision(entry.itemRef) !== null"
                :title='refRevision(entry.itemRef) === null
                  ? "Follows the latest version. Click to lock it to the version on the shelf now."
                  : `Locked to version ${shortRevision(refRevision(entry.itemRef) ?? "")}: later edits to the item do not reach repositories until you unlock it.`'
                @click="togglePin(entry.id, entry.itemRef)"
              >
                {{
                  refRevision(entry.itemRef) === null
                    ? "Lock version"
                    : `Locked · ${shortRevision(refRevision(entry.itemRef) ?? "")}`
                }}
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
      <legend>Item groups</legend>
      <p class="small muted">Named groups of items that several profiles share. Ticking one adds every item in it.</p>
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
      <legend>Also include profile</legend>
      <p class="small muted">
        Everything in a profile ticked here is installed too. Where the settings differ, this profile's win.
      </p>
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
      <legend>Install settings</legend>
      <div class="grid">
        <label class="field">
          Package name in apm.yml
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
            placeholder="worked out from the content"
            @input="set({ version: inputValue($event) || undefined })"
          />
        </label>
        <div class="field">
          <label for="compile-pin">Item versions</label>
          <select id="compile-pin" :value='profile.compile.pin ?? ""' @change="setPin">
            <option value="">Respect locked versions (default)</option>
            <option value="revision">Respect locked versions</option>
            <option value="latest">Always the latest, even where locked</option>
          </select>
        </div>
        <div class="field">
          <label for="compile-on-conflict">When the repository already declares the same thing</label>
          <select
            id="compile-on-conflict"
            :value='profile.compile.onConflict ?? ""'
            @change="setOnConflict"
          >
            <option value="">Stop and let me decide (default)</option>
            <option value="fail">Stop and let me decide</option>
            <option value="shelf-wins">Replace it with this shelf's</option>
            <option value="local-wins">Keep the repository's, leave this shelf's out</option>
          </select>
          <span class="small muted">If both declare it, {{ conflictSentence(profile.compile.onConflict ?? "fail") }}.</span>
        </div>
        <div class="field">
          <label for="compile-vendor">Items written on this shelf</label>
          <select
            id="compile-vendor"
            :value='profile.compile.vendorAuthored === undefined
              ? ""
              : profile.compile.vendorAuthored
                ? "yes"
                : "no"'
            @change="setVendorAuthored"
          >
            <option value="">Copy into vendor/{{ profile.id }}/ (default)</option>
            <option value="yes">Copy into vendor/{{ profile.id }}/</option>
            <option value="no">Leave them out</option>
          </select>
          <span class="small muted">
            They have nowhere upstream for APM to fetch them from, so their text is copied into the repository as a
            local APM package.
          </span>
        </div>
      </div>
      <div class="stack">
        <span>Agents to set up</span>
        <span class="small muted">With none chosen, APM sets up every agent it finds in the repository.</span>
        <div aria-label="Agents to set up" class="row" role="group">
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
        <div aria-label="Agents outside the standard set" class="row" role="group">
          <span class="small muted">Outside the OpenAPM v0.1 standard set (<code>shelfkit check</code> reports a profile that uses them):</span>
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
            allow them
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
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--layout-measure-rail)), 1fr));
  gap: var(--spacing-size-3);
}

.wide {
  grid-column: 1 / -1;
}

.dropzone {
  grid-template-columns: minmax(0, 1fr);
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
