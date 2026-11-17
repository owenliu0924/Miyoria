// `@miyoria/play/karaoke/testing`: what the karaoke tests and the offline end-to-end check use: the
// synthetic songs and singers (`synth.ts`), a reference in the worker's format made from a
// synthetic song, and a song worker in memory that prepares karaoke jobs when told to.

import { writeFile } from "node:fs/promises";
import {
  KARAOKE_REFERENCE_FORMAT,
  KARAOKE_REFERENCE_VERSION,
  type WorkersKaraokeReference,
  type WorkersSingJob,
} from "@miyoria/contracts/workers";
import type { KaraokeFileName, KaraokeQuery, KaraokeWorker } from "@miyoria/types";
import type { SynthSong } from "./synth.js";

export {
  copySinger,
  humanSinger,
  noiseSinger,
  rng,
  type SingerOptions,
  type SynthNote,
  type SynthSong,
  silentSinger,
  synthSong,
} from "./synth.js";

/** `song` as the worker's `reference.json`. */
export function referenceOf(
  song: SynthSong,
  id = "k-test",
  title = "測試的歌",
): WorkersKaraokeReference {
  const { reference } = song;
  const voiced = reference.midi.filter((m) => m !== null).length;
  return {
    format: KARAOKE_REFERENCE_FORMAT,
    version: KARAOKE_REFERENCE_VERSION,
    id,
    title,
    artist: "某人",
    duration_s: reference.midi.length / reference.hz,
    backing: "karaoke.m4a",
    pitch: {
      hz: reference.hz,
      start: reference.start,
      midi: reference.midi.map((m) => (m === null ? null : Math.round(m * 100) / 100)),
    },
    notes: song.notes.map((n) => ({
      start: n.start,
      end: n.end,
      midi: n.midi,
      source: "pitch",
      line: null,
      char: null,
    })),
    lyrics: {
      provider: "test",
      timing: "line",
      lines: song.lines.map((l) => ({
        start: l.start,
        end: l.end,
        text: l.text,
        check: "unchecked",
        confidence: null,
        chars: null,
      })),
    },
    quality: {
      ok: true,
      reason: null,
      voiced_ratio: voiced / reference.midi.length,
      notes: song.notes.length,
      lead_split: true,
    },
    made: { pitch: "rmvpe", notes: "pitch-runs-1", lyrics: "line" },
  };
}

/** A few bytes standing in for the backing track. */
export const FAKE_BACKING = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** A song worker in memory: jobs wait until `finish` or `fail`; files are written from memory. */
export class FakeKaraokeWorker implements KaraokeWorker {
  readonly jobs = new Map<string, WorkersSingJob>();
  readonly references = new Map<string, WorkersKaraokeReference>();
  readonly asked: KaraokeQuery[] = [];
  readonly fetched: string[] = [];
  /** The next `prepare` answers this error. */
  refuse: { message: string; status?: number } | null = null;
  #next = 1;

  async prepare(query: KaraokeQuery): Promise<WorkersSingJob> {
    if (this.refuse !== null) {
      const error = Object.assign(new Error(this.refuse.message), {
        status: this.refuse.status ?? 0,
      });
      throw error;
    }
    this.asked.push(query);
    const id = `kj-${this.#next++}`;
    const job: WorkersSingJob = {
      id,
      state: "queued",
      stage: "queued",
      progress: 0,
      error: null,
      song_id: null,
      cached: false,
      position: 0,
      source: { title: query.query ?? "連結的歌", artist: null },
      song: null,
      exclusive: null,
      gpu: null,
      karaoke: null,
    };
    this.jobs.set(id, job);
    return structuredClone(job);
  }

  async job(id: string): Promise<WorkersSingJob> {
    const job = this.jobs.get(id);
    if (job === undefined) throw Object.assign(new Error(`no job ${id}`), { status: 404 });
    return structuredClone(job);
  }

  async cancel(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  /** The job runs: a stage and how far. */
  progress(id: string, stage: string, progress: number): void {
    Object.assign(this.jobs.get(id) ?? {}, { state: "running", stage, progress, position: null });
  }

  /** The job is done with `reference` (its id is the karaoke song's). */
  finish(id: string, reference: WorkersKaraokeReference): void {
    this.references.set(reference.id, reference);
    Object.assign(this.jobs.get(id) ?? {}, {
      state: "done",
      stage: "done",
      progress: 1,
      position: null,
      karaoke: {
        id: reference.id,
        title: reference.title,
        artist: reference.artist,
        duration_s: reference.duration_s,
        quality: reference.quality,
      },
    });
  }

  fail(id: string, error: string): void {
    Object.assign(this.jobs.get(id) ?? {}, { state: "failed", error, position: null });
  }

  async file(song: string, name: KaraokeFileName, dest: string): Promise<void> {
    const reference = this.references.get(song);
    if (reference === undefined) {
      throw Object.assign(new Error(`no karaoke ${song}`), { status: 404 });
    }
    this.fetched.push(`${song}/${name}`);
    await writeFile(dest, name === "reference.json" ? JSON.stringify(reference) : FAKE_BACKING);
  }
}
