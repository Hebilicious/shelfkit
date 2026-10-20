/**
 * Messages at the foot of the screen, and undo. A destructive action the service can reverse (deleting an item or a
 * profile, removing a source or a secret name, making a shelf private) leaves a toast whose Undo puts it back; `u` or
 * Ctrl/⌘+Z does the same for the newest one. An action that cannot be reversed (revoking a key) asks first instead.
 */
import { ref } from "vue";

import { messageOf } from "../api/graphql.ts";

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: "info" | "error";
  readonly undo: (() => Promise<void>) | null;
}

export const toasts = ref<Toast[]>([]);

let nextId = 1;
const LIFETIME_MS = 8000;

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Show a message; with `undo`, offer to reverse what it reports. */
export function notify(
  message: string,
  undo: (() => Promise<void>) | null = null,
  tone: Toast["tone"] = "info"
): void {
  const id = nextId;
  nextId += 1;
  toasts.value = [...toasts.value.slice(-3), { id, message, tone, undo }];
  setTimeout(
    () => {
      dismiss(id);
    },
    undo === null ? LIFETIME_MS / 2 : LIFETIME_MS
  );
}

/** BOUNDARY: a `catch` hands over whatever was thrown; `messageOf` reads it. */
export function notifyError(error: unknown): void {
  notify(messageOf(error), null, "error");
}

/** Run a toast's undo, once. */
export async function runUndo(id: number): Promise<void> {
  const toast = toasts.value.find((entry) => entry.id === id);
  if (toast?.undo === null || toast === undefined) {
    return;
  }
  dismiss(id);
  try {
    await toast.undo();
    notify("Undone.");
  } catch (error) {
    notifyError(error);
  }
}

/** Undo the newest action that can be undone, if any. */
export async function undoLatest(): Promise<void> {
  const latest = toasts.value.findLast((toast) => toast.undo !== null);
  if (latest !== undefined) {
    await runUndo(latest.id);
  }
}
