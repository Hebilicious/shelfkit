<script setup lang="ts">
defineProps<{ loading: boolean; error: string | null; empty?: boolean; emptyText?: string }>();
</script>

<template>
  <p v-if="error !== null" class="error-text small" role="alert">{{ error }}</p>
  <p v-else-if="loading && empty" class="muted small">Loading…</p>
  <p v-else-if="empty" class="muted small">{{ emptyText ?? "Nothing here yet." }}</p>
</template>
