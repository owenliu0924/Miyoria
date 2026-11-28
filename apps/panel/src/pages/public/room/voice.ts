// Her voice in the room (docs/design/her-room.md §3.8, §7.3): each of her lines the Core offers as
// a WAV (`line.voice`) is fetched and played when it comes on the stage, one at a time, in order.
// Only one tab plays: the one last used (a send or a press of the voice key), told to the others on
// `BroadcastChannel("miyoria-room")`. Whether it may play at all is the Core's (`state.voice`); its
// reason is what the greyed key says. The member's own on / off is kept per browser.

import { readStorage, writeStorage } from "@/lib/storage";

export const VOICE_CHANNEL = "miyoria-room";
export const VOICE_KEY = "miyoria.room.voice";

/** The part of `BroadcastChannel` used here. */
export interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** The part of `HTMLAudioElement` used here. */
export interface AudioLike {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface VoiceSnapshot {
  /** The member wants to hear her. */
  on: boolean;
  /** This tab is the one that plays. */
  chosen: boolean;
  /** The line being read out now. */
  speaking: string | null;
  /** Why the last line could not be played, until the room's state says something new. */
  failed: string | null;
}

export interface VoiceOptions {
  fetch: (line: string, signal: AbortSignal) => Promise<Blob>;
  /** This tab's id. */
  tab: string;
  channel?: ChannelLike | null;
  audio?: () => AudioLike;
  objectUrl?: { create(blob: Blob): string; revoke(url: string): void };
  /** Words for a failed fetch. */
  problem?: (error: unknown) => string;
}

function defaultChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : (new BroadcastChannel(VOICE_CHANNEL) as unknown as ChannelLike);
  } catch {
    return null;
  }
}

export class RoomVoice {
  readonly #o: VoiceOptions;
  #channel: ChannelLike | null = null;
  readonly #listeners = new Set<() => void>();
  #snap: VoiceSnapshot;
  #available = false;
  #audio: AudioLike | null = null;
  #url: string | null = null;
  #fetching: AbortController | null = null;

  constructor(o: VoiceOptions) {
    this.#o = o;
    this.#snap = { on: readStorage(VOICE_KEY) !== "off", chosen: true, speaking: null, failed: null };
    this.connect();
  }

  /** Listens to the other tabs (again, after `dispose`: a page mounted twice). */
  connect(): void {
    if (this.#channel) return;
    this.#channel = this.#o.channel === undefined ? defaultChannel() : this.#o.channel;
    if (!this.#channel) return;
    this.#channel.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: unknown; tab?: unknown } | null;
      if (m?.type !== "chosen" || m.tab === this.#o.tab) return;
      this.stop();
      this.#set({ chosen: false });
    };
  }

  get snapshot(): VoiceSnapshot {
    return this.#snap;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The Core's word on whether her voice can be played here. */
  setAvailable(available: boolean): void {
    if (this.#available === available) return;
    this.#available = available;
    if (!available) this.stop();
    if (this.#snap.failed !== null) this.#set({ failed: null });
  }

  /** This tab was used: it is the one that plays now, and the others stop. */
  choose(): void {
    try {
      this.#channel?.postMessage({ type: "chosen", tab: this.#o.tab });
    } catch {
      // A closed channel: this tab plays anyway.
    }
    if (!this.#snap.chosen) this.#set({ chosen: true });
  }

  toggle(): void {
    const on = !this.#snap.on;
    writeStorage(VOICE_KEY, on ? null : "off");
    if (!on) this.stop();
    this.#set({ on });
    this.choose();
  }

  /** Whether a line offered as voice would be played now. */
  wouldPlay(voice: boolean): boolean {
    return voice && this.#available && this.#snap.on && this.#snap.chosen;
  }

  /** Reads `line` out, in place of anything before it. */
  async play(line: { id: string; voice: boolean }): Promise<void> {
    if (!this.wouldPlay(line.voice)) return;
    if (this.#snap.speaking === line.id) return;
    this.stop();
    const ctl = new AbortController();
    this.#fetching = ctl;
    this.#set({ speaking: line.id });
    let blob: Blob;
    try {
      blob = await this.#o.fetch(line.id, ctl.signal);
    } catch (error) {
      if (ctl.signal.aborted) return;
      this.#fetching = null;
      this.#set({ speaking: null, failed: this.#o.problem ? this.#o.problem(error) : "她的聲音暫時出不來" });
      return;
    }
    if (ctl.signal.aborted) return;
    this.#fetching = null;
    const urls = this.#o.objectUrl ?? { create: (b: Blob) => URL.createObjectURL(b), revoke: (u: string) => URL.revokeObjectURL(u) };
    const audio = this.#o.audio ? this.#o.audio() : (new Audio() as AudioLike);
    const url = urls.create(blob);
    this.#audio = audio;
    this.#url = url;
    const finish = () => {
      if (this.#audio !== audio) return;
      this.#release();
      this.#set({ speaking: null });
    };
    audio.onended = finish;
    audio.onerror = finish;
    audio.src = url;
    try {
      await audio.play();
    } catch {
      // The browser would not play without a gesture first: quietly nothing.
      finish();
    }
  }

  /** Stops whatever is being read out. */
  stop(): void {
    this.#fetching?.abort();
    this.#fetching = null;
    if (this.#audio) {
      this.#audio.pause();
      this.#release();
    }
    if (this.#snap.speaking !== null) this.#set({ speaking: null });
  }

  dispose(): void {
    this.stop();
    if (this.#channel) {
      this.#channel.onmessage = null;
      this.#channel.close();
    }
    this.#channel = null;
  }

  #release(): void {
    const urls = this.#o.objectUrl ?? { revoke: (u: string) => URL.revokeObjectURL(u) };
    if (this.#url) urls.revoke(this.#url);
    this.#url = null;
    if (this.#audio) {
      this.#audio.onended = null;
      this.#audio.onerror = null;
    }
    this.#audio = null;
  }

  #set(patch: Partial<VoiceSnapshot>): void {
    this.#snap = { ...this.#snap, ...patch };
    for (const l of this.#listeners) l();
  }
}

/** The voice key's state: `off` greyed with the Core's reason (or the last failure). */
export function voiceKey(
  state: { available: boolean; reason: string | null } | null,
  snap: VoiceSnapshot,
): { usable: boolean; pressed: boolean; reason: string | null; label: string } {
  if (!state?.available) {
    const reason = state?.reason ?? "她的聲音現在沒有開";
    return { usable: false, pressed: false, reason, label: "她的聲音" };
  }
  const reason = snap.failed ?? (snap.chosen ? null : "另一個分頁在播她的聲音");
  return { usable: true, pressed: snap.on, reason, label: "她的聲音" };
}
