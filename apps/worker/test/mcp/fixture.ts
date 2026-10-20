/**
 * AcidCat's conformance fixture (`@acid-cat/cli`'s `conformance/fixture.acidcat.json`), written with Valibot as
 * ShelfKit writes its own capabilities, so `acid-cat conform` can drive `/mcp`'s composition (`src/mcp/compose.ts`)
 * with it in place of ShelfKit's tools. The switch and the held calls are shared by every request, as one deployment's
 * state would be; each request still gets its own context.
 */
import {
  AVAILABLE,
  capabilitiesFor,
  defineApp,
  fail,
  ok,
  unavailable,
} from "@acid-cat/core-ts";
import type { Availability, Observable } from "@acid-cat/core-ts";
import * as v from "valibot";

/** The switch that `fixture.switch.set` turns, and that `fixture.toggle`'s availability follows. */
export class Switch implements Observable<Availability> {
  #on = true;
  readonly #listeners = new Set<(value: Availability) => void>();

  set(on: boolean): void {
    this.#on = on;
    for (const listener of this.#listeners) {
      listener(this.getSnapshot());
    }
  }

  getSnapshot(): Availability {
    return this.#on ? AVAILABLE : unavailable("The switch is off.");
  }

  subscribe(listener: (value: Availability) => void) {
    this.#listeners.add(listener);
    return {
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }
}

/** Calls to `fixture.hold` that have not ended: each waits until `fixture.release` names its key, or it is cancelled. */
export interface Holds {
  readonly hold: (key: string, signal: AbortSignal) => Promise<void>;
  readonly release: (key: string) => void;
  readonly keys: () => string[];
}

export function createHolds(): Holds {
  const held = new Map<string, () => void>();
  return {
    hold: async (key, signal) => {
      signal.throwIfAborted();
      // oxlint-disable-next-line promise/avoid-new -- a hold is settled from outside: by fixture.release, or a cancellation.
      await new Promise<void>((resolve, reject) => {
        held.set(key, resolve);
        signal.addEventListener("abort", () => {
          held.delete(key);
          reject(new Error(`the hold on ${key} was cancelled`));
        });
      });
    },
    keys: () => [...held.keys()],
    release: (key) => {
      const resolve = held.get(key);
      held.delete(key);
      resolve?.();
    },
  };
}

export interface FixtureContext {
  readonly switch: Switch;
  readonly holds: Holds;
}

const capability = capabilitiesFor<FixtureContext>();

const everywhere = ["app", "mcp", "cli", "api"];
const Text = v.object({ text: v.string() });
const Key = v.object({ key: v.string() });
const Flags = v.object({
  count: v.optional(v.pipe(v.number(), v.integer())),
  extra: v.optional(v.record(v.string(), v.unknown())),
  label: v.optional(v.string()),
  mode: v.picklist(["fast", "slow"]),
  ratio: v.optional(v.number()),
  verbose: v.optional(v.boolean()),
});

export const fixture = defineApp<FixtureContext>({
  capabilities: [
    capability({
      audience: everywhere,
      description: "Always fail with a defect.",
      id: "fixture.crash",
      run: () => {
        throw new Error("secret internal detail");
      },
    }),
    capability({
      audience: everywhere,
      description: "Return the input text.",
      id: "fixture.echo",
      input: Text,
      output: Text,
      readOnly: true,
      run: (input) => ok(input),
    }),
    capability({
      audience: ["cli"],
      description:
        "Return the input. The input has one property for each kind of command-line flag.",
      id: "fixture.flags",
      input: Flags,
      output: Flags,
      run: (input) => ok(input),
    }),
    capability({
      audience: everywhere,
      description:
        "Return the keys of the calls to fixture.hold that hold now.",
      id: "fixture.held",
      output: v.object({ keys: v.array(v.string()) }),
      readOnly: true,
      run: (_none, { context }) => ok({ keys: context.holds.keys() }),
    }),
    capability({
      audience: ["app"],
      description: "Only the app target can use this capability.",
      id: "fixture.hidden",
      run: () => ok(null),
    }),
    capability({
      audience: everywhere,
      // The marker matters to the command line only; the MCP binding never sends one.
      description:
        "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives " +
        "the key. With a marker, the call writes a file at that path when it starts to hold.",
      id: "fixture.hold",
      input: v.object({ key: v.string(), marker: v.optional(v.string()) }),
      output: Key,
      run: async ({ key }, { context, signal }) => {
        await context.holds.hold(key, signal);
        return ok({ key });
      },
    }),
    capability({
      audience: everywhere,
      description: "Always return the failure Refused.",
      failures: {
        Refused: v.object({ _tag: v.literal("Refused"), reason: v.string() }),
      },
      id: "fixture.refuse",
      run: () => fail("Refused", { reason: "No." }),
    }),
    capability({
      audience: everywhere,
      description: "Release the calls to fixture.hold that hold the key.",
      id: "fixture.release",
      input: Key,
      run: ({ key }, { context }) => {
        context.holds.release(key);
        return ok(null);
      },
    }),
    capability({
      audience: everywhere,
      description:
        "Turn the switch on or off. The switch controls the availability of fixture.toggle.",
      id: "fixture.switch.set",
      input: v.object({ on: v.boolean() }),
      run: ({ on }, { context }) => {
        context.switch.set(on);
        return ok(null);
      },
    }),
    capability({
      audience: everywhere,
      availability: (context) => context.switch,
      description: "Available only while the switch is on.",
      id: "fixture.toggle",
      input: v.object({}),
      run: () => ok(null),
    }),
  ],
  description: "One capability for each behavior that acid-cat conform tests.",
  targets: {
    api: { bindings: ["http"] },
    app: { bindings: ["typescript", "webmcp"] },
    cli: { bindings: ["cli"] },
    mcp: { bindings: ["mcp"] },
  },
  title: "AcidCat conformance fixture",
});
