<script setup lang="ts">
import { reactive, ref } from "vue";

import { execute } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import {
  AccessQuery,
  CreateInviteMutation,
  GrantAccessMutation,
  RemovePersonMutation,
  RevokeAccessMutation,
  RevokeInviteMutation,
} from "../api/operations.ts";
import { copyToClipboard } from "../composables/clipboard.ts";
import { signInMethods } from "../composables/session.ts";
import { notify, notifyError } from "../composables/toasts.ts";

type Access = NonNullable<ResultOf<typeof AccessQuery>["shelf"]>;

const { shelf, grants, invites, scopeChoices } = defineProps<{
  readonly shelf: string;
  readonly grants: Access["grants"];
  readonly invites: Access["invites"];
  readonly scopeChoices: readonly { readonly label: string; readonly scope: string }[];
}>();

const emit = defineEmits<{ changed: [] }>();

const inviteForm = reactive<{ name: string; scopes: string[] }>({ name: "", scopes: [] });
const newInvite = ref<string | null>(null);
const githubForm = reactive<{ login: string; scopes: string[] }>({ login: "", scopes: [] });
const armed = ref<string | null>(null);

function when(timestamp: string | null): string {
  return timestamp === null ? "" : new Date(timestamp).toLocaleString();
}

/** An action that cannot be undone asks twice: the first click arms it, the second does it. */
function confirmFirst(key: string): boolean {
  if (armed.value === key) {
    armed.value = null;
    return true;
  }
  armed.value = key;
  return false;
}

function inviteState(invite: Access["invites"][number]): string {
  if (invite.usedAt !== null) {
    return `used ${when(invite.usedAt)}`;
  }
  if (invite.revokedAt !== null) {
    return "revoked";
  }
  return new Date(invite.expiresAt) < new Date()
    ? "expired"
    : `open until ${when(invite.expiresAt)}`;
}

async function createInvite(): Promise<void> {
  try {
    const data = await execute(CreateInviteMutation, {
      name: inviteForm.name.trim(),
      scopes: inviteForm.scopes,
      shelf,
    });
    newInvite.value = data.createInvite.url;
    inviteForm.name = "";
    inviteForm.scopes = [];
    emit("changed");
  } catch (error) {
    notifyError(error);
  }
}

async function revokeInvite(id: string): Promise<void> {
  if (!confirmFirst(`invite:${id}`)) {
    return;
  }
  try {
    await execute(RevokeInviteMutation, { id, shelf });
    notify("Invite revoked.");
    emit("changed");
  } catch (error) {
    notifyError(error);
  }
}

async function revokeAccess(principal: string, name: string): Promise<void> {
  if (!confirmFirst(`grant:${principal}`)) {
    return;
  }
  try {
    await execute(RevokeAccessMutation, { principal, shelf });
    notify(`${name} no longer has access to this shelf, from their next request.`);
    emit("changed");
  } catch (error) {
    notifyError(error);
  }
}

async function removePerson(principal: string, name: string): Promise<void> {
  if (!confirmFirst(`person:${principal}`)) {
    return;
  }
  try {
    await execute(RemovePersonMutation, { principal, shelf });
    notify(`${name} is removed: their passkeys are gone and they are signed out.`);
    emit("changed");
  } catch (error) {
    notifyError(error);
  }
}

async function grantGitHub(): Promise<void> {
  try {
    const data = await execute(GrantAccessMutation, {
      login: githubForm.login.trim().replace(/^@/u, ""),
      scopes: githubForm.scopes,
      shelf,
    });
    notify(`${data.grantAccess.name} can now sign in to this shelf with GitHub.`);
    githubForm.login = "";
    githubForm.scopes = [];
    emit("changed");
  } catch (error) {
    notifyError(error);
  }
}

async function copy(text: string): Promise<void> {
  try {
    await copyToClipboard(text);
    notify("Invite link copied.");
  } catch (error) {
    notifyError(error);
  }
}
</script>

