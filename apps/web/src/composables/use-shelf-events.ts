/**
 * Live updates: `subscription { shelfChanged(shelf) }` over server-sent events, pushed from the shelf's own Durable
 * Object (`docs/PRD.md` section 10.2). Every event bumps `shelfChanges`, which every `useQuery` watches, so a prompt
 * edited in another tab, an import finishing, or a `shelfkit push` shows up without a reload. `EventSource` reconnects
 * by itself after a dropped connection.
 */
import * as v from "valibot";
import { ref } from "vue";

import { getUrl } from "../api/graphql.ts";
import { ShelfChangedSubscription } from "../api/operations.ts";
import { loadSession } from "./session.ts";

/** How many changes the current shelf has seen since the page loaded. */
export const shelfChanges = ref(0);

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

const EventSchema = v.object({
  data: v.object({
    shelfChanged: v.object({
      at: v.string(),
      id: v.string(),
      kind: v.string(),
    }),
  }),
});

/**
 * One `next` event's change, or `null` for anything else.
 * BOUNDARY: an SSE message's data is unparsed text; `EventSchema` parses it here.
 */
function readEvent(data: unknown): ShelfChange | null {
  if (!v.is(v.string(), data)) {
    return null;
  }
  try {
    const parsed = v.safeParse(EventSchema, JSON.parse(data));
    return parsed.success ? parsed.output.data.shelfChanged : null;
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
 * answer (a 503, say): then this reconnects, backing off. A connection that opens after any error refetches every
 * screen's data, since changes made while it was down sent no event.
 */
function connect(shelf: string): void {
  disconnect();
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
      shelfChanges.value += 1;
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
    if (event !== null) {
      lastChange.value = event;
      shelfChanges.value += 1;
      // A key was created or revoked: it may be the one this browser holds.
      if (event.kind === "keys") {
        void loadSession();
      }
    }
  });
  // The server ended the subscription; the shelf is still followed, so subscribe again.
  next.addEventListener("complete", () => {
    next.close();
    if (source === next) {
      liveState.value = "connecting";
      scheduleReconnect(shelf);
    }
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
