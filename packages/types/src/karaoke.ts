// How karaoke reaches the song workers (docs/design/karaoke.md §3, §13): a port the singing module
// provides over the workers it already follows (the registry's `sing` endpoints, with their
// failover), and the karaoke plugin (`@miyoria/play/karaoke`) uses, so neither package depends on
// the other and there is one worker client.

import type { WorkersSingJob } from "@miyoria/contracts/workers";
import { serviceKey } from "./service-key.js";

/** A karaoke file of a prepared song (`KARAOKE_FILES` of the worker contract). */
export type KaraokeFileName = "karaoke.m4a" | "reference.json";

/** What a karaoke preparation is asked for: a link (the worker's allowed hosts) or a search. */
export interface KaraokeQuery {
  url?: string;
  query?: string;
  title?: string;
  artist?: string;
  /** Make it again even when the worker has it. */
  force?: boolean;
}

export interface KaraokeWorker {
  /** Starts a karaoke job (`purpose: "karaoke"`) on the first worker that answers. */
  prepare(query: KaraokeQuery, signal?: AbortSignal): Promise<WorkersSingJob>;
  /** A job's state; once `done`, `job.karaoke` is the song. A 404 error: the worker lost it. */
  job(id: string, signal?: AbortSignal): Promise<WorkersSingJob>;
  cancel(id: string): Promise<void>;
  /** Saves one of a karaoke song's files to `dest`, from the worker that made it. */
  file(song: string, name: KaraokeFileName, dest: string, signal?: AbortSignal): Promise<void>;
}

export const KaraokeWorkerKey = serviceKey<KaraokeWorker>("KaraokeWorker");
