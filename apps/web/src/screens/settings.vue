<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import { readSources } from "../api/json.ts";
import type { ShelfSourceEntry } from "../api/json.ts";
import {
  AccessQuery,
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
import AccountPanel from "../components/account-panel.vue";
import PeoplePanel from "../components/people-panel.vue";
import QueryState from "../components/query-state.vue";
import { copyToClipboard } from "../composables/clipboard.ts";
import { loadSignInMethods } from "../composables/session.ts";
import { useShelfId } from "../composables/shelf-context.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { invalidate, shelfKey, shelfPrefix, useQuery } from "../data/cache.ts";
import { SOURCE_KINDS, sourceKindLabel } from "../lib/vocabulary.ts";

const shelf = useShelfId();

const query = useQuery(
  () => shelfKey(shelf.value, "settings"),
  async () => {
    const data = await execute(SettingsQuery, { shelf: shelf.value });
    return data;
  },
);

const settings = computed(() => query.data.value?.shelf ?? null);
const owner = computed(() => settings.value?.viewerAccess.owner === true);

// Keys, people, and invites are the owner's business, read only when the viewer is the owner.
const accessQuery = useQuery(
  () => shelfKey(shelf.value, "access", owner.value),
  async () => {
    if (!owner.value) {
      return null;
    }
    const data = await execute(AccessQuery, { shelf: shelf.value });
    return data.shelf;
  },
);
const keys = computed(() => accessQuery.data.value?.keys ?? []);
const grants = computed(() => accessQuery.data.value?.grants ?? []);
const invites = computed(() => accessQuery.data.value?.invites ?? []);

onMounted(() => {
  void loadSignInMethods();
});
const canWrite = computed(() => settings.value?.viewerAccess.write === true);
const sources = computed(() => readSources(settings.value?.sources ?? null));
const shareLinks = computed(() => query.data.value?.shareLinks ?? []);
const profileTitles = computed(
  () => new Map((settings.value?.profiles ?? []).map((profile) => [profile.id, profile.title])),
);

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
    invalidate(shelfPrefix(shelfId));
    notify(
      isPublic
        ? "Anyone can now install this shelf's profiles."
        : "Installing from the registry now needs a key.",
      async () => {
        await execute(SetVisibilityMutation, { public: !isPublic, shelf: shelfId });
        invalidate(shelfPrefix(shelfId));
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
    { label: "Edit the shelf and publish every profile", scope: `publish:${id}/*` },
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
    await accessQuery.refresh();
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
    await accessQuery.refresh();
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
    invalidate(shelfPrefix(shelf.value));
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
    invalidate(shelfPrefix(shelf.value));
  } catch (error) {
    notifyError(error);
  }
}

// Sources: removing one is undone by putting it back.

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
      invalidate(shelfPrefix(shelf.value));
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
    invalidate(shelfPrefix(shelf.value));
    notify(`Removed the source ${entry.id}.`, async () => {
      if (!(await putSource(entry))) {
        throw new Error(sourceError.value ?? "the shelf refused to restore it");
      }
      invalidate(shelfPrefix(shelf.value));
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
    invalidate(shelfPrefix(shelf.value));
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
    invalidate(shelfPrefix(shelf.value));
    notify(
      `Removed the credential ${name}.`,
      origin === null
        ? null
        : async () => {
            await putSecretName(name, origin, description);
            invalidate(shelfPrefix(shelf.value));
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
    <p class="muted">
      Your account, who else may use this shelf, the keys programs use, share links, and the places imports come from.
    </p>
    <AccountPanel />
    <QueryState :loading="query.loading.value" :error="query.error.value" :empty="settings === null" />
    <template v-if="settings !== null">
      <section class="panel">
        <h2>Registry</h2>
        <p class="small muted">
          This shelf is also an APM registry: a repository can install its published profiles with APM alone, with no
          ShelfKit tool installed.
        </p>
        <div class="row">
          <span class="small muted">The address to list under <code>registries</code> in <code>apm.yml</code>:</span>
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
      <PeoplePanel
        v-if="owner"
        :grants="grants"
        :invites="invites"
        :scope-choices="scopeChoices"
        :shelf="shelf"
        @changed="accessQuery.refresh()"
      />
      <section v-if="owner" class="panel">
        <h2>Keys</h2>
        <p class="small muted">
          Keys are for programs: the <code>shelfkit</code> CLI, an agent, CI, or APM installing from the registry. People
          sign in instead (see People). A key is shown once, when it is created; give each program its own, allowed only
          what it needs.
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
              <th>Allowed to</th>
              <th>Last used</th>
              <th><span class="visually-hidden">Revoke</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in keys" :key="key.id">
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
        <form aria-label="New key" class="stack" @submit.prevent="createKey">
          <label class="field">New key's name <input v-model="keyForm.name" placeholder="laptop CLI" required /></label>
          <fieldset>
            <legend>What it may do</legend>
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
        <p class="small muted">
          A read-only page for one profile, at an address nobody can guess: what it installs and its <code>apm.yml</code>.
          Anyone with the link can read it, without signing in.
        </p>
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
            <span>{{ profileTitles.get(link.profile) ?? link.profile }}</span>
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
        <p class="small muted">
          Saved places to import from, offered on the Import screen. They are kept in <code>shelf.json</code>, under
          <code>sources</code>.
        </p>
        <ul class="list">
          <li v-for="entry in sources" :key="entry.id" class="list-row">
            <strong class="mono">{{ entry.id }}</strong>
            <span class="badge">{{ sourceKindLabel(entry.kind) }}</span>
            <span class="mono small ellipsis">{{ entry.repo ?? entry.url ?? entry.path ?? "" }}</span>
            <span v-if="entry.secret" class="small muted">uses the credential {{ entry.secret }}</span>
            <span class="spacer"></span>
            <button v-if="canWrite" class="danger small" type="button" @click="removeSource(entry)">Remove</button>
          </li>
        </ul>
        <form v-if="canWrite" class="source-form" @submit.prevent="addSource">
          <label class="field">Id <input v-model="sourceForm.id" class="mono" required /></label>
          <div class="field">
            <label for="source-kind">What it is</label>
            <select id="source-kind" v-model="sourceForm.kind">
              <option v-for="entry in SOURCE_KINDS" :key="entry.kind" :value="entry.kind">{{ entry.label }}</option>
            </select>
          </div>
          <label class="field">Repository <input v-model="sourceForm.repo" placeholder="https://github.com/owner/repo" /></label>
          <label class="field">URL <input v-model="sourceForm.url" placeholder="https://…" /></label>
          <label class="field">Folder <input v-model="sourceForm.path" /></label>
          <label class="field">Profile (another shelf's) <input v-model="sourceForm.profile" /></label>
          <label class="field">Credential <input v-model="sourceForm.secret" class="mono" placeholder="GITHUB_TOKEN" /></label>
          <div class="row">
            <button type="submit">Add source</button>
          </div>
          <p v-if="sourceError !== null" class="error-text small">{{ sourceError }}</p>
        </form>
      </section>
      <section v-if="owner" class="panel">
        <h2>Credentials</h2>
        <p class="small muted">
          Items and sources that need a credential, such as an API key, refer to it by name:
          <code>{ "secret": "NAME" }</code>. Its value is never typed here: it is the Worker secret
          <code>SHELFKIT_SECRET_NAME</code>, set with <code>wrangler secret put</code>, and it is sent only to the address
          listed beside its name.
        </p>
        <table class="table">
          <tbody>
            <tr v-for="secret in settings.secretNames" :key="secret.name">
              <td class="mono">{{ secret.name }}</td>
              <td class="mono small">{{
                  secret.origin === null || secret.origin === undefined
                    ? "sent nowhere"
                    : `sent only to ${secret.origin}`
                }}</td>
              <td class="small">{{ secret.description ?? "" }}</td>
              <td>
                <span class="badge" :class='secret.configured ? "info" : "warn"'>{{ secret.configured ? "value set" : "no value yet" }}</span>
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
            aria-label="Credential name"
            class="mono"
            placeholder="LINEAR_API_KEY"
            required
          />
          <input
            v-model="secretForm.origin"
            aria-label="Sent only to"
            placeholder="https://mcp.linear.app"
            required
          />
          <input
            v-model="secretForm.description"
            aria-label="Description"
            placeholder="what it is for"
          />
          <button type="submit">Add credential</button>
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
