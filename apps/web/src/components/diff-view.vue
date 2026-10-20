<script setup lang="ts">
import { computed } from "vue";

import { diffLines, diffStat } from "../lib/diff.ts";

const {
  before,
  after,
  label = null,
} = defineProps<{ before: string; after: string; label?: string | null }>();

const lines = computed(() => diffLines(before, after));
const stat = computed(() => diffStat(lines.value));
</script>

<template>
  <div class="diff">
    <div class="row small muted">
      <span v-if="label !== null" class="mono">{{ label }}</span>
      <span class="badge info">+{{ stat.added }}</span>
      <span class="badge danger">−{{ stat.removed }}</span>
    </div>
    <pre class="diff__lines" data-testid="diff"><template v-for="(line, index) in lines" :key="index"><span
      :class="`diff__line diff__line--${line.kind}`">{{ line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  " }}{{ line.text }}
</span></template></pre>
  </div>
</template>

<style scoped>
.diff {
  display: grid;
  gap: var(--spacing-size-1);
}

.diff__lines {
  white-space: pre-wrap;
}

.diff__line {
  display: block;
}

.diff__line--added {
  color: var(--signal-info);
}

.diff__line--removed {
  color: var(--signal-danger);
  text-decoration: line-through;
}
</style>
