<script setup lang="ts">
import * as v from "valibot";
import { computed } from "vue";
import { useRoute } from "vue-router";

import { signInUrl, viewer, viewerName } from "../composables/session.ts";
import { localPath } from "../lib/local-path.ts";

const route = useRoute();
/** Where to return after signing in: a path on this site, else the shelves. */
const next = computed(() => {
  const { next: wanted } = route.query;
  return localPath(v.is(v.string(), wanted) ? wanted : null, window.location.origin);
});

/**
 * Go to the Worker's start of the flow, which redirects to GitHub. A navigation, not a form: the SPA's CSP limits a
 * form's target to this origin, redirects included.
 */
function signIn(): void {
  window.location.assign(signInUrl(next.value));
}

/** Why the last sign-in failed, as the Worker's redirect back here names it (`/sign-in?error=`). */
const ProblemSchema = v.picklist(["denied", "github", "state", "unconfigured"]);
const PROBLEMS: Readonly<Record<v.InferOutput<typeof ProblemSchema>, string>> = {
  denied: "GitHub did not authorize ShelfKit, so you are not signed in.",
  github: "GitHub did not confirm the sign-in. Try again.",
  state: "That sign-in did not start in this browser, or took too long. Try again.",
  unconfigured:
    "This deployment has no GitHub App yet. Its owner runs `moon run worker:setup` to create one.",
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
      <p class="muted small">
        Sign in with your GitHub account. ShelfKit only learns who you are: it asks GitHub for no access to your
        repositories, and keeps no GitHub token.
      </p>
      <p v-if="problem !== null" class="error-text small" role="alert">{{ problem }}</p>
      <div class="row">
        <button class="primary" data-testid="sign-in-github" type="button" @click="signIn">Sign in with GitHub</button>
      </div>
      <p class="muted small">
        The CLI, agents, and CI use a key instead: the owner creates one in Settings.
      </p>
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
