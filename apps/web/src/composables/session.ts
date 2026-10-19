/**
 * Who the browser is signed in as, and the shelves it reaches. The key itself lives in the `HttpOnly` cookie
 * `signIn` sets; the SPA never sees it (`docs/PRD.md` section 10.3).
 */
import { ref, shallowRef } from "vue";

import { execute } from "../api/graphql.ts";
import type { ResultOf } from "../api/graphql.ts";
import {
  SignInMutation,
  SignOutMutation,
  ViewerQuery,
} from "../api/operations.ts";

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

/** Trade a key for the cookie, then read the session it opens. */
export async function signIn(key: string): Promise<void> {
  await execute(SignInMutation, { key });
  await loadSession();
}

export async function signOut(): Promise<void> {
  await execute(SignOutMutation, {});
  viewer.value = null;
  shelves.value = [];
  await loadSession();
}
