import { describe, expect, it } from "vitest";

import {
  INITIAL_KEY_STATE,
  interpret,
  moveIndex,
  SEQUENCE_WINDOW_MS,
} from "../../src/lib/keys.ts";
import type { KeyAction, KeyPress, KeyState } from "../../src/lib/keys.ts";

function press(key: string, at = 0, extra: Partial<KeyPress> = {}): KeyPress {
  return {
    altKey: false,
    at,
    ctrlKey: false,
    inField: false,
    key,
    metaKey: false,
    ...extra,
  };
}

function run(presses: readonly KeyPress[]): (KeyAction | null)[] {
  let state: KeyState = INITIAL_KEY_STATE;
  return presses.map((next) => {
    const { action, state: after } = interpret(state, next);
    state = after;
    return action;
  });
}

describe("the keyboard map", () => {
  it("focuses search with /", () => {
    expect(run([press("/")])).toStrictEqual([{ kind: "focus-search" }]);
  });

  it("goes to profiles with g then p", () => {
    expect(run([press("g", 0), press("p", 200)])).toStrictEqual([
      null,
      { kind: "go", to: "profiles" },
    ]);
  });

  it("forgets a g after the window", () => {
    expect(
      run([press("g", 0), press("p", SEQUENCE_WINDOW_MS + 1)])
    ).toStrictEqual([null, null]);
  });

  it("moves with j and k", () => {
    expect(run([press("j"), press("k")])).toStrictEqual([
      { by: 1, kind: "move" },
      { by: -1, kind: "move" },
    ]);
  });

  it("leaves keys typed into a field alone, except Escape", () => {
    expect(
      run([
        press("j", 0, { inField: true }),
        press("Escape", 0, { inField: true }),
      ])
    ).toStrictEqual([null, { kind: "escape" }]);
  });

  it("undoes with u and with Ctrl+Z outside a field", () => {
    expect(
      run([
        press("u"),
        press("z", 0, { ctrlKey: true }),
        press("z", 0, { ctrlKey: true, inField: true }),
      ])
    ).toStrictEqual([{ kind: "undo" }, { kind: "undo" }, null]);
  });

  it("clamps list moves and starts from the edge", () => {
    expect(moveIndex(-1, 1, 3)).toBe(0);
    expect(moveIndex(-1, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(2);
    expect(moveIndex(0, -1, 3)).toBe(0);
    expect(moveIndex(0, 1, 0)).toBe(-1);
  });
});
