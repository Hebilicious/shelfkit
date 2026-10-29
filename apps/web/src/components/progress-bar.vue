<script setup lang="ts">
/**
 * A thin bar under the header while a screen waits for something it has never loaded. It appears only after a short
 * delay, so a fast answer never flashes it, and never for a refresh behind data already on screen.
 */
import { onBeforeUnmount, ref, watch } from "vue";

import { blockingLoads } from "../data/cache.ts";

const DELAY_MS = 150;
const shown = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

watch(blockingLoads, (count) => {
  clearTimeout(timer);
  if (count === 0) {
    shown.value = false;
    return;
  }
  timer = setTimeout(() => {
    shown.value = blockingLoads.value > 0;
  }, DELAY_MS);
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div aria-hidden="true" class="progress" :class='{ "progress--shown": shown }'></div>
</template>

<style scoped>
.progress {
  position: fixed;
  inset-block-start: 0;
  inset-inline: 0;
  block-size: var(--layout-border-thick);
  background: var(--accent-base);
  opacity: 0;
  transform-origin: 0;
  transform: scaleX(.2);
  pointer-events: none;
}

.progress--shown {
  opacity: 1;
  animation: 1.2s ease-out infinite progress;
}

@keyframes progress {
  from {
    transform: scaleX(.1);
  }

  to {
    transform: scaleX(.9);
  }
}
</style>
