<script setup lang="ts">
/** Where `apm install` puts one item, or one kind of item, for each agent. */
import { computed } from "vue";

import type { ItemKind } from "../data/shelf.ts";
import { placesOf } from "../lib/vocabulary.ts";

const { kind, id = "<id>" } = defineProps<{ kind: ItemKind; id?: string }>();

const places = computed(() => placesOf(kind, id));
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
