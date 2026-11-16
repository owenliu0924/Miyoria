// Playing one song: fetch the worker's 48 kHz mix and converted vocal, stream them to the voice
// node close to real time (the vocal as the levels track her mouth follows), and send the lyrics
// lines as cues while it plays. The start cue carries the path of the song's original video for
// the Stage node to show (muted) in OBS.

import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  type Clock,
  type PlaybackState,
  type PlayChunk,
  parseSongBeats,
  type SongBeats,
  type SongCue,
  type VoicePlayer,
} from "@miyoria/types";
import type { SingWorker, SongMeta } from "./client.js";

const log = getLogger("sing");

export interface PlayerDeps {
  worker: SingWorker;
  voice: VoicePlayer;
  clock: Clock;
  cue: (cue: SongCue) => void;
  leadMs: number;
  fadeMs: number;
  lyrics: boolean;
  lipSyncVocals: boolean;
  /** The worker's cache dir (absolute) when videos are shown, else `null`. */
  videoDir: string | null;
  /** Called once, when the voice node reports that the song itself is heard. */
  heard?: () => void;
  /** What a video download stops on (the module's signal). Default: the song's own. */
  videoSignal?: AbortSignal;
  /** How long the song waits for its video. Default `VIDEO_WAIT_MS`. */
  videoWaitMs?: number;
}

/** Song ids and video names as the worker writes them (`safe_id`, `video<ext>`). */
const SONG_ID = /^[A-Za-z0-9_-]{1,96}$/;
const VIDEO_FILE = /^video\.(mp4|m4v|mkv|webm|mov)$/;

/**
 * The absolute path of `song`'s video in the worker's cache `dir` (`<dir>/<id>/video.mp4`), or
 * `null` when it has none. The id and file name come from the worker, so anything that is not
 * exactly a song dir and a video name, or would land outside `dir`, gives `null`.
 */
export function songVideoPath(dir: string, song: SongMeta): string | null {
  const file = song.video?.file;
  if (!song.has_video || file === undefined || !SONG_ID.test(song.id) || !VIDEO_FILE.test(file)) {
    return null;
  }
  const root = resolve(dir);
  const full = resolve(root, song.id, file);
  const rel = relative(root, full);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : full;
}

/** The song's beat for the cue (ms), when the worker found one. */
export function songBeats(song: SongMeta): SongBeats | null {
  const beats = song.beats;
  if (!beats) return null;
  return parseSongBeats({ bpm: beats.bpm, times_ms: beats.times.map((t) => t * 1000) });
}

/** How long to wait for the node to report a started playback before giving up on lyrics. */
const START_WAIT_MS = 60_000;
const POLL_MS = 50;
/**
 * How long a song waits for its video before it starts without one. A video that is not here by
 * then goes on downloading and is shown the next time the song is sung.
 */
export const VIDEO_WAIT_MS = 5_000;

/** Video downloads under way, by destination: two callers never write the same file. */
const fetching = new Map<string, Promise<string | null>>();

/** Resolves after `ms`, or when `signal` aborts (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** `mix` in 100 ms chunks, each sent `leadMs` before it is due. */
export async function* paced(
  mix: Int16Array,
  vocals: Int16Array | null,
  rate: number,
  leadMs: number,
  clock: Clock,
  signal: AbortSignal,
): AsyncGenerator<PlayChunk> {
  const step = Math.max(1, Math.floor(rate / 10));
  const t0 = clock.now();
  for (let at = 0; at < mix.length; at += step) {
    if (signal.aborted) return;
    const due = t0 + (at / rate) * 1000 - leadMs;
    const wait = due - clock.now();
    if (wait > 0) await sleep(wait, signal);
    if (signal.aborted) return;
    const samples = mix.subarray(at, at + step);
    if (vocals === null) yield { samples };
    else {
      const levels = new Int16Array(samples.length);
      levels.set(vocals.subarray(at, Math.min(at + step, vocals.length)));
      yield { samples, levels };
    }
  }
}

/**
 * Sings `song` in `guild`'s voice channel and resolves with how it ended. Aborting `signal`
 * fades it out (a skip or stop). Throws when the audio cannot be fetched or played.
 */
