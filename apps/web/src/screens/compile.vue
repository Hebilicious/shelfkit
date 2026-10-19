<script setup lang="ts">
import type { OnConflict, RepositoryOutput } from "@shelfkit/engine";
import { computed, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { execute, messageOf } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { readPlan, readResolution } from "../api/json.ts";
import { CompileQuery, ReportActivityMutation, StackMatchQuery } from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { copyToClipboard } from "../composables/clipboard.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { useQuery } from "../composables/use-query.ts";
import { loadEngine } from "../engine/browser.ts";
import {
  applyOutput,
  canOpenDirectories,
  pickRepository,
  readRepository,
  textDigest,
} from "../lib/repository.ts";
import type { OpenedRepository } from "../lib/repository.ts";
import { param } from "../router.ts";

const shelf = useShelfId();
const route = useRoute();
const router = useRouter();
const profileId = computed(() => param(route.params.profile));

const query = useQuery(async () => {
  const data = await execute(CompileQuery, {
    profile: profileId.value === "" ? "-" : profileId.value,
    shelf: shelf.value,
  });
  return data.shelf;
}, [shelf, profileId]);

const profiles = computed(() => query.data.value?.profiles ?? []);
const profile = computed(() =>
  profileId.value === "" ? null : (query.data.value?.profile ?? null),
);
const plan = computed(() => readPlan(profile.value?.plan.plan?.json ?? null));
const planErrors = computed(() => profile.value?.plan.errors ?? []);
/** The resolved profile's `onConflict`, after `extends`: what the CLI settles a merge by. */
const onConflict = computed<OnConflict>(
  () => readResolution(profile.value?.resolution.json ?? null)?.compile.onConflict ?? "fail",
);

// With no profile chosen, open the shelf's default (or first) one.
watch(
  () => query.data.value,
  (data) => {
    if (profileId.value === "" && data !== null) {
      const [first] = data.profiles;
      if (first !== undefined) {
        void router.replace({ name: "compile", params: { profile: first.id, shelf: shelf.value } });
      }
    }
  },
);

function choose(event: Event): void {
  if (event.target instanceof HTMLSelectElement) {
    void router.push({
      name: "compile",
      params: { profile: event.target.value, shelf: shelf.value },
    });
  }
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyToClipboard(text);
    notify(`${what} copied.`);
  } catch (error) {
    notifyError(error);
  }
}

// The local repository.

const canPick = canOpenDirectories();
const directory = shallowRef<FileSystemDirectoryHandle | null>(null);
const repository = shallowRef<OpenedRepository | null>(null);
const output = shallowRef<RepositoryOutput | null>(null);
const outputErrors = ref<string[]>([]);
const stacks = ref<string[] | null>(null);
const busy = ref(false);
const problem = ref<string | null>(null);
const written = ref(false);

type Match = NonNullable<ResultOf<typeof StackMatchQuery>["shelf"]>["stackMatch"];

async function matchStacks(opened: OpenedRepository): Promise<void> {
  if (opened.packageJson === null) {
    stacks.value = null;
    return;
  }
  try {
    const data = await execute(StackMatchQuery, {
      files: [...opened.rootNames],
      packageJson: opened.packageJson,
      shelf: shelf.value,
    });
    const match: Match | null = data.shelf?.stackMatch ?? null;
    stacks.value = match?.stacks ?? [];
  } catch {
    stacks.value = null;
  }
}

/** Ask the engine what compiling into the opened repository does, exactly as `shelfkit compile --repo` would. */
/** What compiling into a repository would do, or why it cannot be planned. */
interface Planned {
  readonly output: RepositoryOutput | null;
  readonly errors: string[];
}

async function planFor(opened: OpenedRepository | null): Promise<Planned> {
  const current = plan.value;
  if (opened === null || current === null || opened.refusal !== null) {
    return { errors: [], output: null };
  }
  const engine = await loadEngine();
  const result = engine.output(current, opened.snapshot, onConflict.value);
  return result.ok
    ? { errors: [], output: result.value }
    : { errors: result.errors.map((error) => `${error.path}: ${error.message}`), output: null };
}

async function plannedOutput(): Promise<void> {
  output.value = null;
  outputErrors.value = [];
  const planned = await planFor(repository.value);
  output.value = planned.output;
  outputErrors.value = planned.errors;
}

