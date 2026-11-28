// The room as the page uses it: the reducer (`room-store.ts`) fed by the state, the backlog and the
// stream, and the page's own actions (send, older pages, the next step, 不要記住這句).

import { useCallback, useEffect, useReducer, useRef } from "react";
import { isApiError } from "@/api/http";
import type { RoomFile } from "@miyoria/contracts/api";
import type { RoomApi } from "./room-api";
import { initialModel, reduce } from "./room-store";
import { followRoom } from "./room-stream";
import { problemOf } from "./room-text";

/** A fresh id for one send (`ROOM_CLIENT_ID`: 8 to 64 of `[A-Za-z0-9_-]`). */
export function newClientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[b & 63]).join("");
}

export type Unavailable = "missing" | "logged_out" | null;

export function useRoom(api: RoomApi) {
  const [model, dispatch] = useReducer(reduce, undefined, initialModel);
  const [unavailable, setUnavailable] = useReducer((_: Unavailable, next: Unavailable) => next, null);
  const loading = useRef<Promise<void> | null>(null);

  const readBacklog = useCallback(
    async (mode: "first" | "reset") => {
      try {
        const page = await api.backlog(null);
        dispatch({ type: "backlog", page, mode });
      } catch {
        // Kept as it was; the next reset or reload tries again.
      }
    },
    [api],
  );

  // Where things are, then the backlog and the stream.
  useEffect(() => {
    const ctl = new AbortController();
    api.state(ctl.signal).then(
      (state) => dispatch({ type: "state", state }),
      (error: unknown) => {
        if (ctl.signal.aborted) return;
        if (isApiError(error) && error.kind === "not_provided") setUnavailable("missing");
        else if (isApiError(error) && error.kind === "unauthorized") setUnavailable("logged_out");
      },
    );
    void readBacklog("first");
    const stop = followRoom(api, {
      onEvent: (event) => {
        dispatch({ type: "event", event });
        if (event.kind === "reset") void readBacklog("reset");
      },
      onLink: (link) => dispatch({ type: "link", link }),
    });
    return () => {
      ctl.abort();
      stop();
    };
  }, [api, readBacklog]);

  const olderRef = useRef(model.older);
  olderRef.current = model.older;
  const loadOlder = useCallback((): Promise<void> => {
    const cursor = olderRef.current;
    if (cursor === null) return Promise.resolve();
    if (loading.current) return loading.current;
    const run = api
      .backlog(cursor)
      .then((page) => dispatch({ type: "backlog", page, mode: "older" }))
      .catch(() => undefined)
      .finally(() => {
        loading.current = null;
      });
    loading.current = run;
    return run;
  }, [api]);

  /** Sends one line: on the stage at once; the error when it did not go (the caller keeps the words). */
  const send = useCallback(
    async (text: string, uploads: string[], files: RoomFile[]): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      const client_id = newClientId();
      dispatch({ type: "send", client_id, text, files, at: new Date().toISOString() });
      try {
        const result = await api.send({ text, uploads, client_id });
        dispatch({ type: "sent", client_id, result });
        return { ok: true };
      } catch (error) {
        dispatch({ type: "failed", client_id, message: problemOf(error) });
        return { ok: false, error };
      }
    },
    [api],
  );

  const exclude = useCallback(
    async (id: string): Promise<boolean> => {
      const { excluded } = await api.excludeLine(id);
      dispatch({ type: "excluded", id });
      return excluded;
    },
    [api],
  );

  return { model, dispatch, unavailable, send, loadOlder, exclude };
}
