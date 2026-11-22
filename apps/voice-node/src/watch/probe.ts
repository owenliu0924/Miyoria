// Whether this machine can watch a stream, checked once at startup: the `watch` capability is
// announced only when it can, so Core never asks a node that would fail every watch.
import { execFile } from "node:child_process";
import { CAPABILITY_WATCH, NODE_CAPABILITIES } from "../protocol.js";
import { loadWatchLibrary } from "./connection.js";

const FFMPEG_PROBE_MS = 5_000;

export interface WatchProbes {
  /** Resolves when ffmpeg runs; rejects with why not. */
  ffmpeg(): Promise<void>;
  /** Resolves when the native libraries load; rejects with why not. */
  library(): Promise<void>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `ffmpeg -version`, without a shell, given a few seconds. */
export function probeFfmpeg(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-version"], { timeout: FFMPEG_PROBE_MS, windowsHide: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export const defaultProbes: WatchProbes = {
  ffmpeg: probeFfmpeg,
  library: async () => {
    await loadWatchLibrary();
  },
};

/** Null when watching works here, else one plain line saying why it does not. */
export async function whyNoWatch(probes: WatchProbes = defaultProbes): Promise<string | null> {
  const [ffmpeg, library] = await Promise.allSettled([probes.ffmpeg(), probes.library()]);
  if (ffmpeg.status === "rejected") {
    return `watch is not announced: ffmpeg did not run (${errMsg(ffmpeg.reason)})`;
  }
  if (library.status === "rejected") {
    return `watch is not announced: the Discord video library did not load (${errMsg(library.reason)})`;
  }
  return null;
}

/** The capabilities to announce, `watch` only when `why` (from {@link whyNoWatch}) is null. */
export function nodeCapabilities(why: string | null): string[] {
  return NODE_CAPABILITIES.filter((c) => c !== CAPABILITY_WATCH || why === null);
}
