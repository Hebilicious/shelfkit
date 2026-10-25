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
import { forgetEverything } from "../data/cache.ts";

export type Viewer = ResultOf<typeof ViewerQuery>["viewer"];
export type ShelfEntry = ResultOf<typeof ViewerQuery>["shelves"][number];

/**
 * The last answer, kept so a reload paints the header and the shelf list at once; `loadSession` checks it. When the
 * principal it names is not who the browser is now, every cached answer is dropped with it (`data/cache.ts`).
 */
const SESSION_KEY = "shelfkit:session:v1";

interface StoredSession {
  readonly viewer: Viewer;
  readonly shelves: readonly ShelfEntry[];
}

/** BOUNDARY: `localStorage` holds what `remember` wrote, or what an earlier version wrote; a shape check guards it. */
function recalled(): StoredSession | null {
  try {
    const text = localStorage.getItem(SESSION_KEY);
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "viewer" in parsed &&
      "shelves" in parsed &&
      Array.isArray(parsed.shelves) &&
      typeof parsed.viewer === "object" &&
      parsed.viewer !== null &&
      "authenticated" in parsed.viewer
    ) {
      // SAFETY: written by `remember` from a `ViewerQuery` answer; the checks above reject anything else this key held.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SAFETY note above is why this is a `StoredSession`.
      return parsed as StoredSession;
    }
  } catch {
    // Unreadable or unavailable: start unknown.
  }
  return null;
}

function remember(session: StoredSession | null): void {
  try {
    if (session === null) {
      localStorage.removeItem(SESSION_KEY);
    } else {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
  } catch {
    // Unavailable: the next visit asks the service first.
  }
}

/** Who a viewer is, for telling whether the cached answers were theirs. */
/** Who the viewer is, as one string: it changes exactly when signing in, out, or as someone else. */
export function identity(current: Viewer | null): string {
  return current === null
    ? ""
    : `${current.principal ?? ""}\u0000${current.keyId ?? ""}\u0000${String(current.authenticated)}`;
}

const initial = recalled();

export const viewer = shallowRef<Viewer | null>(initial?.viewer ?? null);
export const shelves = shallowRef<readonly ShelfEntry[]>(
  initial?.shelves ?? []
);
export const sessionError = ref<string | null>(null);
/** Whether `viewer` has been confirmed by the service in this page, rather than recalled from the last visit. */
export const sessionChecked = ref(false);

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
    if (identity(data.viewer) !== identity(viewer.value)) {
      forgetEverything();
    }
    viewer.value = data.viewer;
    shelves.value = data.shelves;
    sessionError.value = null;
    sessionChecked.value = true;
    remember({ shelves: data.shelves, viewer: data.viewer });
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
  forgetEverything();
  remember(null);
  viewer.value = null;
  shelves.value = [];
  await loadSession();
}
