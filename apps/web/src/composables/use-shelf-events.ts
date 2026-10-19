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

/** Follow one shelf's changes, replacing any shelf followed before; `null` stops following. */
export function followShelf(shelf: string | null): void {
  if (shelf === subscribed) {
    return;
  }
  source?.close();
  source = null;
  subscribed = shelf;
  if (shelf === null || typeof EventSource === "undefined") {
    liveState.value = "off";
    return;
  }
  liveState.value = "connecting";
  const next = new EventSource(getUrl(ShelfChangedSubscription, { shelf }), {
    withCredentials: true,
  });
  next.addEventListener("open", () => {
    liveState.value = "live";
  });
  next.addEventListener("error", () => {
    liveState.value = "connecting";
  });
  next.addEventListener("next", (message: MessageEvent<unknown>) => {
    const event = readEvent(message.data);
    if (event !== null) {
      lastChange.value = event;
      shelfChanges.value += 1;
    }
  });
  next.addEventListener("complete", () => {
    next.close();
    liveState.value = "off";
  });
  source = next;
}
