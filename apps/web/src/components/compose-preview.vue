<script setup lang="ts">
import { ref } from "vue";

import { copyToClipboard } from "../composables/clipboard.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import type { Preview } from "../composables/use-preview.ts";

const { preview, running } = defineProps<{ preview: Preview | null; running: boolean }>();

const tab = ref<"apm" | "json" | "files">("apm");

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyToClipboard(text);
    notify(`${what} copied.`);
  } catch (error) {
    notifyError(error);
  }
}
</script>

<template>
  <section aria-label="What installing writes" class="panel" :aria-busy="running">
    <div class="row">
      <h2>What installing writes</h2>
      <span class="small muted">updates as the profile changes</span>
      <span class="spacer"></span>
      <div class="tabs" role="tablist">
        <button role="tab" type="button" :aria-selected='tab === "apm"' @click='tab = "apm"'>apm.yml</button>
        <button role="tab" type="button" :aria-selected='tab === "files"' @click='tab = "files"'>
          Copied files ({{ preview?.plan?.files.length ?? 0 }})
        </button>
        <button role="tab" type="button" :aria-selected='tab === "json"' @click='tab = "json"'>Plan JSON</button>
      </div>
    </div>
    <p
      v-if="preview !== null && preview.plan === null"
      class="error-text small"
      data-testid="preview-failed"
    >
      This profile cannot be installed yet: the problems listed beside it say why.
    </p>
    <template v-if="preview?.plan">
      <div v-show='tab === "apm"' class="stack">
        <p class="small muted">
          The manifest written at the root of the repository. <code>apm install</code> reads it and sets up each agent.
        </p>
        <pre data-testid="apm-yml">{{ preview.plan.apmYml }}</pre>
        <div class="row">
          <button type="button" @click='copy(preview.plan.apmYml, "apm.yml")'>Copy apm.yml</button>
          <code class="small">{{ preview.plan.installCommand }}</code>
          <span class="small muted mono" title="A fingerprint of this apm.yml">{{ preview.plan.apmYmlDigest }}</span>
        </div>
      </div>
      <div v-show='tab === "files"' class="stack">
        <p class="small muted">
          Items with nowhere upstream to fetch them from are copied into the repository under
          <code>vendor/{{ preview.plan.profile }}/</code> as a local APM package, which <code>apm.yml</code> lists.
        </p>
        <p v-if="preview.plan.files.length === 0" class="small muted">This profile copies no files.</p>
        <ul class="list">
          <li v-for="file in preview.plan.files" :key="file.path">
            <details>
              <summary class="mono small">{{ file.path }}</summary>
              <pre>{{ file.encoding === "base64" ? "(binary)" : file.contents }}</pre>
            </details>
          </li>
        </ul>
      </div>
      <div v-show='tab === "json"' class="stack">
        <p class="small muted">
          What <code>shelfkit compile --dry-run --json {{ preview.plan.profile }}</code> prints for this profile{{
            preview.planText === null
              ? " (reformatted: the server preview returns the plan as data)"
              : ""
          }}.
        </p>
        <pre data-testid="plan-json">{{ preview.planText ?? JSON.stringify(preview.plan, null, 2) }}</pre>
      </div>
    </template>
  </section>
</template>
