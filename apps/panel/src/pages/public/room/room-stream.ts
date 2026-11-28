// Following the room's stream (docs/design/her-room.md §3.4): reconnects with a growing wait,
// resumes with `Last-Event-ID`, and treats silence as death (the server pings every 15 s; the
// panel's `watchdog`). A `reset` (the events since the last id are gone) is passed on like any
// event: the page reads the backlog again. No DOM.

import { isApiError } from "@/api/http";
import { type Death, watchdog } from "@/api/watchdog";
import type { RoomEvent } from "@miyoria/contracts/api";
import type { RoomApi } from "./room-api";
import type { RoomLink } from "./room-store";

/** The waits before trying again, in ms: longer each time, then the last one. */
export const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;
/** The wait after an answer that will not change soon (logged out, the room closed or not there). */
export const REFUSED_WAIT_MS = 60_000;
/** A stream that stayed open this long starts the waits from the first again. */
export const STABLE_MS = 30_000;

export interface FollowOptions {
  onEvent: (event: RoomEvent) => void;
  onLink: (link: RoomLink) => void;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called with `dead` when the stream goes silent; the panel's watchdog by default. */
  watch?: (dead: (why: Death) => void) => { seen(): void; stop(): void };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Whether a failure says "not soon again" rather than "try again". */
function refused(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.kind === "unauthorized" || error.kind === "not_provided" || error.status === 403;
}

/** Follows the room until the function it gives is called. */
export function followRoom(api: RoomApi, o: FollowOptions): () => void {
  const stop = new AbortController();
  const now = o.now ?? Date.now;
  const wait = o.sleep ?? sleep;
  const watch = o.watch ?? ((dead: (why: Death) => void) => watchdog(dead, now));
  let lastEventId: string | null = null;

  void (async () => {
    let attempt = 0;
    while (!stop.signal.aborted) {
      o.onLink(attempt === 0 ? "connecting" : "retrying");
      const inner = new AbortController();
      const signal = AbortSignal.any([stop.signal, inner.signal]);
      const died: { why: Death | null } = { why: null };
      const dog = watch((why) => {
        died.why = why;
        inner.abort();
      });
      let openedAt: number | null = null;
      let pause: number | null = null;
      try {
        await api.follow({
          lastEventId,
          signal,
          onEvent: (event, id) => {
            dog.seen();
            if (openedAt === null) {
              openedAt = now();
              o.onLink("open");
            }
            if (id !== null) lastEventId = id;
            if (event.kind !== "ping") o.onEvent(event);
          },
        });
      } catch (error) {
        if (stop.signal.aborted) break;
        if (died.why === null && refused(error)) pause = REFUSED_WAIT_MS;
      } finally {
        dog.stop();
      }
      if (stop.signal.aborted) break;
      if (died.why === "asleep") {
        // The page slept (a laptop resumed): once, now, without waiting.
        attempt = 0;
        continue;
      }
      if (openedAt !== null && now() - openedAt >= STABLE_MS) attempt = 0;
      o.onLink("retrying");
      const ms = pause ?? (RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] as number);
      attempt += 1;
      await wait(ms, stop.signal);
    }
  })();

  return () => stop.abort();
}
