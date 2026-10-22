<script setup lang="ts">
import * as v from "valibot";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { messageOf } from "../api/graphql.ts";
import {
  loadSession,
  loadSignInMethods,
  signInMethods,
  signInUrl,
  viewer,
  viewerName,
} from "../composables/session.ts";
import { localPath } from "../lib/local-path.ts";
import { passkeysAvailable, signInWithPasskey } from "../lib/passkeys.ts";

const route = useRoute();
const router = useRouter();
const busy = ref(false);
const failure = ref<string | null>(null);
const canUsePasskeys = passkeysAvailable();

/** Where to return after signing in: a path on this site, else the shelves. */
const next = computed(() => {
  const { next: wanted } = route.query;
  return localPath(v.is(v.string(), wanted) ? wanted : null, window.location.origin);
});

onMounted(() => {
  void loadSignInMethods();
});

/** Sign in with a passkey this device holds, then go where the sign-in started. */
async function passkey(): Promise<void> {
  busy.value = true;
  failure.value = null;
  try {
    await signInWithPasskey();
    await loadSession();
    await router.push(next.value);
  } catch (error) {
    failure.value = messageOf(error);
  } finally {
    busy.value = false;
  }
}

/**
 * Go to the Worker's start of the GitHub flow, which redirects to GitHub. A navigation, not a form: the SPA's CSP
 * limits a form's target to this origin, redirects included.
 */
function github(): void {
  window.location.assign(signInUrl(next.value));
}

/** Why the last GitHub sign-in failed, as the Worker's redirect back here names it (`/sign-in?error=`). */
const ProblemSchema = v.picklist(["denied", "github", "state", "unconfigured"]);
const PROBLEMS: Readonly<Record<v.InferOutput<typeof ProblemSchema>, string>> = {
  denied: "GitHub did not authorize ShelfKit, so you are not signed in.",
  github: "GitHub did not confirm the sign-in. Try again.",
  state: "That sign-in did not start in this browser, or took too long. Try again.",
  unconfigured: "This deployment does not sign in with GitHub. Use a passkey or a sign-in link.",
};

const problem = computed(() => {
  const { error } = route.query;
  if (error === undefined || error === null) {
    return null;
  }
  return v.is(ProblemSchema, error) ? PROBLEMS[error] : PROBLEMS.github;
});
</script>

<template>
  <main class="page sign-in">
    <section class="panel stack">
      <h1>Sign in</h1>
      <p v-if="viewer?.authenticated" class="small" data-testid="signed-in-as">
        You are signed in as <strong>{{ viewerName(viewer) }}</strong>.
      </p>
      <p v-if="problem !== null" class="error-text small" role="alert">{{ problem }}</p>
      <p v-if="failure !== null" class="error-text small" role="alert">{{ failure }}</p>
      <div class="row">
        <button
          class="primary"
          data-testid="sign-in-passkey"
          type="button"
          :disabled="busy || !canUsePasskeys"
          @click="passkey"
        >
          Sign in with a passkey
        </button>
        <button
          v-if="signInMethods.github"
          data-testid="sign-in-github"
          type="button"
          @click="github"
        >
          Sign in with GitHub
        </button>
      </div>
      <p v-if="!canUsePasskeys" class="small">This browser cannot use passkeys.</p>
      <p class="muted small">
        No passkey on this device yet? Open a sign-in link: <code>shelfkit open</code> makes one for the owner, a
        signed-in device makes one in Settings, and an invite is one. On Linux, a browser needs a passkey provider: its
        built-in password manager, a password manager's extension, or a hardware security key.
      </p>
      <p class="muted small">The CLI, agents, and CI use a key instead: the owner creates one in Settings.</p>
    </section>
  </main>
</template>

<style scoped>
.sign-in {
  max-width: var(--layout-measure-prose);
  margin: 0 auto;
  width: 100%;
}
</style>
