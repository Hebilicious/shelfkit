/**
 * The keyboard map, as a pure function of key presses so it can be tested without a browser:
 *
 * | Keys | Does |
 * | --- | --- |
 * | `/` | focus the screen's search |
 * | `g` then a letter | go to a screen (`g p`: profiles) |
 * | `j`, `k` | move down, up in the screen's list |
 * | `Enter`, `o` | open the selected entry |
 * | `x` | select the entry (the shelf's bulk select) |
 * | `f` | favourite the selected prompt |
 * | `u`, Ctrl/⌘+Z | undo the last destructive action |
 * | `?` | show this map |
 * | `Escape` | leave a field, close a dialog |
 *
 * Keys typed into a field are the field's, except `Escape`.
 */

/** The screens `g` reaches, by the letter that follows it. */
export const GO_KEYS = {
  ",": "settings",
  a: "activity",
  c: "compose",
  i: "import",
  k: "compile",
  l: "prompts",
  p: "profiles",
  s: "shelf",
} as const;

export type GoTarget = (typeof GO_KEYS)[keyof typeof GO_KEYS];

export type KeyAction =
  | { readonly kind: "focus-search" }
  | { readonly kind: "go"; readonly to: GoTarget }
  | { readonly kind: "move"; readonly by: 1 | -1 }
  | { readonly kind: "open" }
  | { readonly kind: "select" }
  | { readonly kind: "favourite" }
  | { readonly kind: "undo" }
  | { readonly kind: "help" }
  | { readonly kind: "escape" };

/** What the map needs from a key press. */
export interface KeyPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  /** Focus is in a text field, a select, or editable content. */
  readonly inField: boolean;
  /** Milliseconds, from the event's own timestamp. */
  readonly at: number;
}

/** How long a `g` waits for its second key. */
export const SEQUENCE_WINDOW_MS = 1500;

function isGoKey(key: string): key is keyof typeof GO_KEYS {
  return Object.hasOwn(GO_KEYS, key);
}

/** The keyboard map's state: whether a `g` is waiting for its second key. */
export interface KeyState {
  readonly pendingSince: number | null;
}

export const INITIAL_KEY_STATE: KeyState = { pendingSince: null };

/** What one press does: the map's next state, and the action it asks for, or `null` for none. */
export interface KeyResult {
  readonly state: KeyState;
  readonly action: KeyAction | null;
}

/** The keys that act alone, outside a `g` sequence. */
const SINGLE_KEYS = new Map<string, KeyAction>([
  ["/", { kind: "focus-search" }],
  ["j", { by: 1, kind: "move" }],
  ["ArrowDown", { by: 1, kind: "move" }],
  ["k", { by: -1, kind: "move" }],
  ["ArrowUp", { by: -1, kind: "move" }],
  ["Enter", { kind: "open" }],
  ["o", { kind: "open" }],
  ["x", { kind: "select" }],
  ["f", { kind: "favourite" }],
  ["u", { kind: "undo" }],
  ["?", { kind: "help" }],
]);

function settled(action: KeyAction | null): KeyResult {
  return { action, state: INITIAL_KEY_STATE };
}

function isUndoChord(press: KeyPress): boolean {
  return (
    (press.ctrlKey || press.metaKey) &&
    !press.altKey &&
    press.key.toLowerCase() === "z" &&
    !press.inField
  );
}

/** The next state, and the action a press asks for. */
export function interpret(state: KeyState, press: KeyPress): KeyResult {
  if (press.key === "Escape") {
    return settled({ kind: "escape" });
  }
  if (isUndoChord(press)) {
    return settled({ kind: "undo" });
  }
  if (press.inField || press.ctrlKey || press.metaKey || press.altKey) {
    return settled(null);
  }
  if (
    state.pendingSince !== null &&
    press.at - state.pendingSince <= SEQUENCE_WINDOW_MS
  ) {
    return settled(
      isGoKey(press.key) ? { kind: "go", to: GO_KEYS[press.key] } : null
    );
  }
  if (press.key === "g") {
    return { action: null, state: { pendingSince: press.at } };
  }
  return settled(SINGLE_KEYS.get(press.key) ?? null);
}

/** The index a move lands on: clamped to the list, and the first entry when nothing was selected. */
export function moveIndex(current: number, by: 1 | -1, length: number): number {
  if (length === 0) {
    return -1;
  }
  if (current < 0) {
    return by === 1 ? 0 : length - 1;
  }
  return Math.max(0, Math.min(length - 1, current + by));
}
