<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";

import KeyboardHelp from "./components/keyboard-help.vue";
import ProgressBar from "./components/progress-bar.vue";
import ToastHost from "./components/toast-host.vue";
import {
  favouriteSelection,
  moveSelection,
  openSelection,
  selectSelection,
} from "./composables/list-nav.ts";
import { loadSession, shelves, signOut, viewer, viewerName } from "./composables/session.ts";
import { notifyError, undoLatest } from "./composables/toasts.ts";
import { INITIAL_KEY_STATE, interpret } from "./lib/keys.ts";
import type { KeyAction, KeyState } from "./lib/keys.ts";
import { param, sectionRoute } from "./navigation.ts";

const route = useRoute();
const router = useRouter();
const helpOpen = ref(false);
let keyState: KeyState = INITIAL_KEY_STATE;

const currentShelf = computed(() => {
  const fromRoute = param(route.params.shelf);
  return fromRoute === "" ? (shelves.value[0]?.id ?? null) : fromRoute;
});

function isField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement;
}

function perform(action: KeyAction, event: KeyboardEvent): void {
  switch (action.kind) {
    case "focus-search": {
      const search = document.querySelector<HTMLInputElement>("[data-search]");
      if (search !== null) {
        event.preventDefault();
        search.focus();
        search.select();
      }
      return;
    }
    case "go": {
      if (currentShelf.value !== null) {
        void router.push(sectionRoute(currentShelf.value, action.to));
      }
      return;
    }
    case "move": {
      event.preventDefault();
      moveSelection(action.by);
      return;
    }
    case "open": {
      if (!isControl(event.target)) {
        openSelection();
      }
      return;
    }
    case "select": {
      selectSelection();
      return;
    }
    case "favourite": {
      favouriteSelection();
      return;
    }
    case "undo": {
      event.preventDefault();
      void undoLatest();
      return;
    }
    case "help": {
      helpOpen.value = !helpOpen.value;
      return;
    }
    case "escape": {
      helpOpen.value = false;
      if (isField(event.target) && event.target instanceof HTMLElement) {
        event.target.blur();
      }
      break;
    }
    default:
    // Every action is handled above.
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.defaultPrevented) {
    return;
  }
  const result = interpret(keyState, {
    altKey: event.altKey,
    at: event.timeStamp,
    ctrlKey: event.ctrlKey,
    inField: isField(event.target),
    key: event.key,
    metaKey: event.metaKey,
  });
  keyState = result.state;
  if (result.action !== null) {
    perform(result.action, event);
  }
}

async function leave(): Promise<void> {
  try {
    await signOut();
    await router.push({ name: "sign-in" });
  } catch (error) {
    notifyError(error);
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void loadSession();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="app">
    <ProgressBar />
    <header class="app__header">
      <RouterLink class="app__brand" to="/">ShelfKit</RouterLink>
      <span class="spacer"></span>
      <button
        class="quiet small"
        title="Keyboard shortcuts (?)"
        type="button"
        @click="helpOpen = true"
      >
        <kbd>?</kbd> Keys
      </button>
      <template v-if="viewer?.authenticated">
        <span class="small muted" data-testid="viewer">
          {{ viewerName(viewer) }}
        </span>
        <button class="quiet small" type="button" @click="leave">Sign out</button>
      </template>
      <RouterLink v-else-if='route.name !== "sign-in"' class="button small" :to='{ name: "sign-in" }'>
        Sign in
      </RouterLink>
    </header>
    <RouterView />
    <KeyboardHelp v-if="helpOpen" @close="helpOpen = false" />
    <ToastHost />
  </div>
</template>

<style scoped>
.app {
  min-height: 100dvh;
  display: grid;
  grid-template-rows: auto 1fr;
}

.app__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-size-3);
  padding: var(--spacing-size-2) var(--spacing-size-6);
  border-bottom: var(--hairline);
  background: var(--surface-raised);
}

.app__brand {
  color: var(--text-primary);
  font-weight: var(--typography-weight-sans-bold);
  text-decoration: none;
}
</style>
