<script setup lang="ts">
import { SECTIONS } from "../router.ts";

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="overlay">
    <section aria-labelledby="help-title" aria-modal="true" class="panel help" role="dialog">
      <div class="row">
        <h2 id="help-title">Keyboard</h2>
        <span class="spacer" />
        <button class="quiet" type="button" @click='emit("close")'>Close</button>
      </div>
      <table class="table">
        <tbody>
          <tr>
            <td><kbd>/</kbd></td>
            <td>Focus search</td>
          </tr>
          <tr>
            <td><kbd>j</kbd> <kbd>k</kbd></td>
            <td>Move down and up in the list</td>
          </tr>
          <tr>
            <td><kbd>Enter</kbd> or <kbd>o</kbd></td>
            <td>Open the selected entry</td>
          </tr>
          <tr>
            <td><kbd>x</kbd></td>
            <td>Select the entry (shelf inventory)</td>
          </tr>
          <tr>
            <td><kbd>f</kbd></td>
            <td>Favourite the selected prompt</td>
          </tr>
          <tr>
            <td><kbd>u</kbd> or <kbd>Ctrl</kbd>+<kbd>Z</kbd></td>
            <td>Undo the last delete or removal</td>
          </tr>
          <tr v-for="section in SECTIONS" :key="section.name">
            <td>
              <kbd>g</kbd> <kbd>{{ section.key }}</kbd>
            </td>
            <td>Go to {{ section.title }}</td>
          </tr>
          <tr>
            <td><kbd>Esc</kbd></td>
            <td>Leave a field, close this</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
}

.help {
  border-width: var(--shape-border-thick);
  width: min(var(--shape-measure-prose), 100%);
}
</style>
