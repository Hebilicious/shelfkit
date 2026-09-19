<script setup lang="ts">
import { SHELFKIT_ROUTES } from "./routes.ts";
</script>

<template>
  <main class="shell">
    <header class="shell__header">
      <h1 class="shell__title">ShelfKit</h1>
      <p class="shell__subtitle">A shelf of agent context, compiled to APM.</p>
    </header>
    <nav aria-label="Sections" class="shell__nav">
      <ul>
        <li v-for="route in SHELFKIT_ROUTES" :key="route.path">
          <a :href="route.path">{{ route.title }}</a>
          <span class="shell__note">{{ route.note }}</span>
        </li>
      </ul>
    </nav>
  </main>
</template>

<style scoped>
.shell {
  max-width: 52rem;
  margin: 0 auto;
  padding: var(--spacing-size-12) var(--spacing-size-6);
}

.shell__title {
  margin: 0 0 var(--spacing-size-2);
  font-size: var(--typography_fluid-sans-text-2xl);
  font-weight: 650;
}

.shell__subtitle {
  margin: 0 0 var(--spacing-size-12);
  color: var(--text-muted);
}

.shell__nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--spacing-size-1);
}

.shell__nav a {
  color: var(--accent-base);
  text-decoration: none;
  font-weight: 500;
}

.shell__note {
  display: block;
  color: var(--text-muted);
  font-size: var(--typography_fluid-sans-text-s);
}
</style>
