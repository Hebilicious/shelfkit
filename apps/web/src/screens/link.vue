<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import { execute, messageOf } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { InviteQuery, RedeemLinkMutation, SignInLinkQuery } from "../api/operations.ts";
import { loadSession, viewer, viewerName } from "../composables/session.ts";
import { localPath } from "../lib/local-path.ts";
import { addPasskey, deviceLabel, passkeysAvailable } from "../lib/passkeys.ts";

type Invite = NonNullable<ResultOf<typeof InviteQuery>["invite"]>;
type Redeemed = ResultOf<typeof RedeemLinkMutation>["redeemLink"];

const router = useRouter();
/** The link's token, taken from the URL's fragment, which no server and no `Referer` ever sees. */
const token = ref("");
const invite = ref<Invite | null>(null);
const redeemed = ref<Redeemed | null>(null);
const problem = ref<string | null>(null);
const busy = ref(false);
const passkeyAdded = ref(false);
const label = ref(deviceLabel());
const canUsePasskeys = passkeysAvailable();
/** Where a sign-in link goes on to: its `?next=`, a path on this site (`shelfkit open <url>/<path>` adds it). */
const next = ref("/");

const isInvite = computed(() => token.value.startsWith("ssi_"));
/**
 * Whom a sign-in link opens, when this browser is signed in as someone else: the link waits for a click naming both,
 * so a link someone sent cannot quietly put this browser in their account.
 */
const switchTo = ref<string | null>(null);
const currentName = computed(() => (viewer.value === null ? "" : viewerName(viewer.value)));

async function redeem(switchAccount = false): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    const data = await execute(RedeemLinkMutation, { switchAccount, token: token.value });
    redeemed.value = data.redeemLink;
    switchTo.value = null;
    token.value = "";
    await loadSession();
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  token.value = decodeURIComponent(window.location.hash.slice(1));
  next.value = localPath(
    new URLSearchParams(window.location.search).get("next"),
    window.location.origin,
  );
  // The token leaves the address bar and the history at once.
  window.history.replaceState(window.history.state, "", "/link");
  if (token.value === "") {
    problem.value = "This link holds no token. Open the whole link you were given.";
    return;
  }
  if (!isInvite.value) {
    await loadSession();
    try {
      const data = await execute(SignInLinkQuery, { token: token.value });
      if (data.signInLink === null) {
        problem.value = "This link was already used or has expired: make a new one.";
      } else if (data.signInLink.switching) {
        switchTo.value = data.signInLink.name;
      } else {
        await redeem();
      }
    } catch (error) {
      problem.value = messageOf(error);
    }
    return;
  }
  try {
    const data = await execute(InviteQuery, { token: token.value });
    invite.value = data.invite;
    if (data.invite === null) {
      problem.value =
        "This invite was already used, has expired, or was revoked: ask for a new one.";
    }
  } catch (error) {
    problem.value = messageOf(error);
  }
});

async function makePasskey(): Promise<void> {
  busy.value = true;
  problem.value = null;
  try {
    await addPasskey(label.value.trim() || deviceLabel());
    passkeyAdded.value = true;
  } catch (error) {
    problem.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

async function goOn(): Promise<void> {
  const shelf = redeemed.value?.shelf;
  await router.push(
    shelf === null || shelf === undefined ? next.value : { name: "shelf", params: { shelf } },
  );
}
</script>

<template>
  <main class="page link">
    <section class="panel stack">
      <h1>{{ isInvite || redeemed?.shelf ? "Invitation" : "Sign-in link" }}</h1>
      <p v-if="problem !== null" class="error-text" role="alert">{{ problem }}</p>
      <template v-if="redeemed === null && switchTo !== null">
        <p data-testid="switch">
          This browser is signed in as <strong>{{ currentName }}</strong>. The link signs it in as
          <strong>{{ switchTo }}</strong> instead. Only go on if you asked for this link.
        </p>
        <div class="row">
          <button class="primary" type="button" :disabled="busy" @click="redeem(true)">
            Switch to {{ switchTo }}
          </button>
          <button class="quiet" type="button" @click="goOn">Stay {{ currentName }}</button>
        </div>
      </template>
      <template v-if="redeemed === null && invite !== null">
        <p data-testid="invite">
          <strong>{{ invite.name }}</strong>, you are invited to the shelf <strong>{{ invite.shelfName }}</strong>
          (<code>{{ invite.shelf }}</code>) with <code>{{ invite.scopes.join(" ") }}</code>.
        </p>
        <p v-if="viewer?.owner" class="small">
          This browser is signed in as the owner, who holds every scope already. Send the link to the person it is
          for.
        </p>
        <div class="row">
          <button class="primary" type="button" :disabled="busy || viewer?.owner" @click="redeem()">
            Accept the invitation
          </button>
        </div>
      </template>
      <p v-else-if="redeemed === null && problem === null && switchTo === null" class="muted">
        Opening the link…
      </p>
      <template v-if="redeemed !== null">
        <p data-testid="signed-in">
          You are signed in as <strong>{{ redeemed.name }}</strong><template v-if="redeemed.shelf">, with access to <code>{{ redeemed.shelf }}</code></template>.
        </p>
        <template v-if="redeemed.offerPasskey && !passkeyAdded">
          <p class="small">
            Add a passkey on this device to sign in here again without a link. Your password manager, your system, or
            a security key keeps it.
          </p>
          <label class="field">
            Name for this passkey
            <input v-model="label" autocomplete="off" />
          </label>
          <p v-if="!canUsePasskeys" class="small">This browser cannot make passkeys; you can still use it now.</p>
          <div class="row">
            <button
              class="primary"
              data-testid="add-passkey"
              type="button"
              :disabled="busy || !canUsePasskeys"
              @click="makePasskey"
            >
              Add a passkey
            </button>
            <button class="quiet" type="button" @click="goOn">Not now</button>
          </div>
        </template>
        <template v-else>
          <p v-if="passkeyAdded" class="small" data-testid="passkey-added" role="status">
            Passkey added. Next time, sign in with it.
          </p>
          <div class="row">
            <button class="primary" type="button" @click="goOn">Continue</button>
          </div>
        </template>
      </template>
    </section>
  </main>
</template>

<style scoped>
.link {
  max-width: var(--layout-measure-prose);
  margin: 0 auto;
  width: 100%;
}
</style>
