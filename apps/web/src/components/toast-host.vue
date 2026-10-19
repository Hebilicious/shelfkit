<script setup lang="ts">
import { runUndo, toasts } from "../composables/toasts.ts";
</script>

<template>
  <div aria-live="polite" class="toasts">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class='{ "toast--error": toast.tone === "error" }'
      role="status"
    >
      <span>{{ toast.message }}</span>
      <button v-if="toast.undo !== null" class="primary" type="button" @click="runUndo(toast.id)">Undo</button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  inset-block-end: var(--spacing-size-4);
  inset-inline-end: var(--spacing-size-4);
  display: grid;
  gap: var(--spacing-size-2);
  max-width: var(--shape-measure-prose);
}

.toast {
  display: flex;
  align-items: center;
  gap: var(--spacing-size-3);
  padding: var(--spacing-size-2) var(--spacing-size-3);
  border: var(--hairline);
  border-radius: var(--shape-radius-m);
  background: var(--surface-raised);
  font-size: var(--typography_fluid-sans-text-s);
}

.toast--error {
  color: var(--signal-danger);
}
</style>
