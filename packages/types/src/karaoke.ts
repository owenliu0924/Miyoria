// How karaoke reaches the song workers (docs/design/karaoke.md §3, §13): a port the singing module
// provides over the workers it already follows (the registry's `sing` endpoints, with their
// failover), and the karaoke plugin (`@miyoria/play/karaoke`) uses, so neither package depends on
// the other and there is one worker client.

import type { WorkersKaraokeVoicePitch, WorkersSingJob } from "@miyoria/contracts/workers";
import { serviceKey } from "./service-key.js";

/**
 * A karaoke file of a prepared song (`KARAOKE_FILES` of the worker contract), or its backing in
 * another key (`karaokeBackingName`: `karaoke.k+3.m4a`).
 */
export type KaraokeFileName =
  | "karaoke.m4a"
  | "reference.json"
  | "video.mp4"
  | `karaoke.k${"+" | "-"}${number}.m4a`;

/** How a song's lyrics are checked and aligned (`WorkersKaraokeLyricsOptions`). */
export interface KaraokeLyricsOptions {
  aligner: "w2v" | "mms";
  matched: number;
  uncertain: number;
  keep_share: number;
  wrong_share: number;
}

/** What a karaoke preparation is asked for: a link (the worker's allowed hosts) or a search. */
export interface KaraokeQuery {
  url?: string;
  query?: string;
  title?: string;
  artist?: string;
  /** Make it again even when the worker has it. */
  force?: boolean;
  /** How its lyrics are checked and aligned; left out, the worker's defaults. */
  lyrics?: KaraokeLyricsOptions;
  /** Keep the source's picture as a background video (`video.mp4`); left out, yes. */
  video?: boolean;
}

/** A singer's recording, sent once to have its pitch read (`POST /karaoke/voice`). */
export interface KaraokeVoice {
  bytes: Uint8Array;
  /** `audio/webm`, `audio/ogg`, `audio/mp4` (or `audio/wav`). */
  type: string;
}

export interface KaraokeWorker {
  /** Starts a karaoke job (`purpose: "karaoke"`) on the first worker that answers. */
  prepare(query: KaraokeQuery, signal?: AbortSignal): Promise<WorkersSingJob>;
  /** A job's state; once `done`, `job.karaoke` is the song. A 404 error: the worker lost it. */
  job(id: string, signal?: AbortSignal): Promise<WorkersSingJob>;
  cancel(id: string): Promise<void>;
  /** Saves one of a karaoke song's files to `dest`, from the worker that made it. */
  file(song: string, name: KaraokeFileName, dest: string, signal?: AbortSignal): Promise<void>;
  /**
   * Has the worker that made the song render its backing `semitones` away (made once, kept with
   * the song); the answer names the file to fetch with `file`.
   */
  key(song: string, semitones: number, signal?: AbortSignal): Promise<{ file: string }>;
  /**
   * The pitch of a singer's recording (RMVPE on any worker that answers, 50 Hz from its first
   * sample). The worker deletes the recording before it answers.
   */
  voice(voice: KaraokeVoice, signal?: AbortSignal): Promise<WorkersKaraokeVoicePitch>;
}

export const KaraokeWorkerKey = serviceKey<KaraokeWorker>("KaraokeWorker");
