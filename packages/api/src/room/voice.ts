// Her voice in the room (docs/design/her-room.md §3.8): one WAV per line of hers, synthesized whole
// by the voice module's `HerVoiceKey` and kept a while, so two tabs asking for the same line make
// it once. Who may have it: the account whose room the line was said in, within 30 minutes.

import type { RoomState } from "@miyoria/contracts/api";
import { type AccountRef, accountRefString, HerVoiceKey } from "@miyoria/types";
import { ApiError } from "../errors.js";
import type { ApiState } from "../state.js";
import type { RoomHub } from "./channel.js";
import type { Room } from "./room.js";
import { ROOM_TEXT } from "./texts.js";

/** A line older than this has no voice any more. */
export const VOICE_LINE_MS = 30 * 60_000;
/** How long a synthesized line is kept. */
export const VOICE_CACHE_MS = 10 * 60_000;

/** A canonical 44-byte-header PCM WAV (mono, 16-bit little endian). */
export function encodeWav(sampleRate: number, samples: Int16Array): Uint8Array {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const v = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return out;
}

/** The last lines synthesized, by line id, each for `VOICE_CACHE_MS`. */
export class VoiceCache {
  readonly #map = new Map<string, { at: number; wav: Uint8Array }>();

  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  get(line: string): Uint8Array | null {
    const hit = this.#map.get(line);
    if (hit === undefined) return null;
    if (this.now() - hit.at >= VOICE_CACHE_MS) {
      this.#map.delete(line);
      return null;
    }
    this.#map.delete(line);
    this.#map.set(line, hit);
    return hit.wav;
  }

  set(line: string, wav: Uint8Array): void {
    if (this.max <= 0) return;
    this.#map.delete(line);
    this.#map.set(line, { at: this.now(), wav });
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }
}

/** Whether her voice can be played in `account`'s room now, and why not. */
export function voiceState(state: ApiState, room: Room, account: AccountRef): RoomState["voice"] {
  if (!room.config.voice) return { available: false, reason: ROOM_TEXT.voiceOff };
  const her = state.optional(HerVoiceKey);
  if (her === undefined) return { available: false, reason: ROOM_TEXT.voiceOff };
  const now = her.available();
  if (!now.ok) {
    const reason =
      now.why === "lent"
        ? ROOM_TEXT.voiceLent
        : now.why === "failing"
          ? ROOM_TEXT.voiceFailing
          : ROOM_TEXT.voiceOff;
    return { available: false, reason };
  }
  if (room.voicePerHour.wait(accountRefString(account), state.now()) !== null) {
    return { available: false, reason: ROOM_TEXT.voiceHour };
  }
  return { available: true, reason: null };
}

/** Whether a line of hers gets a voice key at all (`line.voice`). */
export function lineHasVoice(room: Room, text: string): boolean {
  const flat = text.trim();
  return room.config.voice && flat !== "" && [...flat].length <= room.config.voice_max_chars;
}

/** `GET /api/member/room/voice/{id}`: her line `id` in this account's room, as a WAV. */
export async function lineVoice(
  state: ApiState,
  room: Room,
  hub: RoomHub,
  line: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const her = hub.lines.get(line);
  if (her === undefined || state.now() - her.at > VOICE_LINE_MS || !lineHasVoice(room, her.text)) {
    throw ApiError.notFound(ROOM_TEXT.notFound);
  }
  const key = accountRefString(hub.account);
  const cached = room.voiceCache.get(line);
  if (cached !== null) return wavResponse(cached);
  const can = voiceState(state, room, hub.account);
  if (!can.available) {
    if (can.reason === ROOM_TEXT.voiceHour) {
      const wait = room.voicePerHour.wait(key, state.now()) ?? 1_000;
      throw new ApiError(429, ROOM_TEXT.voiceHour, {
        "retry-after": String(Math.max(1, Math.ceil(wait / 1000))),
      });
    }
    throw ApiError.unavailable(can.reason ?? ROOM_TEXT.voiceOff);
  }
  const voice = state.optional(HerVoiceKey);
  if (voice === undefined) throw ApiError.unavailable(ROOM_TEXT.voiceOff);
  const release = room.speaking.take(key);
  if (release === null) {
    throw new ApiError(429, ROOM_TEXT.tooFast, { "retry-after": "2" });
  }
  try {
    // Counted once it is really made: a cached line costs nothing.
    room.voicePerHour.hit(key, state.now());
    const audio = await voice.speak(her.text, her.emotion, signal ?? new AbortController().signal);
    const wav = encodeWav(audio.sampleRate, audio.samples);
    room.voiceCache.set(line, wav);
    return wavResponse(wav);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.unavailable(ROOM_TEXT.voiceFailing);
  } finally {
    release();
  }
}

function wavResponse(wav: Uint8Array): Response {
  return new Response(wav.slice(), {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "content-length": String(wav.byteLength),
      "cache-control": "no-store",
    },
  });
}
