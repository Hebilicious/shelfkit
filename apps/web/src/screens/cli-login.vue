<script setup lang="ts">
/**
 * Approving `shelfkit login` (`docs/PRD.md` section 10.3): the CLI opens `/cli/<code>`, and the person signed in here
 * checks the code matches the one in their terminal, then approves or denies it. Approving hands that CLI, once, a
 * key that acts as this account. The code is the phishing surface of the flow, so the page says plainly to approve
 * only a code from one's own terminal.
 */
import * as v from "valibot";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { execute, messageOf } from "../api/graphql.ts";
import { ApproveCliLoginMutation, CliLoginQuery, DenyCliLoginMutation } from "../api/operations.ts";
import { sessionChecked, viewer, viewerName } from "../composables/session.ts";
import { keyOf, useQuery } from "../data/cache.ts";

const route = useRoute();
const router = useRouter();

/** The code in the address, as the CLI opened it: `ABCD-EFGH`, or typed in any case. */
const code = computed(() => {
  const { code: param } = route.params;
  return v.is(v.string(), param) ? param.trim().toUpperCase() : "";
});
const typed = ref("");

const signedIn = computed(
  () => viewer.value?.authenticated === true && viewer.value.principal !== null,
);

const login = useQuery(
  () =>
    signedIn.value && code.value !== ""
      ? keyOf("cli-login", viewer.value?.principal, code.value)
      : null,
  async () => {
    const data = await execute(CliLoginQuery, { code: code.value });
    return data.cliLogin;
  },
);

/** What happened here: nothing yet, approved (with the key's name), or denied. */
const outcome = ref<
  { readonly kind: "approved"; readonly name: string } | { readonly kind: "denied" } | null
>(null);
const busy = ref(false);
const problem = ref<string | null>(null);

const until = computed(() =>
  login.data.value === null ? "" : new Date(login.data.value.expiresAt).toLocaleTimeString(),
);

async function enter(): Promise<void> {
  const entered = typed.value.trim().toUpperCase();
  if (entered !== "") {
    await router.push({ name: "cli-login", params: { code: entered } });
  }
}

async function approve(): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    const data = await execute(ApproveCliLoginMutation, { code: code.value });
    outcome.value = { kind: "approved", name: data.approveCliLogin.name };
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

async function deny(): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    await execute(DenyCliLoginMutation, { code: code.value });
    outcome.value = { kind: "denied" };
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="page cli-login">
    <section class="panel stack">
      <h1>Sign in the ShelfKit CLI</h1>
      <template v-if='code === ""'>
        <p>Type the code <code>shelfkit login</code> shows in your terminal.</p>
        <form class="row" @submit.prevent="enter">
          <input
            v-model="typed"
            aria-label="Code"
            autocomplete="off"
            placeholder="ABCD-EFGH"
            required
          />
          <button class="primary" type="submit">Continue</button>
        </form>
      </template>
      <p v-else-if="!sessionChecked && !signedIn" class="muted">Checking who you are…</p>
      <template v-else-if="!signedIn">
        <p>Sign in first: the CLI will act as the account you approve it with.</p>
        <p>
          <RouterLink
            class="button primary"
            data-testid="cli-sign-in"
            :to='{ name: "sign-in", query: { next: route.fullPath } }'
          >
            Sign in
          </RouterLink>
        </p>
      </template>
      <template v-else-if='outcome?.kind === "approved"'>
        <p data-testid="cli-approved" role="status">
          Approved. <strong>{{ outcome.name }}</strong> is signed in as {{ viewer ? viewerName(viewer) : "you" }}: go
          back to your terminal.
        </p>
        <p class="small muted">
          Its key is listed under “CLI sign-ins” in any shelf's Settings, where you can revoke it. You can close this
          page.
        </p>
      </template>
      <p v-else-if='outcome?.kind === "denied"' data-testid="cli-denied" role="status">
        Denied. That CLI is not signed in and holds nothing. You can close this page.
      </p>
      <p v-else-if="login.error.value !== null" class="error-text" role="alert">{{ login.error.value }}</p>
      <p v-else-if="login.loading.value" class="muted">Looking the code up…</p>
      <p v-else-if="login.data.value === null" data-testid="cli-not-waiting">
        The code <code>{{ code }}</code> is not waiting for approval: it was used, denied, or has expired. Run
        <code>shelfkit login</code> again for a new one.
      </p>
      <template v-else>
        <p class="code mono" data-testid="cli-code">{{ login.data.value.code }}</p>
        <p class="warning" role="note">
          Approve only if your own terminal shows this code right now, because you just ran
          <code>shelfkit login</code>. If someone sent you this page or the code, deny it: approving would give them
          your account.
        </p>
        <dl class="facts">
          <dt>Computer</dt>
          <dd data-testid="cli-device">{{ login.data.value.device }} <span class="small muted">(the name it sent)</span></dd>
          <dt>Signs in as</dt>
          <dd>{{ viewer ? viewerName(viewer) : "you" }}</dd>
          <dt>May do</dt>
          <dd v-if="viewer?.owner">
            Everything you can as the owner: read and change every shelf, publish profiles, and manage keys and people.
          </dd>
          <dd v-else>
            What you can do on each shelf the owner gave you access to, for as long as you have that access.
          </dd>
          <dt>Waits until</dt>
          <dd>{{ until }}</dd>
        </dl>
        <p v-if="problem !== null" class="error-text" role="alert">{{ problem }}</p>
        <div class="row">
          <button
            class="primary"
            data-testid="cli-approve"
            type="button"
            :disabled="busy"
            @click="approve"
          >
            Approve
          </button>
          <button class="danger" data-testid="cli-deny" type="button" :disabled="busy" @click="deny">Deny</button>
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.cli-login {
  max-width: var(--layout-measure-prose);
  margin: 0 auto;
  width: 100%;
}

.code {
  font-size: var(--typography_fluid-sans-text-xl);
  font-weight: var(--typography-weight-sans-bold);
}

.warning {
  border-inline-start: var(--layout-border-thick) solid var(--signal-warn);
  padding-inline-start: var(--spacing-size-3);
}

.facts {
  display: grid;
  gap: var(--spacing-size-1) var(--spacing-size-3);
  grid-template-columns: max-content 1fr;
}

.facts dt {
  color: var(--text-muted);
}

.facts dd {
  margin: 0;
}
</style>
