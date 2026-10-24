<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import { execute } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import {
  CreateSignInLinkMutation,
  PasskeysQuery,
  RemovePasskeyMutation,
  RenamePasskeyMutation,
} from "../api/operations.ts";
import { copyToClipboard } from "../composables/clipboard.ts";
import { signOut, viewer, viewerName } from "../composables/session.ts";
import { notify, notifyError } from "../composables/toasts.ts";
import { keyOf, useQuery } from "../data/cache.ts";
import { addPasskey, deviceLabel, passkeysAvailable } from "../lib/passkeys.ts";

type Passkey = ResultOf<typeof PasskeysQuery>["passkeys"][number];

const router = useRouter();
const canUsePasskeys = passkeysAvailable();

/** Passkeys belong to the owner and to invited people; a GitHub account or a key has none here. */
const hasAccount = computed(
  () =>
    viewer.value?.principal === "owner" || viewer.value?.principal?.startsWith("person:") === true,
);

const passkeys = useQuery(
  () => keyOf("passkeys", hasAccount.value),
  async () => {
    if (!hasAccount.value) {
      return [];
    }
    const data = await execute(PasskeysQuery, {});
    return data.passkeys;
  },
);

const list = computed<readonly Passkey[]>(() => passkeys.data.value ?? []);
const label = ref(deviceLabel());
const renaming = ref<string | null>(null);
const newLabel = ref("");
const armed = ref<string | null>(null);
const link = ref<{ readonly url: string; readonly expiresAt: string } | null>(null);

const linkUntil = computed(() =>
  link.value === null ? "" : new Date(link.value.expiresAt).toLocaleTimeString(),
);

function when(timestamp: string | null): string {
  return timestamp === null ? "never" : new Date(timestamp).toLocaleString();
}

async function leave(): Promise<void> {
  try {
    await signOut();
    await router.push({ name: "sign-in" });
  } catch (error) {
    notifyError(error);
  }
}

async function add(): Promise<void> {
  try {
    await addPasskey(label.value.trim() || deviceLabel());
    notify("Passkey added on this device.");
    await passkeys.refresh();
  } catch (error) {
    notifyError(error);
  }
}

function startRename(passkey: Passkey): void {
  renaming.value = passkey.id;
  newLabel.value = passkey.label;
}

async function rename(id: string): Promise<void> {
  try {
    await execute(RenamePasskeyMutation, { id, label: newLabel.value });
    renaming.value = null;
    await passkeys.refresh();
  } catch (error) {
    notifyError(error);
  }
}

/** Removing asks twice, and the last passkey says what removing it means before it goes. */
async function remove(id: string): Promise<void> {
  if (armed.value !== id) {
    armed.value = id;
    return;
  }
  armed.value = null;
  try {
    await execute(RemovePasskeyMutation, { allowLast: true, id });
    notify(
      list.value.length === 1
        ? "Last passkey removed. To sign in again, open a sign-in link."
        : "Passkey removed.",
    );
    await passkeys.refresh();
  } catch (error) {
    notifyError(error);
  }
}

/** A one-time link to sign another device in to this account. */
async function anotherDevice(): Promise<void> {
  try {
    const data = await execute(CreateSignInLinkMutation, {});
    link.value = data.createSignInLink;
  } catch (error) {
    notifyError(error);
  }
}

async function copy(text: string): Promise<void> {
  try {
    await copyToClipboard(text);
    notify("Link copied.");
  } catch (error) {
    notifyError(error);
  }
}
</script>

<template>
  <section v-if="viewer?.authenticated" class="panel stack">
    <h2>Account</h2>
    <div class="row">
      <span data-testid="account">Signed in as <strong>{{ viewerName(viewer) }}</strong></span>
      <span v-if="viewer.owner" class="badge">owner</span>
      <span class="spacer"></span>
      <button class="quiet small" type="button" @click="leave">Sign out</button>
    </div>
    <template v-if="hasAccount">
      <h3>Passkeys</h3>
      <p class="small muted">A passkey signs you in on a device with its fingerprint, face or PIN, with no password.</p>
      <table class="table" data-testid="passkeys">
        <thead>
          <tr>
            <th>Name</th>
            <th>Added</th>
            <th>Last used</th>
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="passkey in list" :key="passkey.id">
            <td>
              <form v-if="renaming === passkey.id" class="row" @submit.prevent="rename(passkey.id)">
                <input v-model="newLabel" aria-label="Passkey name" required />
                <button class="small" type="submit">Save</button>
              </form>
              <template v-else>{{ passkey.label }}</template>
            </td>
            <td class="small">{{ when(passkey.createdAt) }}</td>
            <td class="small">{{ when(passkey.lastUsedAt) }}</td>
            <td class="row">
              <button class="quiet small" type="button" @click="startRename(passkey)">Rename</button>
              <button class="danger small" type="button" @click="remove(passkey.id)">
                {{
                  armed === passkey.id
                    ? list.length === 1
                      ? "Remove the last one: sure?"
                      : "Remove: sure?"
                    : "Remove"
                }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="list.length === 0" class="small muted">No passkey yet: add one to sign in here without a link.</p>
      <form aria-label="Add a passkey" class="row" @submit.prevent="add">
        <input v-model="label" aria-label="Name for the new passkey" />
        <button class="primary" type="submit" :disabled="!canUsePasskeys">Add a passkey on this device</button>
      </form>
      <h3>Another device</h3>
      <p class="small muted">
        Make a one-time link, open it on the other device within 15 minutes, and add a passkey there.
      </p>
      <div class="row">
        <button data-testid="another-device" type="button" @click="anotherDevice">Make a sign-in link</button>
      </div>
      <div v-if="link !== null" class="panel secret" role="status">
        <strong>Open this on the other device. It works once, until {{ linkUntil }}.</strong>
        <div class="row">
          <code class="mono" data-testid="sign-in-link">{{ link.url }}</code>
          <button class="primary" type="button" @click="copy(link.url)">Copy</button>
          <button class="quiet" type="button" @click="link = null">Done</button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.secret {
  border-color: var(--accent-base);
}
</style>
