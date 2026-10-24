<script setup lang="ts">
/**
 * The files of a skill, beside its SKILL.md: references, scripts, templates. The agent reads SKILL.md when a task calls
 * for the skill, and these only when SKILL.md sends it to them, so the browser shows them the way the folder holds them.
 */
import { computed, ref, watch } from "vue";

import { bodyText } from "../lib/prompt.ts";
import MarkdownView from "./markdown-view.ts";

interface SkillFile {
  readonly path: string;
  readonly contents: string;
  readonly encoding: string;
  readonly size: number;
}

const { files } = defineProps<{ files: readonly SkillFile[] }>();

/** Every file but the item's own record, SKILL.md first, then by path. */
const listed = computed(() => {
  const rest = files.filter((file) => file.path !== "item.json" && file.path !== "SKILL.md");
  const skill = files.filter((file) => file.path === "SKILL.md");
  return [...skill, ...rest.toSorted((a, b) => a.path.localeCompare(b.path))];
});

const selected = ref("SKILL.md");
watch(listed, (list) => {
  if (!list.some((file) => file.path === selected.value)) {
    selected.value = list[0]?.path ?? "";
  }
});

const current = computed(() => listed.value.find((file) => file.path === selected.value) ?? null);

function depth(path: string): number {
  return path.split("/").length - 1;
}

function name(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** The folders a file sits in, shown once above the first file of each. */
function folderBefore(at: number): string | null {
  const path = listed.value[at]?.path ?? "";
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const previous = listed.value[at - 1]?.path ?? "";
  const previousFolder = previous.includes("/") ? previous.slice(0, previous.lastIndexOf("/")) : "";
  return folder !== "" && folder !== previousFolder ? folder : null;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}
</script>

<template>
  <section class="skill-files stack" data-testid="skill-files">
    <h2>Files in this skill <span class="muted">{{ listed.length }}</span></h2>
    <p class="small muted">
      The agent reads SKILL.md when a task calls for the skill, and opens these files only when SKILL.md points it at
      them. They install together, as one folder.
    </p>
    <div class="skill-files__panes panel">
      <ul aria-label="Files" class="skill-files__tree">
        <template v-for="(file, at) in listed" :key="file.path">
          <li v-if="folderBefore(at) !== null" class="skill-files__folder small muted mono">
            {{ folderBefore(at) }}/
          </li>
          <li>
            <button
              class="list-row quiet skill-files__file"
              type="button"
              :class="{ active: file.path === selected }"
              :style="{
                paddingInlineStart: `calc(var(--spacing-size-2) + ${depth(file.path)} * var(--spacing-size-4))`,
              }"
              @click="selected = file.path"
            >
              <span class="mono small ellipsis">{{ name(file.path) }}</span>
              <span class="spacer"></span>
              <span class="small muted">{{ size(file.size) }}</span>
            </button>
          </li>
        </template>
      </ul>
      <div v-if="current !== null" class="skill-files__view">
        <p class="mono small muted">{{ current.path }}</p>
        <p v-if='current.encoding === "base64"' class="muted">A binary file.</p>
        <MarkdownView v-else-if='current.path.endsWith(".md")' :source="bodyText(current.contents)" />
        <pre v-else class="wrap">{{ current.contents }}</pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.skill-files__panes {
  display: grid;
  grid-template-columns: var(--layout-measure-rail) minmax(0, 1fr);
  padding: 0;
  min-height: 0;
}

.skill-files__tree {
  margin: 0;
  padding: var(--spacing-size-2) 0;
  list-style: none;
  border-inline-end: var(--hairline);
  max-height: calc(100dvh - var(--layout-offset-panes));
  overflow: auto;
}

.skill-files__folder {
  padding: var(--spacing-size-2) var(--spacing-size-3) 0;
}

.skill-files__file {
  width: 100%;
  border: none;
  border-radius: 0;
}

.skill-files__view {
  padding: var(--spacing-size-3) var(--spacing-size-4);
  min-width: 0;
  max-height: calc(100dvh - var(--layout-offset-panes));
  overflow: auto;
}

.wrap {
  white-space: pre-wrap;
}
</style>