/** The repository changed between opening it and writing: the plan shown was replaced, and nothing was written. */
const changedSinceOpen = ref(false);

async function open(): Promise<void> {
  problem.value = null;
  written.value = false;
  changedSinceOpen.value = false;
  try {
    const handle = await pickRepository();
    busy.value = true;
    directory.value = handle;
    repository.value = await readRepository(handle);
    await Promise.all([plannedOutput(), matchStacks(repository.value)]);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      problem.value = messageOf(error);
    }
  } finally {
    busy.value = false;
  }
}

watch(plan, async () => {
  written.value = false;
  await plannedOutput();
});

/** Write the compile into the repository, then record it as activity: which repository compiled which revision. */
async function write(): Promise<void> {
  const handle = directory.value;
  const planned = output.value;
  const current = plan.value;
  if (handle === null || planned === null || current === null) {
    return;
  }
  busy.value = true;
  problem.value = null;
  changedSinceOpen.value = false;
  try {
    // Read the repository again and plan again right before writing: what was planned when it was opened may no
    // longer fit it. If the plan differs from the one shown, show the new one and write nothing.
    const fresh = await readRepository(handle);
    const replanned = await planFor(fresh);
    repository.value = fresh;
    if (JSON.stringify(replanned.output) !== JSON.stringify(planned)) {
      output.value = replanned.output;
      outputErrors.value = replanned.errors;
      changedSinceOpen.value = true;
      return;
    }
    await applyOutput(handle, planned);
    written.value = true;
    notify(`Wrote ${planned.write.length} files into ${handle.name}.`);
    const manifest = planned.write.find((file) => file.path === "apm.yml");
    await execute(ReportActivityMutation, {
      input: {
        apmYmlDigest:
          manifest === undefined ? current.apmYmlDigest : await textDigest(manifest.contents),
        outcome: "applied",
        profile: current.profile,
        profileRevision: current.profileRevision,
        repository: handle.name,
        shelf: shelf.value,
      },
    });
    repository.value = await readRepository(handle);
    await plannedOutput();
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

function download(): void {
  const current = plan.value;
  if (current === null) {
    return;
  }
  const url = URL.createObjectURL(new Blob([current.apmYml], { type: "text/yaml" }));
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = "apm.yml";
  anchor.click();
  URL.revokeObjectURL(url);
}

const cliCommand = computed(() => `shelfkit compile ${profileId.value} --repo .`);
</script>

<template>
  <main class="page compile">
    <header class="row">
      <h1>Compile</h1>
      <label class="small muted" for="compile-profile">Profile</label>
      <select id="compile-profile" :value="profileId" data-testid="compile-profile" @change="choose">
        <option v-for="entry in profiles" :key="entry.id" :value="entry.id">{{ entry.title }} ({{ entry.id }})</option>
      </select>
    </header>
    <QueryState
      :loading="query.loading.value"
      :error="query.error.value"
      :empty="profiles.length === 0"
      empty-text="This shelf has no profile yet. Compose one first."
    />
    <template v-if="profile !== null">
      <ul v-if="planErrors.length > 0" class="error-text small" role="alert">
        <li v-for="error in planErrors" :key="`${error.path} ${error.message}`">{{ error.path }}: {{ error.message }}</li>
      </ul>
      <div v-if="plan !== null" class="columns">
        <section class="panel">
          <div class="row">
            <h2>1. The manifest</h2>
            <span class="spacer" />
            <button type="button" @click='copy(plan.apmYml, "apm.yml")'>Copy</button>
          </div>
          <pre data-testid="compile-apm-yml">{{ plan.apmYml }}</pre>
          <details v-if="plan.files.length > 0">
            <summary class="small">{{ plan.files.length }} vendored files under <code>vendor/{{ plan.profile }}</code></summary>
            <ul class="small mono">
              <li v-for="file in plan.files" :key="file.path">{{ file.path }}</li>
            </ul>
          </details>
          <ul v-if="plan.notes.length > 0" class="small">
            <li
              v-for="note in plan.notes"
              :key="`${note.code} ${note.path}`"
              class="severity-warning"
            >{{ note.message }}</li>
          </ul>
        </section>
        <section aria-label="Repository" class="panel">
          <h2>2. Your repository</h2>
          <template v-if="canPick">
            <p class="small muted">
              Open a local repository. The browser compiles into it exactly as <code>shelfkit compile</code> does: it merges
              into an existing <code>apm.yml</code> by the profile's <code>onConflict</code> ({{ onConflict }}), writes the
              vendored packages, and never runs APM.
            </p>
            <div class="row">
              <button
                class="primary"
                type="button"
                :disabled="busy"
                data-testid="open-repository"
                @click="open"
              >
                {{ repository === null ? "Open a repository…" : "Open another…" }}
              </button>
              <span v-if="repository !== null" class="mono" data-testid="repository-name">{{ repository.name }}</span>
            </div>
          </template>
          <template v-else>
            <p class="small muted">
              This browser cannot write into a folder. Download the manifest, or run the CLI in the repository:
            </p>
            <div class="row">
              <button type="button" @click="download">Download apm.yml</button>
              <code class="small">{{ cliCommand }}</code>
            </div>
            <p
              v-if="plan.files.length > 0"
              class="small severity-warning"
              data-testid="download-incomplete"
            >
              This manifest installs <code>./vendor/{{ plan.profile }}</code>, whose {{ plan.files.length }} vendored files
              the download does not include: <code>apm install</code> fails without them. Run the CLI command above to
              write them too.
            </p>
          </template>
          <p v-if="problem !== null" class="error-text small" role="alert">{{ problem }}</p>
          <template v-if="repository !== null">
            <p v-if="stacks !== null" class="small" data-testid="repository-stacks">
              <template v-if="stacks.length === 0">No stack of this shelf matches its package.json.</template>
              <template v-else>Matches: <span v-for="stack in stacks" :key="stack" class="chip on">{{ stack }}</span></template>
            </p>
            <p
              v-if="changedSinceOpen"
              class="severity-warning small"
              data-testid="output-changed"
              role="alert"
            >
              The repository changed since it was opened, so nothing was written. This is the plan for it as it is now;
              write again to apply it.
            </p>
            <p v-if="repository.refusal !== null" class="error-text small" role="alert">{{ repository.refusal }}</p>
            <ul
              v-if="outputErrors.length > 0"
              class="error-text small"
              data-testid="output-errors"
              role="alert"
            >
              <li v-for="error in outputErrors" :key="error">{{ error }}</li>
            </ul>
            <template v-if="output !== null">
              <ul
                v-if="output.refused.length > 0"
                class="error-text small"
                data-testid="output-refused"
                role="alert"
              >
                <li v-for="reason in output.refused" :key="reason">{{ reason }}</li>
              </ul>
              <div v-if="output.conflicts.length > 0" class="small severity-warning">
                Settled by <code>onConflict: {{ onConflict }}</code>:
                <ul>
                  <li v-for="conflict in output.conflicts" :key="conflict">{{ conflict }}</li>
                </ul>
              </div>
              <div v-if="output.refused.length === 0" class="stack small" data-testid="output-plan">
                <span>{{ output.write.length }} files to write, {{ output.remove.length }} stale files to remove.</span>
                <details>
                  <summary>Files</summary>
                  <ul class="mono">
                    <li v-for="file in output.write" :key="file.path">+ {{ file.path }}</li>
                    <li v-for="path in output.remove" :key="path" class="severity-error">− {{ path }}</li>
                  </ul>
                </details>
                <div class="row">
                  <button
                    class="primary"
                    type="button"
                    :disabled="busy"
                    data-testid="write-repository"
                    @click="write"
                  >
                    Write into {{ repository.name }}
                  </button>
                  <span v-if="written" class="severity-info" data-testid="written" role="status">Written.</span>
                </div>
              </div>
            </template>
          </template>
        </section>
        <section class="panel">
          <h2>3. Install</h2>
          <p class="small muted">In the repository, APM installs what the manifest declares:</p>
          <div class="row">
            <pre class="install" data-testid="install-command">{{ plan.installCommand }}</pre>
            <button
              class="primary"
              data-testid="copy-install"
              type="button"
              @click='copy(plan.installCommand, "Install command")'
            >
              Copy
            </button>
          </div>
          <p class="small muted">
            Or install the published profile from this shelf's registry as <code>{{ profile.apmCoordinate }}</code>.
          </p>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--layout-measure-pane)), 1fr));
  gap: var(--spacing-size-4);
  align-items: start;
}

.install {
  flex: 1;
}
</style>
