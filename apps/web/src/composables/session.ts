/**
 * Who the browser is signed in as, and the shelves it reaches. Signing in (a passkey, a one-time link, or GitHub when
 * the deployment enables it) ends with an `HttpOnly` session cookie the SPA never reads (`docs/PRD.md` section 10.3).
 */
import { ref, shallowRef } from "vue";

import { execute, whenRefused } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import {
  SignInMethodsQuery,
  SignOutMutation,
  ViewerQuery,
} from "../api/operations.ts";

export type Viewer = ResultOf<typeof ViewerQuery>["viewer"];
export type ShelfEntry = ResultOf<typeof ViewerQuery>["shelves"][number];

export const viewer = shallowRef<Viewer | null>(null);
export const shelves = shallowRef<readonly ShelfEntry[]>([]);
export const sessionError = ref<string | null>(null);

/** How this deployment lets a browser sign in: passkeys always, GitHub when it is enabled. */
export const signInMethods = shallowRef<{
  readonly passkey: boolean;
  readonly github: boolean;
}>({
  github: false,
  passkey: true,
});

/** Read how the deployment lets a browser sign in. */
export async function loadSignInMethods(): Promise<void> {
  const data = await execute(SignInMethodsQuery, {});
  signInMethods.value = data.signInMethods;
}

/** Read who the request is. */
export async function loadSession(): Promise<void> {
  try {
    const data = await execute(ViewerQuery, {});
    viewer.value = data.viewer;
    shelves.value = data.shelves;
    sessionError.value = null;
  } catch (error) {
    sessionError.value = error instanceof Error ? error.message : String(error);
  }
}

// A refusal may mean the account's grant was revoked, or its session ended: read who the browser is now.
whenRefused(() => {
  void loadSession();
});

/** Where "Sign in with GitHub" goes, when enabled: the Worker's start of the flow, returning to `next` afterwards. */
export function signInUrl(next: string): string {
  return `/auth/github/start?${new URLSearchParams({ next }).toString()}`;
}

/** How the header and Settings name the viewer: who signed in, the owner key, or a scoped key. */
export function viewerName(current: Viewer): string {
  if (current.name !== null) {
    return current.name;
  }
  return current.owner ? "Owner" : (current.keyName ?? "Key");
}

export async function signOut(): Promise<void> {
  await execute(SignOutMutation, {});
  viewer.value = null;
  shelves.value = [];
  await loadSession();
}
