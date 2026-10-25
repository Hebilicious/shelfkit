/**
 * Live updates: `subscription { shelfChanged(shelf) }` over server-sent events, pushed from the shelf's own Durable
 * Object (`docs/PRD.md` section 10.2). Every event marks the shelf's cached answers stale (`data/cache.ts`), so a
 * prompt edited in another tab, an import finishing, or a `shelfkit push` shows up without a reload, while every screen
 * keeps showing what it has until the new answer lands. `EventSource` reconnects by itself after a dropped connection.
 */
import * as v from "valibot";
import { ref } from "vue";

import { getUrl } from "../api/graphql.ts";
import { ShelfChangedSubscription } from "../api/operations.ts";
import { invalidate, shelfPrefix } from "../data/cache.ts";
import { loadSession } from "./session.ts";

/** Every cached answer about `shelf` is out of date. */
function changed(shelf: string): void {
  invalidate(shelfPrefix(shelf));
}

/** The connection's state, for the indicator in the header. */
export const liveState = ref<"off" | "connecting" | "live">("off");

/** One change to the shelf, as `shelfChanged` pushes it. */
export interface ShelfChange {
  readonly kind: string;
  readonly id: string;
  readonly at: string;
}

/** The last change, for the header's indicator. */
export const lastChange = ref<ShelfChange | null>(null);

let source: EventSource | null = null;
let subscribed: string | null = null;
/** The server refused the current subscription: the viewer cannot read the shelf. */
let refused = false;

const EventSchema = v.object({
  data: v.object({
    shelfChanged: v.object({
      at: v.string(),
      id: v.string(),
      kind: v.string(),
    }),
  }),
});

/** A `next` event that carries errors: the server refused the subscription (a shelf this viewer cannot read). */
const RefusalSchema = v.object({
  errors: v.pipe(v.array(v.unknown()), v.minLength(1)),
});

/**
 * One `next` event: a change, a refusal, or `null` for anything else.
 * BOUNDARY: an SSE message's data is unparsed text; `EventSchema` and `RefusalSchema` parse it here.
 */
function readEvent(data: unknown): ShelfChange | "refused" | null {
  if (!v.is(v.string(), data)) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(data);
    const parsed = v.safeParse(EventSchema, value);
    if (parsed.success) {
      return parsed.output.data.shelfChanged;
    }
    return v.is(RefusalSchema, value) ? "refused" : null;
  } catch {
    // Not JSON: a message this client does not know.
    return null;
  }
}

/** The first wait before reconnecting, doubled after each failure up to `RECONNECT_MAX_MS`. */
const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

let reconnectDelay = RECONNECT_FIRST_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function disconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  source?.close();
  source = null;
}

/** Try again after the current delay, and wait longer the next time. */
function scheduleReconnect(shelf: string): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (subscribed === shelf) {
      connect(shelf);
    }
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

/**
 * Open the subscription. `EventSource` retries a dropped connection by itself, but gives up for good on an error
 * answer (a 503, say): then this reconnects, backing off. A connection that opens after any error marks every
 * answer about the shelf stale, since changes made while it was down sent no event.
 */
function connect(shelf: string): void {
  disconnect();
  refused = false;
  liveState.value = "connecting";
  let missedChanges = reconnectDelay !== RECONNECT_FIRST_MS;
  const next = new EventSource(getUrl(ShelfChangedSubscription, { shelf }), {
    withCredentials: true,
  });
  next.addEventListener("open", () => {
    liveState.value = "live";
    reconnectDelay = RECONNECT_FIRST_MS;
    if (missedChanges) {
      missedChanges = false;
      changed(shelf);
    }
  });
  next.addEventListener("error", () => {
    liveState.value = "connecting";
    missedChanges = true;
    if (next.readyState === EventSource.CLOSED && source === next) {
      scheduleReconnect(shelf);
    }
  });
  next.addEventListener("next", (message: MessageEvent<unknown>) => {
    const event = readEvent(message.data);
    if (event === "refused") {
      // This viewer cannot read the shelf. Asking again would be refused again, and each new connection marks the
      // shelf stale, so its page would load over and over; signing in follows the shelf anew (`followShelf`).
      refused = true;
      return;
    }
    if (event !== null) {
      lastChange.value = event;
      changed(shelf);
      // A key was created or revoked: it may be the one this browser holds.
      if (event.kind === "keys") {
        void loadSession();
      }
    }
  });
  // The server ended the subscription; the shelf is still followed, so subscribe again, unless it refused.
  next.addEventListener("complete", () => {
    next.close();
    if (source !== next) {
      return;
    }
    if (refused) {
      source = null;
      liveState.value = "off";
      return;
    }
    liveState.value = "connecting";
    scheduleReconnect(shelf);
  });
  source = next;
}

/** Follow one shelf's changes, replacing any shelf followed before; `null` stops following. */
export function followShelf(shelf: string | null): void {
  if (shelf === subscribed) {
    return;
  }
  disconnect();
  subscribed = shelf;
  reconnectDelay = RECONNECT_FIRST_MS;
  if (shelf === null || typeof EventSource === "undefined") {
    liveState.value = "off";
    return;
  }
  connect(shelf);
}

/** Subscribe again to the shelf followed now, as a viewer who signed in may read what was refused before. */
export function refollow(): void {
  if (subscribed !== null && typeof EventSource !== "undefined") {
    reconnectDelay = RECONNECT_FIRST_MS;
    connect(subscribed);
  }
}