/**
 * Makes sure the song's video is in `d.videoDir` (the song worker may run on another machine, so
 * Core fetches it from the worker once). The path to show, or `null` when there is none.
 */
export async function ensureVideo(
  d: Pick<PlayerDeps, "worker" | "videoDir">,
  song: SongMeta,
  signal: AbortSignal,
): Promise<string | null> {
  if (d.videoDir === null) return null;
  const path = songVideoPath(d.videoDir, song);
  const file = song.video?.file;
  if (path === null || file === undefined) return null;
  try {
    await access(path);
    return path;
  } catch {
    // not here yet: ask the worker
  }
  const running = fetching.get(path);
  if (running !== undefined) return running;
  const download = d.worker
    .download(song.id, file, path, signal)
    .then(
      () => path,
      (error: unknown) => {
        if (!signal.aborted) {
          log.warn({ song: song.id, err: String(error) }, "song video not fetched");
        }
        return null;
      },
    )
    .finally(() => fetching.delete(path));
  fetching.set(path, download);
  return download;
}

export async function singSong(
  d: PlayerDeps,
  song: SongMeta,
  guild: string,
  signal: AbortSignal,
): Promise<PlaybackState> {
  const rate = song.play.sample_rate;
  // Not on the song's own signal: a skipped song's video is still wanted the next time.
  const videoFetch = ensureVideo(d, song, d.videoSignal ?? signal);
  const [mix, vocals] = await Promise.all([
    d.worker.audio(song.id, "play_mix.pcm", signal),
    d.lipSyncVocals ? d.worker.audio(song.id, "play_vocals.pcm", signal) : Promise.resolve(null),
  ]);
  // The song does not wait for a slow download: it starts without the video instead.
  const video = await Promise.race([
    videoFetch,
    sleep(d.videoWaitMs ?? VIDEO_WAIT_MS, signal).then(() => null),
  ]);
  if (signal.aborted) return "interrupted";
  const streaming = new AbortController();
  const handle = await d.voice.play(
    guild,
    rate,
    paced(mix, vocals, rate, d.leadMs, d.clock, AbortSignal.any([signal, streaming.signal])),
    { levels: vocals !== null },
  );
  const onAbort = () => handle.stop(d.fadeMs);
  // A stop that came while the playback was being set up fires no event any more.
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const lyricsDone = new AbortController();
  const durationMs = Math.round((mix.length / rate) * 1000);
  const lyrics = cueLyrics(
    d,
    song,
    durationMs,
    video,
    handle,
    AbortSignal.any([signal, lyricsDone.signal]),
  );
  try {
    return await handle.wait();
  } finally {
    signal.removeEventListener("abort", onAbort);
    streaming.abort();
    lyricsDone.abort();
    await lyrics;
  }
}

/**
 * Waits for the playback to start, then publishes `started` (with the song's length,
 * `durationMs`) and each lyrics line on time.
 */
async function cueLyrics(
  d: PlayerDeps,
  song: SongMeta,
  durationMs: number,
  video: string | null,
  handle: { state(): PlaybackState | null },
  signal: AbortSignal,
): Promise<void> {
  const waitUntil = d.clock.now() + START_WAIT_MS;
  while (handle.state() === null && !signal.aborted && d.clock.now() < waitUntil) {
    await sleep(POLL_MS, signal);
  }
  // Started, or over already: either way it was heard.
  if (handle.state() !== null) d.heard?.();
  if (signal.aborted || handle.state() !== "started") return;
  const startedAt = d.clock.now();
  const beats = songBeats(song);
  d.cue({
    state: "started",
    song: song.id,
    title: song.title,
    ...(video === null ? {} : { video, offset_ms: 0 }),
    duration_ms: durationMs,
    ...(beats === null ? {} : { beats }),
  });
  const lines = d.lyrics && song.lyrics?.synced ? song.lyrics.lines : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    await sleep(startedAt + line.t * 1000 - d.clock.now(), signal);
    if (signal.aborted) return;
    d.cue({ state: "line", song: song.id, index: i, text: line.text });
  }
}
