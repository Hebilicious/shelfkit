<script setup lang="ts">
/**
 * An item's content as a person reads it: a library's notes as a list, a stack's conventions as sections, a server's
 * command and settings as a table. The item.json behind it stays one click away, under Files.
 */
import { SecretValueSchema } from "@shelfkit/schema";
import type { Item } from "@shelfkit/schema";
import * as v from "valibot";
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { readItem } from "../api/json.ts";
import { bodyText } from "../lib/prompt.ts";
import ExternalLink from "./external-link.ts";
import MarkdownView from "./markdown-view.ts";

const { shelf, document, body, titles } = defineProps<{
  shelf: string;
  document: unknown;
  body: string | null | undefined;
  /** Titles of the shelf's items by id, for naming the items this one recommends or requires. */
  titles: ReadonlyMap<string, string>;
}>();

const item = computed(() => readItem(document));

interface Markers {
  readonly files?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly packageManager?: string;
}

/** What makes a repository match, as sentences. */
function markerLines(markers: Markers | undefined): string[] {
  if (markers === undefined) {
    return [];
  }
  const lines: string[] = [];
  if ((markers.files?.length ?? 0) > 0) {
    lines.push(`has ${markers.files?.join(", ")}`);
  }
  if ((markers.dependencies?.length ?? 0) > 0) {
    lines.push(`depends on ${markers.dependencies?.join(", ")}`);
  }
  if (markers.packageManager !== undefined) {
    lines.push(`uses ${markers.packageManager}`);
  }
  return lines;
}

const detection = computed(() => {
  const current = item.value;
  if (current === null) {
    return [];
  }
  if (current.kind === "library") {
    return markerLines(current.detect);
  }
  if (current.kind === "stack" || current.kind === "instructions") {
    return markerLines(current.markers);
  }
  return [];
});

interface SettingRow {
  readonly label: string;
  readonly value: string;
}

type SecretValue = v.InferOutput<typeof SecretValueSchema>;

/** A literal value as it is, a secret reference by its name. */
function secretText(value: SecretValue): string {
  return v.is(v.string(), value) ? value : `secret ${value.secret}`;
}

function namedValues(values: Readonly<Record<string, SecretValue>> | undefined): SettingRow[] {
  return Object.entries(values ?? {}).map(([label, value]) => ({
    label,
    value: secretText(value),
  }));
}

type Mcp = Extract<Item, { kind: "mcp" }>;
type Lsp = Extract<Item, { kind: "lsp" }>;

function mcpRows(server: Mcp): SettingRow[] {
  const rows: SettingRow[] = [
    { label: "Runs", value: server.flavour === "stdio" ? "on your machine" : "remotely" },
  ];
  if (server.flavour === "stdio") {
    rows.push(
      { label: "Command", value: [server.command, ...(server.args ?? [])].join(" ") },
      ...namedValues(server.env),
    );
  } else {
    if (server.url !== undefined) {
      rows.push({ label: "URL", value: server.url });
    }
    rows.push(...namedValues(server.headers));
  }
  if (server.flavour !== "hosted" && server.name !== undefined) {
    rows.push({ label: "Registry name", value: server.name });
  }
  if ((server.tools?.length ?? 0) > 0) {
    rows.push({ label: "Tools", value: server.tools?.join(", ") ?? "" });
  }
  return rows;
}

function lspRows(server: Lsp): SettingRow[] {
  return [
    { label: "Server", value: server.name },
    { label: "Command", value: [server.command, ...(server.args ?? [])].join(" ") },
    {
      label: "Languages",
      value: Object.entries(server.extensionToLanguage)
        .map(([extension, language]) => `${extension} → ${language}`)
        .join(", "),
    },
  ];
}

/** Settings of a server item, as label and value. */
const settings = computed<SettingRow[]>(() => {
  const current = item.value;
  if (current?.kind === "mcp") {
    return mcpRows(current);
  }
  if (current?.kind === "lsp") {
    return lspRows(current);
  }
  return [];
});

const requires = computed(() => item.value?.requires ?? []);
const recommends = computed(() =>
  item.value?.kind === "stack" ? (item.value.recommends ?? []) : [],
);
</script>

<template>
  <div class="item-content stack">
    <template v-if='item?.kind === "library"'>
      <section v-if="(item.notes?.length ?? 0) > 0" class="stack">
        <h2>Notes for the agent</h2>
        <ul class="notes">
          <li v-for="(note, at) in item.notes" :key="at"><MarkdownView :source="note" /></li>
        </ul>
      </section>
      <p v-if="item.docs" class="small">
        Documentation: <ExternalLink :address="item.docs" />
      </p>
    </template>
    <template v-else-if='item?.kind === "stack"'>
      <section v-for="(convention, at) in item.conventions ?? []" :key="at" class="stack">
        <h2>{{ convention.heading }}</h2>
        <MarkdownView :source="convention.body" />
      </section>
    </template>
    <template v-else-if='item?.kind === "instructions" && (item.sections?.length ?? 0) > 0'>
      <section v-for="(section, at) in item.sections ?? []" :key="at" class="stack">
        <h2>{{ section.heading }}</h2>
        <MarkdownView :source="section.body" />
      </section>
    </template>
    <table v-if="settings.length > 0" class="table">
      <tbody>
        <tr v-for="row in settings" :key="row.label">
          <th scope="row">{{ row.label }}</th>
          <td class="mono">{{ row.value }}</td>
        </tr>
      </tbody>
    </table>
    <MarkdownView
      v-if='body !== null && body !== undefined && body !== "" && item?.kind !== "skill"'
      class="panel"
      :source="bodyText(body)"
    />
    <section v-if="detection.length > 0" class="panel stack small">
      <strong>Suggested for repositories that</strong>
      <ul class="plain">
        <li v-for="line in detection" :key="line">{{ line }}</li>
      </ul>
      <span class="muted">
        <code>shelfkit recommend</code> and Install look for these to suggest this item.
      </span>
    </section>
    <section v-if="recommends.length > 0 || requires.length > 0" class="stack small">
      <div v-if="requires.length > 0" class="row">
        <strong>Needs</strong>
        <RouterLink v-for="id in requires" :key="id" :to='{ name: "item", params: { shelf, id } }'>
          {{ titles.get(id) ?? id }}
        </RouterLink>
      </div>
      <div v-if="recommends.length > 0" class="row">
        <strong>Goes well with</strong>
        <RouterLink v-for="id in recommends" :key="id" :to='{ name: "item", params: { shelf, id } }'>
          {{ titles.get(id) ?? id }}
        </RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.item-content {
  max-width: var(--layout-measure-page);
}

.notes {
  margin: 0;
  padding-inline-start: var(--spacing-size-6);
  display: grid;
  gap: var(--spacing-size-2);
}

.notes :deep(.markdown > p) {
  margin: 0;
}

.plain {
  margin: 0;
  padding-inline-start: var(--spacing-size-6);
}
</style>
