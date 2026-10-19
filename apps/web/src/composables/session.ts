/**
 * Who the browser is signed in as, and the shelves it reaches. Signing in is a navigation to the Worker's
 * `/auth/github/start`, which ends with an `HttpOnly` session cookie the SPA never reads (`docs/PRD.md` section 10.3).
 */
import { ref, shallowRef } from "vue";

import { execute, whenRefused } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import { SignOutMutation, ViewerQuery } from "../api/operations.ts";

export type Viewer = ResultOf<typeof ViewerQuery>["viewer"];
export type ShelfEntry = ResultOf<typeof ViewerQuery>["shelves"][number];

export const viewer = shallowRef<Viewer | null>(null);
export const shelves = shallowRef<readonly ShelfEntry[]>([]);
export const sessionError = ref<string | null>(null);

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

/** Where the "Sign in with GitHub" button goes: the Worker's start of the flow, returning to `next` afterwards. */
export function signInUrl(next: string): string {
  return `/auth/github/start?${new URLSearchParams({ next }).toString()}`;
}

/** How the header and Settings name the viewer: the GitHub account, the owner key, or a scoped key. */
export function viewerName(current: Viewer): string {
  if (current.login !== null && current.login !== undefined) {
    return `@${current.login}`;
  }
  return current.owner ? "Owner" : (current.keyName ?? "Key");
}

export async function signOut(): Promise<void> {
  await execute(SignOutMutation, {});
  viewer.value = null;
  shelves.value = [];
  await loadSession();
}