<template>
  <section class="panel stack">
    <h2>People</h2>
    <p class="small muted">
      Who may sign in to this shelf in the browser, and what each may do there. Removing someone takes effect at their
      next request.
    </p>
    <table class="table" data-testid="grants">
      <thead>
        <tr>
          <th>Name</th>
          <th>Allowed to</th>
          <th>Since</th>
          <th><span class="visually-hidden">Remove</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="grant in grants" :key="grant.principal">
          <td>
            {{ grant.name }} <span v-if='grant.kind === "github"' class="badge">GitHub</span>
          </td>
          <td class="mono small">{{ grant.scopes.join(" ") }}</td>
          <td class="small">{{ when(grant.createdAt) }}</td>
          <td class="row">
            <button
              class="danger small"
              type="button"
              @click="revokeAccess(grant.principal, grant.name)"
            >
              {{ armed === `grant:${grant.principal}` ? "Remove access: sure?" : "Remove access" }}
            </button>
            <button
              v-if='grant.kind === "person"'
              class="danger small"
              type="button"
              @click="removePerson(grant.principal, grant.name)"
            >
              {{ armed === `person:${grant.principal}` ? "Remove the person: sure?" : "Remove the person" }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <h3>Invite someone</h3>
    <p class="small muted">
      An invite is a link that works once, within 7 days. Whoever opens it adds a passkey and may then do what you tick
      here on this shelf.
    </p>
    <div v-if="newInvite !== null" class="panel secret" role="status">
      <strong>Send this link to the person it is for. It is shown once.</strong>
      <div class="row">
        <code class="mono" data-testid="invite-url">{{ newInvite }}</code>
        <button class="primary" type="button" @click="copy(newInvite)">Copy</button>
        <button class="quiet" type="button" @click="newInvite = null">Done</button>
      </div>
    </div>
    <form aria-label="Invite someone" class="stack" @submit.prevent="createInvite">
      <label class="field">
        Their name
        <input v-model="inviteForm.name" autocomplete="off" placeholder="Ada" required />
      </label>
      <fieldset>
        <legend>What they may do</legend>
        <label v-for="choice in scopeChoices" :key="choice.scope" class="row small">
          <input v-model="inviteForm.scopes" type="checkbox" :value="choice.scope" />
          {{ choice.label }} <code class="muted">{{ choice.scope }}</code>
        </label>
      </fieldset>
      <div class="row">
        <button class="primary" type="submit" :disabled="inviteForm.scopes.length === 0">Create invite</button>
      </div>
    </form>
    <ul class="list" data-testid="invites">
      <li v-for="invite in invites" :key="invite.id" class="list-row">
        <span>{{ invite.name }}</span>
        <span class="mono small">{{ invite.scopes.join(" ") }}</span>
        <span class="small muted">{{ inviteState(invite) }}</span>
        <span class="spacer"></span>
        <button
          v-if="invite.usedAt === null && invite.revokedAt === null"
          class="danger small"
          type="button"
          @click="revokeInvite(invite.id)"
        >
          {{ armed === `invite:${invite.id}` ? "Revoke: sure?" : "Revoke" }}
        </button>
      </li>
    </ul>
    <template v-if="signInMethods.github">
      <h3>A GitHub account</h3>
      <form aria-label="Grant a GitHub account" class="stack" @submit.prevent="grantGitHub">
        <label class="field">
          GitHub account
          <input
            v-model="githubForm.login"
            autocomplete="off"
            placeholder="octocat"
            required
            spellcheck="false"
          />
        </label>
        <fieldset>
          <legend>What they may do</legend>
          <label v-for="choice in scopeChoices" :key="choice.scope" class="row small">
            <input v-model="githubForm.scopes" type="checkbox" :value="choice.scope" />
            {{ choice.label }} <code class="muted">{{ choice.scope }}</code>
          </label>
        </fieldset>
        <div class="row">
          <button class="primary" type="submit" :disabled="githubForm.scopes.length === 0">Grant access</button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.secret {
  border-color: var(--accent-base);
}
</style>
