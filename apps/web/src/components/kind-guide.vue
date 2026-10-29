<script setup lang="ts">
/** What one kind of item is, what the agent gets from it, and an example: the head of a kind's page, or a reminder on an item's. */
import { RouterLink } from "vue-router";

import type { ItemKind } from "../data/shelf.ts";
import { KIND_GUIDES, KINDS, RULES_NOTE } from "../lib/vocabulary.ts";
import InstallPlaces from "./install-places.vue";

const {
  kind,
  shelf,
  compact = false,
} = defineProps<{ kind: ItemKind; shelf: string; compact?: boolean }>();
</script>

<template>
  <aside v-if="compact" class="kind-guide kind-guide--compact panel small" data-testid="kind-guide">
    <p>
      <strong>{{ KINDS[kind].label }}</strong> · {{ KIND_GUIDES[kind].what }}
    </p>
    <p class="muted">
      <strong>What the agent gets:</strong> {{ KIND_GUIDES[kind].gets }}
      <RouterLink
        :to='kind === "prompt"
          ? { name: "prompts", params: { shelf } }
          : { name: "kind", params: { shelf, kind: KIND_GUIDES[kind].slug } }'
      >
        Every {{ KINDS[kind].label.toLowerCase() }} on this shelf
      </RouterLink>
    </p>
  </aside>
  <header v-else class="kind-guide stack" data-testid="kind-guide">
    <h1>{{ KINDS[kind].plural }}</h1>
    <p class="lead">{{ KIND_GUIDES[kind].what }}</p>
    <dl class="kind-guide__facts">
      <dt>What the agent gets</dt>
      <dd>{{ KIND_GUIDES[kind].gets }}</dd>
      <dt>For example</dt>
      <dd>{{ KIND_GUIDES[kind].example }}</dd>
      <dt>Where it goes</dt>
      <dd>
        <InstallPlaces :kind="kind" />
        <p
          v-if='kind === "instructions" || kind === "stack" || kind === "library"'
          class="small muted"
        >
          {{ RULES_NOTE }}
        </p>
      </dd>
    </dl>
  </header>
</template>

<style scoped>
.kind-guide {
  max-width: var(--layout-measure-page);
}

.kind-guide--compact {
  display: grid;
  gap: var(--spacing-size-1);
  padding: var(--spacing-size-2) var(--spacing-size-3);
}

.kind-guide--compact p {
  margin: 0;
}

.lead {
  margin: 0;
  font-size: var(--typography_fluid-sans-text-l);
}

.kind-guide__facts {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--spacing-size-2) var(--spacing-size-4);
  margin: 0;
}

.kind-guide__facts dt {
  color: var(--text-muted);
  font-weight: var(--typography-weight-sans-medium);
}

.kind-guide__facts dd {
  margin: 0;
}
</style>
