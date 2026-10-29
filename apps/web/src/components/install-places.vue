<script setup lang="ts">
/** Where `apm install` puts one item, or one kind of item, for each agent. */
import { computed } from "vue";

import type { ItemKind } from "../data/shelf.ts";
import { placesOf } from "../lib/vocabulary.ts";

const {
  kind,
  id = "<id>",
  path = "<path>",
  docsFolder = "",
} = defineProps<{
  kind: ItemKind;
  id?: string;
  /** A doc's `path`. */
  path?: string;
  /** The profile's docs folder, when the page knows the profile; empty when it does not. */
  docsFolder?: string;
}>();

const places = computed(() =>
  placesOf(kind, id, path).map((place) => ({
    ...place,
    path: docsFolder === "" ? place.path : place.path.replace("<shelf>-<profile>-docs", docsFolder),
  })),
);
</script>

<template>
  <table class="table install-places" data-testid="install-places">
    <tbody>
      <tr v-for="place in places" :key="place.agent">
        <th scope="row">{{ place.agent }}</th>
        <td class="mono">{{ place.path }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.install-places th {
  white-space: nowrap;
  font-weight: var(--typography-weight-sans-medium);
}
</style>
