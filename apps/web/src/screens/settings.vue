<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import { readSources } from "../api/json.ts";
import type { ShelfSourceEntry } from "../api/json.ts";
import {
  CreateKeyMutation,
  CreateShareLinkMutation,
  PutSecretNameMutation,
  PutSourceMutation,
  RemoveSecretNameMutation,
  RemoveSourceMutation,
  RevokeKeyMutation,
  RevokeShareLinkMutation,
  SetVisibilityMutation,
  SettingsQuery,
} from "../api/operations.ts";
import QueryState from "../components/query-state.vue";
import { copyToClipboard } from "../composables/clipboard.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { useQuery } from "../composables/use-query.ts";

const shelf = useShelfId();

const query = useQuery(async () => {
  const data = await execute(SettingsQuery, { shelf: shelf.value });
  return data;
}, [shelf]);

const settings = computed(() => query.data.value?.shelf ?? null);
const owner = computed(() => settings.value?.viewerAccess.owner === true);
const canWrite = computed(() => settings.value?.viewerAccess.write === true);
const sources = computed(() => readSources(settings.value?.sources ?? null));
const shareLinks = computed(() => query.data.value?.shareLinks ?? []);

async function copy(text: string, what: string): Promise<void> {
  try {
    await copyToClipboard(text);
    notify(`${what} copied.`);
  } catch (error) {
    notifyError(error);
  }
}

function when(timestamp: string | null | undefined): string {
  return timestamp === null || timestamp === undefined
    ? "never"
    : new Date(timestamp).toLocaleString();
}

/** An action that cannot be undone asks twice: the first click arms it, the second does it. */
const armed = ref<string | null>(null);

function confirmFirst(key: string): boolean {
  if (armed.value === key) {
    armed.value = null;
    return true;
  }
  armed.value = key;
  return false;
}

// Registry visibility: reversible, so it is undone rather than confirmed.

async function setVisibility(isPublic: boolean): Promise<void> {
  const shelfId = shelf.value;
  try {
    const data = await execute(SetVisibilityMutation, { public: isPublic, shelf: shelfId });
    if (!data.setVisibility.ok) {
      notify(data.setVisibility.reason ?? "the shelf refused the change", null, "error");
      return;
    }
    await query.refresh();
    notify(
      isPublic ? "The registry now serves anonymous reads." : "The registry now needs a key.",
      async () => {
        await execute(SetVisibilityMutation, { public: !isPublic, shelf: shelfId });
        await query.refresh();
      },
    );
  } catch (error) {
    notifyError(error);
  }
}

// Keys.

interface KeyForm {
  name: string;
  scopes: string[];
}

const keyForm = reactive<KeyForm>({ name: "", scopes: [] });
const newSecret = ref<string | null>(null);

const scopeChoices = computed(() => {
  const id = shelf.value;
  const profiles = settings.value?.profiles ?? [];
  return [
    { label: "Read the shelf", scope: "read" },
    { label: "Write the shelf", scope: `publish:${id}/*` },
    ...profiles.flatMap((profile) => [
      { label: `Install ${profile.title} from the registry`, scope: `read:${id}/${profile.id}` },
      { label: `Publish and edit ${profile.title}`, scope: `publish:${id}/${profile.id}` },
    ]),
  ];
});

async function createKey(): Promise<void> {
  try {
    const data = await execute(CreateKeyMutation, {
      name: keyForm.name.trim(),
      scopes: keyForm.scopes,
      shelf: shelf.value,
    });
    newSecret.value = data.createKey.secret;
    keyForm.name = "";
    keyForm.scopes = [];
    await query.refresh();
  } catch (error) {
    notifyError(error);
  }
}

async function revokeKey(id: string): Promise<void> {
  if (!confirmFirst(`key:${id}`)) {
    return;
  }
  try {
    await execute(RevokeKeyMutation, { id, shelf: shelf.value });
    notify("Key revoked. It fails everywhere from the next request.");
    await query.refresh();
  } catch (error) {
    notifyError(error);
  }
}

// Share links.

