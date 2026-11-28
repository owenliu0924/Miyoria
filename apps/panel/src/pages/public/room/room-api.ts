// The page talks to the Core only through `RoomApi` (docs/design/her-room.md §7.3): the JSON routes
// through the route table's client (`api.rpc.room.*`), the stream as its event iterator, and the
// three routes that are not JSON (an upload's raw body, her voice's WAV, her file) with the headers
// every member request carries (`ApiClient.headers`: the CSRF guard, same-origin credentials, no
// bearer token). The dev demo and the tests put their own in with `setRoomApiFactory`.

import { getEventMeta } from "@orpc/client";
import type { Api } from "@/api/endpoints";
import { ApiError, type ApiClient, type ApiErrorKind } from "@/api/http";
import type {
  RoomBacklog,
  RoomEvent,
  RoomRelation,
  RoomSendRequest,
  RoomSendResult,
  RoomState,
  RoomUpload,
} from "@miyoria/contracts/api";

// The contract's paths (`ROOM_UPLOAD_PATH`, `roomVoicePath`, `roomFilePath`), written out here: a
// value from `@miyoria/contracts/api` would bring zod into the page's bundle.
export const ROOM_UPLOAD_PATH = "/api/member/room/uploads";
export const roomVoicePath = (line: string) => `/api/member/room/voice/${encodeURIComponent(line)}`;
export const roomFilePath = (line: string, n: number) => `/api/member/room/files/${encodeURIComponent(line)}/${n}`;

export interface RoomApi {
  state(signal?: AbortSignal): Promise<RoomState>;
  backlog(older: string | null, signal?: AbortSignal): Promise<RoomBacklog>;
  relation(signal?: AbortSignal): Promise<RoomRelation>;
  send(request: RoomSendRequest): Promise<RoomSendResult>;
  /**
   * `POST ROOM_UPLOAD_PATH`, the file as the body, its name in `X-Miyoria-Filename`. `onProgress`
   * hears how much of it went up, 0..1.
   */
  upload(file: File, signal?: AbortSignal, onProgress?: (sent: number) => void): Promise<RoomUpload>;
  forgetMemory(id: string): Promise<{ forgotten: boolean }>;
  excludeLine(id: string): Promise<{ excluded: boolean }>;
  /** `GET roomVoicePath(line)` with the CSRF header; a WAV. */
  voice(line: string, signal?: AbortSignal): Promise<Blob>;
  /** `GET roomFilePath(line, n)`; saved by the page as a download. */
  file(line: string, n: number, signal?: AbortSignal): Promise<{ blob: Blob; name: string }>;
  /** Follows the stream until `signal` aborts; resolves when it ends (the caller reconnects). */
  follow(options: {
    lastEventId: string | null;
    signal: AbortSignal;
    onEvent: (event: RoomEvent, id: string | null) => void;
  }): Promise<void>;
}

/** The kind of a failed answer, as `http.ts` tells them apart. */
function kindOf(status: number, message: string, json: boolean): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 404) return message === "no such endpoint" || !json ? "not_provided" : "not_found";
  if (status === 503) return "unavailable";
  return "http";
}

/** A failed answer of a route that is not JSON, as an `ApiError` with the Core's own words. */
async function errorOf(res: Response, path: string): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let message = "";
  let json = false;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") {
      message = body.error;
      json = true;
    }
  } catch {
    // Not the Core.
  }
  return new ApiError(kindOf(res.status, message, json), res.status, path, message || `HTTP ${res.status}`);
}

const offline = (path: string) => new ApiError("network", 0, path, "連不上她的房間");

/** A file's name from `Content-Disposition` (`filename*=UTF-8''…` first). */
export function dispositionName(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      // Fall through to the plain name.
    }
  }
  return /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

/** The real one: the Core's routes. */
export function createRoomApi(api: Api, client: ApiClient): RoomApi {
  const get = async (path: string, accept: string, signal?: AbortSignal): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(client.url(path), { headers: client.headers({ Accept: accept }, true), signal, credentials: "same-origin" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw offline(path);
    }
    if (!res.ok) throw await errorOf(res, path);
    return res;
  };
  return {
    state: (signal) => api.rpc.room.state(undefined, { signal }),
    backlog: (older, signal) => api.rpc.room.backlog({ query: older ? { before: older } : {} }, { signal }),
    relation: (signal) => api.rpc.room.relation(undefined, { signal }),
    send: (request) => api.rpc.room.send({ body: request }),
    forgetMemory: (id) => api.rpc.room.forgetMemory({ params: { id }, body: { confirm: true } }),
    excludeLine: (id) => api.rpc.room.excludeLine({ params: { id }, body: { confirm: true } }),
    upload: (file, signal, onProgress) =>
      new Promise<RoomUpload>((resolve, reject) => {
        // `XMLHttpRequest`, not `fetch`: only it says how much of the body went up.
        const xhr = new XMLHttpRequest();
        // Same origin: the session cookie goes with it as with `fetch`'s `same-origin`.
        xhr.open("POST", client.url(ROOM_UPLOAD_PATH));
        const headers = client.headers(
          { "Content-Type": file.type || "application/octet-stream", "X-Miyoria-Filename": encodeURIComponent(file.name) },
          true,
        );
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
        };
        xhr.onload = () => {
          const res = new Response(xhr.responseText, { status: xhr.status });
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText) as RoomUpload);
            } catch {
              reject(new ApiError("bad_response", xhr.status, ROOM_UPLOAD_PATH, "回應不是 JSON"));
            }
            return;
          }
          void errorOf(res, ROOM_UPLOAD_PATH).then(reject);
        };
        xhr.onerror = () => reject(offline(ROOM_UPLOAD_PATH));
        xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(file);
      }),
    voice: async (line, signal) => (await get(roomVoicePath(line), "audio/wav", signal)).blob(),
    file: async (line, n, signal) => {
      const res = await get(roomFilePath(line, n), "*/*", signal);
      return { blob: await res.blob(), name: dispositionName(res.headers.get("content-disposition"), "file") };
    },
    follow: async ({ lastEventId, signal, onEvent }) => {
      const stream = await api.rpc.room.stream(undefined, { signal, ...(lastEventId ? { lastEventId } : {}) });
      const stop = () => void stream.return().catch(() => undefined);
      signal.addEventListener("abort", stop, { once: true });
      try {
        for await (const event of stream) onEvent(event as RoomEvent, getEventMeta(event)?.id ?? null);
      } finally {
        signal.removeEventListener("abort", stop);
      }
    },
  };
}

let factory: ((api: Api, client: ApiClient) => RoomApi) | null = null;

/** Replaces the Core with a stand-in (the dev demo's, or a test's); `null` puts the Core back. */
export function setRoomApiFactory(make: ((api: Api, client: ApiClient) => RoomApi) | null): void {
  factory = make;
}

/** The room's API for this connection. */
export function roomApiFor(api: Api, client: ApiClient): RoomApi {
  return factory ? factory(api, client) : createRoomApi(api, client);
}
