// What a running `api` module keeps of her room (docs/design/her-room.md §6 "記憶體裡"): the hubs,
// the uploads, the voice cache and the counters. All of it is memory only and may be lost.

import { RoomChannel } from "./channel.js";
import type { RoomConfig } from "./config.js";
import { roomBytes } from "./config.js";
import { Slots, Window } from "./limits.js";
import { RoomUploads } from "./uploads.js";
import { VoiceCache } from "./voice.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Memories one person may ask her to forget, and lines to leave out, an hour. */
export const FORGETS_PER_HOUR = 30;

export class Room {
  readonly channel: RoomChannel;
  readonly uploads: RoomUploads;
  readonly voiceCache: VoiceCache;
  readonly perMinute: Window;
  readonly perDay: Window;
  readonly uploadsPerHour: Window;
  readonly forgets = new Window(FORGETS_PER_HOUR, HOUR);
  readonly excludes = new Window(FORGETS_PER_HOUR, HOUR);
  readonly voicePerHour: Window;
  /** Lines synthesized at once: one per account, two in all. */
  readonly speaking = new Slots(1, 2);

  constructor(
    readonly config: RoomConfig,
    readonly now: () => number,
    options: { run?: string; random?: (n: number) => Uint8Array } = {},
  ) {
    this.channel = new RoomChannel(now, options.run);
    this.uploads = new RoomUploads(now, roomBytes(config).pool, options.random);
    this.voiceCache = new VoiceCache(config.voice_cache, now);
    this.perMinute = new Window(config.messages_per_minute, MINUTE);
    this.perDay = new Window(config.messages_per_day, DAY);
    this.uploadsPerHour = new Window(config.uploads_per_hour, HOUR);
    this.voicePerHour = new Window(config.voice_lines_per_hour, HOUR);
  }
}