const shareProfile = ref("");
const newShareUrl = ref<string | null>(null);

async function createShareLink(): Promise<void> {
  try {
    const data = await execute(CreateShareLinkMutation, {
      profile: shareProfile.value,
      shelf: shelf.value,
    });
    newShareUrl.value = `${window.location.origin}/share/${data.createShareLink.token}`;
    await query.refresh();
  } catch (error) {
    notifyError(error);
  }
}

async function revokeShareLink(id: string): Promise<void> {
  if (!confirmFirst(`share:${id}`)) {
    return;
  }
  try {
    await execute(RevokeShareLinkMutation, { id, shelf: shelf.value });
    notify("Share link revoked.");
    await query.refresh();
  } catch (error) {
    notifyError(error);
  }
}

// Sources: removing one is undone by putting it back.

const SOURCE_KINDS = ["git", "apm-registry", "shelfkit", "catalog", "marketplace", "path"] as const;
const sourceForm = reactive({
  id: "",
  kind: "git",
  path: "",
  profile: "",
  repo: "",
  secret: "",
  url: "",
});
const sourceError = ref<string | null>(null);

function sourceEntry(): ShelfSourceEntry {
  const entry: ShelfSourceEntry = { id: sourceForm.id.trim(), kind: sourceForm.kind };
  for (const field of ["repo", "url", "path", "profile", "secret"] as const) {
    const value = sourceForm[field].trim();
    if (value !== "") {
      entry[field] = value;
    }
  }
  return entry;
}

async function putSource(entry: ShelfSourceEntry): Promise<boolean> {
  const data = await execute(PutSourceMutation, { shelf: shelf.value, source: entry });
  const result = data.putSource;
  if (!result.ok) {
    sourceError.value =
      result.errors.map((error) => `${error.path}: ${error.message}`).join("\n") ||
      (result.reason ?? "refused");
    return false;
  }
  return true;
}

async function addSource(): Promise<void> {
  sourceError.value = null;
  try {
    if (await putSource(sourceEntry())) {
      Object.assign(sourceForm, { id: "", path: "", profile: "", repo: "", secret: "", url: "" });
      await query.refresh();
    }
  } catch (error) {
    sourceError.value = messageOf(error);
  }
}

async function removeSource(entry: ShelfSourceEntry): Promise<void> {
  try {
    const data = await execute(RemoveSourceMutation, { id: entry.id, shelf: shelf.value });
    if (!data.removeSource.ok) {
      notify(data.removeSource.reason ?? "the shelf refused the change", null, "error");
      return;
    }
    await query.refresh();
    notify(`Removed the source ${entry.id}.`, async () => {
      if (!(await putSource(entry))) {
        throw new Error(sourceError.value ?? "the shelf refused to restore it");
      }
      await query.refresh();
    });
  } catch (error) {
    notifyError(error);
  }
}

// Secret names: the name and the one origin its value may go to. Values are Worker secrets, never typed here.

const secretForm = reactive({ description: "", name: "", origin: "" });

async function putSecretName(
  name: string,
  origin: string,
  description: string | null,
): Promise<void> {
  await execute(PutSecretNameMutation, { description, name, origin, shelf: shelf.value });
}

async function addSecretName(): Promise<void> {
  try {
    await putSecretName(
      secretForm.name.trim(),
      secretForm.origin.trim(),
      secretForm.description.trim() === "" ? null : secretForm.description.trim(),
    );
    Object.assign(secretForm, { description: "", name: "", origin: "" });
    await query.refresh();
  } catch (error) {
    notifyError(error);
  }
}

async function removeSecretName(
  name: string,
  origin: string | null,
  description: string | null,
): Promise<void> {
  try {
    await execute(RemoveSecretNameMutation, { name, shelf: shelf.value });
    await query.refresh();
    notify(
      `Removed the secret name ${name}.`,
      origin === null
        ? null
        : async () => {
            await putSecretName(name, origin, description);
            await query.refresh();
          },
    );
  } catch (error) {
    notifyError(error);
  }
}
</script>

