// Her room (docs/design/her-room.md): a member alone with her on the site. It is a DM on its own
// platform, `web`, whose author is the member's own (Discord) account: the room's context names the
// account in its channel (`a.<platform>.<id>`), so every DM rule (memory scope, privacy, quota,
// `<feel>`) applies as it does to their Discord DM, while her replies go to the room's sink.
//
// What the room's files are to the downloaders lives here too: a file attached on the site has a
// `https://uploads.room.invalid/<id>` URL that only the room's service answers, without a network.

import type { AccountRef, ContextKey } from "@miyoria/contracts/wire";
import { type ServiceKey, serviceKey } from "./service-key.js";

/** The room's platform id. */
export const ROOM_PLATFORM = "web";

/** Her own account on the room's platform: the author of her lines' echoes. */
export const ROOM_SELF: AccountRef = { platform: ROOM_PLATFORM, id: "her" };

const CHANNEL_PREFIX = "a.";

/** The room of `account`: a DM on `web` whose channel names the account. */
export function roomContext(account: AccountRef): ContextKey {
  return {
    platform: ROOM_PLATFORM,
    scope: null,
    channel: `${CHANNEL_PREFIX}${account.platform}.${account.id}`,
    kind: "dm",
  };
}

/** Whether `context` is somebody's room. */
export function isRoomContext(context: ContextKey): boolean {
  return roomAccount(context) !== null;
}

/** The account whose room `context` is; `null` for any other context. */
export function roomAccount(context: ContextKey): AccountRef | null {
  if (context.platform !== ROOM_PLATFORM || context.scope !== null || context.kind !== "dm") {
    return null;
  }
  if (!context.channel.startsWith(CHANNEL_PREFIX)) return null;
  const rest = context.channel.slice(CHANNEL_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const platform = rest.slice(0, dot);
  // A room is a member's: never one of the room's own platform.
  if (platform === ROOM_PLATFORM) return null;
  return { platform, id: rest.slice(dot + 1) };
}

/** The host of a file attached on the site. `.invalid` never resolves (RFC 2606). */
export const INCOMING_FILE_HOST = "uploads.room.invalid";

/** `fetch` as the downloaders use it. */
export type IncomingFetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: "error" },
) => Promise<Response>;

/** Files people attached on the site, handed to the downloaders without a network. */
export interface IncomingFiles {
  /** Whether `url` is one of these files' (it may still be gone when fetched). */
  handles(url: string): boolean;
  /** The file's bytes (`content-length` set), or a 404 response when it is gone. */
  fetch(url: string, init: { signal: AbortSignal; redirect: "error" }): Promise<Response>;
}

export const IncomingFilesKey = serviceKey<IncomingFiles>("IncomingFiles");

/** The part of the service registry these helpers read (the kernel's `ServiceLookup` is one). */
export interface IncomingFilesLookup {
  get<T>(key: ServiceKey<T>): T | undefined;
}

/** Whether `url` is HTTPS on the incoming files' host. */
export function isIncomingFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === INCOMING_FILE_HOST;
}

/** Whether a downloader may take `url` although its host is not on its list: the room's file. */
export function incomingAllowed(services: IncomingFilesLookup, url: string): boolean {
  if (!isIncomingFileUrl(url)) return false;
  return services.get(IncomingFilesKey)?.handles(url) === true;
}

/**
 * A fetch that hands the room's files to the service and every other URL to `fallback` (the real
 * `fetch` by default). An incoming URL nobody answers is a 404, never a network request.
 */
export function incomingFetch(
  services: IncomingFilesLookup,
  fallback: IncomingFetchLike = (url, init) => fetch(url, init),
): IncomingFetchLike {
  return (url, init) => {
    if (!isIncomingFileUrl(url)) return fallback(url, init);
    const files = services.get(IncomingFilesKey);
    if (files === undefined || !files.handles(url)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return files.fetch(url, init);
  };
}

/** Why her voice cannot be heard in the room: not set up, lent to singing, or failing lately. */
export type HerVoiceDown = "off" | "lent" | "failing";

/** Her voice for one line, outside a voice channel (the room). Provided by `voice`. */
export interface HerVoice {
  available(): { ok: true } | { ok: false; why: HerVoiceDown };
  /** Reviewed, translated and synthesized like a voice line, at priority `ahead`. */
  speak(
    text: string,
    emotion: string | null,
    signal: AbortSignal,
  ): Promise<{ sampleRate: number; samples: Int16Array }>;
}

export const HerVoiceKey = serviceKey<HerVoice>("HerVoice");