<template>
  <main class="page settings">
    <h1>Settings</h1>
    <QueryState :loading="query.loading.value" :error="query.error.value" :empty="settings === null" />
    <template v-if="settings !== null">
      <section class="panel">
        <h2>Registry</h2>
        <div class="row">
          <span class="small muted">APM's <code>registries</code> entry for this deployment:</span>
          <code data-testid="registry-url">{{ settings.registryUrl }}</code>
          <button class="small" type="button" @click='copy(settings.registryUrl, "Registry URL")'>Copy</button>
        </div>
        <div class="row">
          <span>
            The registry is <strong>{{ settings.public ? "public" : "private" }}</strong>:
            {{ settings.public ? "anyone can install this shelf's profiles." : "installing needs a key." }}
          </span>
          <button
            v-if="owner"
            data-testid="toggle-visibility"
            type="button"
            @click="setVisibility(!settings.public)"
          >
            Make it {{ settings.public ? "private" : "public" }}
          </button>
        </div>
        <p class="small muted">Storage used by the shelf's database: {{ Math.round(settings.databaseBytes / 1024) }} KiB.</p>
      </section>
      <section v-if="owner" class="panel">
        <h2>Keys</h2>
        <p class="small muted">
          A key is shown once, when it is created. Give the CLI or an agent one with only the scopes it needs.
        </p>
        <div v-if="newSecret !== null" class="panel secret" role="status">
          <strong>Copy this key now; it is not shown again.</strong>
          <div class="row">
            <code class="mono" data-testid="new-key">{{ newSecret }}</code>
            <button class="primary" type="button" @click='copy(newSecret, "Key")'>Copy</button>
            <button class="quiet" type="button" @click="newSecret = null">Done</button>
          </div>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th><span class="visually-hidden">Revoke</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in settings.keys" :key="key.id">
              <td>{{ key.name }}</td>
              <td class="mono">{{ key.prefix }}…</td>
              <td class="mono small">{{ key.scopes.join(" ") }}</td>
              <td class="small">{{ when(key.lastUsedAt) }}</td>
              <td>
                <span v-if="key.revokedAt" class="badge danger">revoked</span>
                <button v-else class="danger small" type="button" @click="revokeKey(key.id)">
                  {{ armed === `key:${key.id}` ? "Revoke: sure?" : "Revoke" }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <form class="stack" @submit.prevent="createKey">
          <label class="field">New key's name <input v-model="keyForm.name" placeholder="laptop CLI" required /></label>
          <fieldset>
            <legend>Scopes</legend>
            <label v-for="choice in scopeChoices" :key="choice.scope" class="row small">
              <input v-model="keyForm.scopes" type="checkbox" :value="choice.scope" />
              {{ choice.label }} <code class="muted">{{ choice.scope }}</code>
            </label>
          </fieldset>
          <div class="row">
            <button class="primary" type="submit" :disabled="keyForm.scopes.length === 0">Create key</button>
          </div>
        </form>
      </section>
      <section class="panel">
        <h2>Share links</h2>
        <p class="small muted">An unguessable, read-only page for one profile. Anyone with the link can read it, with no key.</p>
        <div v-if="newShareUrl !== null" class="panel secret" role="status">
          <strong>The link is shown once.</strong>
          <div class="row">
            <code data-testid="share-url">{{ newShareUrl }}</code>
            <button class="primary" type="button" @click='copy(newShareUrl, "Share link")'>Copy</button>
            <button class="quiet" type="button" @click="newShareUrl = null">Done</button>
          </div>
        </div>
        <ul class="list">
          <li v-for="link in shareLinks" :key="link.id" class="list-row">
            <span>{{ link.profile }}</span>
            <span class="small muted">created {{ when(link.createdAt) }}</span>
            <span class="spacer"></span>
            <span v-if="link.revokedAt" class="badge danger">revoked</span>
            <button v-else class="danger small" type="button" @click="revokeShareLink(link.id)">
              {{ armed === `share:${link.id}` ? "Revoke: sure?" : "Revoke" }}
            </button>
          </li>
        </ul>
        <form class="row" @submit.prevent="createShareLink">
          <label class="small" for="share-profile">Share</label>
          <select id="share-profile" v-model="shareProfile" required>
            <option disabled value="">a profile…</option>
            <option v-for="profile in settings.profiles" :key="profile.id" :value="profile.id">{{ profile.title }}</option>
          </select>
          <button type="submit" :disabled='shareProfile === ""' data-testid="create-share">Create link</button>
        </form>
      </section>
      <section class="panel">
        <h2>Sources</h2>
        <p class="small muted">Places this shelf imports from: <code>shelf.json</code>'s <code>sources</code>.</p>
        <ul class="list">
          <li v-for="entry in sources" :key="entry.id" class="list-row">
            <strong class="mono">{{ entry.id }}</strong>
            <span class="badge">{{ entry.kind }}</span>
            <span class="mono small ellipsis">{{ entry.repo ?? entry.url ?? entry.path ?? "" }}</span>
            <span v-if="entry.secret" class="small muted">needs {{ entry.secret }}</span>
            <span class="spacer"></span>
            <button v-if="canWrite" class="danger small" type="button" @click="removeSource(entry)">Remove</button>
          </li>
        </ul>
        <form v-if="canWrite" class="source-form" @submit.prevent="addSource">
          <label class="field">Id <input v-model="sourceForm.id" class="mono" required /></label>
          <div class="field">
            <label for="source-kind">Kind</label>
            <select id="source-kind" v-model="sourceForm.kind">
              <option v-for="kind in SOURCE_KINDS" :key="kind" :value="kind">{{ kind }}</option>
            </select>
          </div>
          <label class="field">Repository <input v-model="sourceForm.repo" placeholder="https://github.com/owner/repo" /></label>
          <label class="field">URL <input v-model="sourceForm.url" placeholder="https://…" /></label>
          <label class="field">Path <input v-model="sourceForm.path" /></label>
          <label class="field">Profile (shelfkit) <input v-model="sourceForm.profile" /></label>
          <label class="field">Secret name <input v-model="sourceForm.secret" class="mono" placeholder="GITHUB_TOKEN" /></label>
          <div class="row">
            <button type="submit">Add source</button>
          </div>
          <p v-if="sourceError !== null" class="error-text small">{{ sourceError }}</p>
        </form>
      </section>
      <section v-if="owner" class="panel">
        <h2>Secret names</h2>
        <p class="small muted">
          Items and sources refer to a credential as <code>{ "secret": "NAME" }</code>. Its value is the Worker secret
          <code>SHELFKIT_SECRET_NAME</code>, set with <code>wrangler secret put</code>, and is sent only to the origin bound
          here.
        </p>
        <table class="table">
          <tbody>
            <tr v-for="secret in settings.secretNames" :key="secret.name">
              <td class="mono">{{ secret.name }}</td>
              <td class="mono small">{{ secret.origin ?? "nowhere" }}</td>
              <td class="small">{{ secret.description ?? "" }}</td>
              <td>
                <span class="badge" :class='secret.configured ? "info" : "warn"'>{{ secret.configured ? "set" : "not set" }}</span>
              </td>
              <td>
                <button
                  class="danger small"
                  type="button"
                  @click="removeSecretName(secret.name, secret.origin ?? null, secret.description ?? null)"
                >
                  Remove
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <form class="row" @submit.prevent="addSecretName">
          <input
            v-model="secretForm.name"
            aria-label="Secret name"
            class="mono"
            placeholder="LINEAR_API_KEY"
            required
          />
          <input
            v-model="secretForm.origin"
            aria-label="Origin"
            placeholder="https://mcp.linear.app"
            required
          />
          <input
            v-model="secretForm.description"
            aria-label="Description"
            placeholder="what it is for"
          />
          <button type="submit">Bind</button>
        </form>
      </section>
    </template>
  </main>
</template>

<style scoped>
.settings {
  max-width: var(--layout-measure-wide);
}

.secret {
  border-color: var(--accent-base);
}

.source-form {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--layout-measure-rail)), 1fr));
  gap: var(--spacing-size-3);
}
</style>
