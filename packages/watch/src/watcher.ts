import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ChatResponse,
  type Completer,
  completeJson,
  NoImageModelError,
} from "@miyoria/llm/llm";
import type { AccountRef } from "@miyoria/types";
import { dataBlock, safeName, sameAccount } from "@miyoria/types";
import type { StreamHearing } from "@miyoria/voice/voice";
import type { WatchConfig } from "./config.js";
import { listenTo } from "./ears.js";
import { answerRequest, cutNote, LookResultSchema, lookRequest } from "./look.js";
import { WatchNotes } from "./notes.js";
import type { WatchSource, WatchTarget } from "./source.js";
import { speakGate, topicKey } from "./speak.js";

/** How long a snapshot may take. */
export const SNAPSHOT_TIMEOUT_MS = 8_000;
/** Topics she remembers having spoken about. */
export const RECENT_TOPICS = 5;
const TOPIC_MAX_CHARS = 40;
const HOUR_MS = 3_600_000;
const CANNOT_SEE = "你現在沒辦法看圖片(模型不收圖片,或這陣子的預算用完了)。";
/** Said of a stream that turned unwatchable: nothing about whose choice it was. */
const NO_LONGER = "這場直播現在不能看了,所以沒看。";

/** A start or a look she may not do; the message is written for her. */
export class WatchRefused extends Error {
  override name = "WatchRefused";
}

/**
 * The streamer's `watch` is off (or cannot be read). The message is for the streamer asking
 * themselves; anyone else is told something that does not give the choice away.
 */
export class OptedOut extends WatchRefused {
  override name = "OptedOut";
}

/** No look is left in this watch's hour (`looks_per_hour`). */
export class LooksUsedUp extends WatchRefused {
  override name = "LooksUsedUp";

  constructor(
    /** Minutes until a look is free again, at least 1. */
    readonly minutes: number,
    /** The notes she has, newest last. */
    readonly notes: readonly string[],
  ) {
    super(`這一小時看畫面的次數用完了,${minutes} 分鐘後才能再看。`);
  }
}

/** Why she does not watch someone whose `watch` is off: told to that person only. */
export function notWatchable(name: string): string {
  return `${safeName(name)} 沒有開放讓你看他的直播,或是現在確認不了。要他自己先用 /me privacy 把 watch 打開,你才能看。`;
}

const roomKey = (guild: string, channel: string): string => `${guild}\u0000${channel}`;

export interface WatcherDeps {
  source(target: WatchTarget): WatchSource;
  model: Completer;
  persona(): string;
  /** The model takes images (`takesImages("watch")`) and the budget is not exhausted. */
  canLook(): boolean;
  watchAllowed(account: AccountRef): Promise<boolean>;
  hearing: StreamHearing | null;
  /** She is talking or singing. */
  busy(guild: string): boolean;
  /**
   * Asks for a turn of hers about the stream (an impulse of source `watch`; the turn says it,
   * through the main line). `hint` is what the look saw, its notes already in a data block;
   * `topic` is the look's short topic.
   */
  initiative(target: WatchTarget, hint: string, topic: string): void;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  warn(message: string, error?: unknown): void;
  /** What a look saw, for the log (the owner's own record; nothing is stored). */
  seen?(what: { kind: "round" | "question"; text: string; topic?: string; worth?: boolean }): void;
}

export interface WatchView {
  target: WatchTarget;
  startedAt: number;
  notes: string[];
  /** When the newest note was written; `null` before the first look. */
  lastLookAt: number | null;
  transcript: string[];
}

/** Everything that belongs to one watch; a finished watch is never touched again. */
interface Run {
  target: WatchTarget;
  source: WatchSource;
  startedAt: number;
  ctl: AbortController;
  notes: WatchNotes;
  recentTopics: string[];
  /** When each paid look of the last hour began, oldest first. */
  looks: number[];
  failures: number;
  /** Aborted by `look` to restart the wait for the next round. */
  wake: AbortController | null;
  loop: Promise<void>;
  listener: Promise<void>;
  finishing: Promise<void> | null;
  done: Promise<void>;
  markDone(): void;
}

const noop = (): void => {};

const cutTopic = (topic: string): string => [...topic.trim()].slice(0, TOPIC_MAX_CHARS).join("");

/** Rejects when `signal` aborts, so a source that ignores it cannot hold the caller. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // `work` has already started; when the abort wins its later failure must not go unhandled.
  work.catch(noop);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export class Watcher {
  readonly #cfg: WatchConfig;
  readonly #deps: WatcherDeps;
  /** The run whose code is executing, so `stop` from inside it does not wait for itself. */
  readonly #inside = new AsyncLocalStorage<Run>();
  #run: Run | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  /** Starts that have not produced a watch yet; `stop` aborts them. */
  readonly #pending = new Set<AbortController>();
  #lastSpokeAt: number | null = null;
  /** When someone other than her last spoke, per voice room. */
  readonly #lastVoiceAt = new Map<string, number>();

  constructor(cfg: WatchConfig, deps: WatcherDeps) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  view(): WatchView | null {
    const run = this.#live();
    if (run === null) return null;
    return {
      target: run.target,
      startedAt: run.startedAt,
      notes: run.notes.notes(),
      lastLookAt: run.notes.lastNoteAt,
      transcript: run.notes.transcript(),
    };
  }

  /**
   * Starts watching `target`; a watch in progress is stopped first. `caller` gives up on the start
   * and nothing else: a watch that began no longer listens to it. `ready` runs once the stream is
   * live and before anything of it reaches a model (the notice in the channel goes out there, so
   * it never names a stream that did not start); when it throws, the stream is stopped again.
   */
  start(
    target: WatchTarget,
    caller?: AbortSignal,
    ready?: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const ctl = new AbortController();
    this.#pending.add(ctl);
    const p = this.#chain
      .then(() => this.#start(target, ctl, caller, ready))
      .finally(() => this.#pending.delete(ctl));
    this.#chain = p.catch(noop);
    return p;
  }

  async stop(reason: string): Promise<void> {
    for (const ctl of this.#pending) ctl.abort(new Error(reason));
    const run = this.#run;
    const finishing = run === null ? null : this.#finish(run, reason, false);
    if (run !== null && this.#inside.getStore() === run) return; // the loop is waiting for us
    await finishing;
    await this.#chain;
  }

  /** A fresh picture and an answer to `question`. */
  async look(question: string, signal: AbortSignal): Promise<string> {
    const run = this.#live();
    if (run === null) throw new WatchRefused("你現在沒有在看直播,沒辦法看畫面。");
    if (!this.#canLook()) {
      throw new WatchRefused(CANNOT_SEE);
    }
    if (!(await this.#allowed(run.target.account))) {
      void this.#finish(run, "opted out", false);
      throw new WatchRefused(NO_LONGER);
    }
    const scope = AbortSignal.any([run.ctl.signal, signal]);
    this.#assertLive(run);
    scope.throwIfAborted();
    this.#assertLookLeft(run);
    const jpeg = await this.#snapshot(run, scope);
    this.#assertLive(run);
    if (!(await this.#allowed(run.target.account))) {
      void this.#finish(run, "opted out", false);
      throw new WatchRefused(NO_LONGER);
    }
    this.#assertLive(run);
    scope.throwIfAborted();
    this.#assertLookLeft(run);
    run.looks.push(this.#deps.now());
    let res: ChatResponse;
    try {
      res = await untilAborted(
        this.#deps.model.complete(
          "watch",
          answerRequest({
            name: run.target.name,
            persona: this.#deps.persona(),
            detail: this.#cfg.image_detail,
            notes: run.notes.notes(),
            transcript: run.notes.transcript(),
            jpeg,
            question,
          }),
          scope,
        ),
        scope,
      );
    } catch (error) {
      if (error instanceof NoImageModelError) throw new WatchRefused(CANNOT_SEE);
      throw error;
    }
    this.#assertLive(run);
    this.#resetTimer(run);
    this.#deps.seen?.({ kind: "question", text: res.text.trim() });
    return res.text.trim();
  }

  /** Someone other than her spoke in the voice room `channel` of `guild`. */
  noteVoice(at: number, guild: string, channel: string): void {
    this.#lastVoiceAt.set(roomKey(guild, channel), at);
  }

  /**
   * `account` turned `watch` off: a watch of them ends now, without waiting for the next look.
   * The loop checks on every tick as well, so a missed call only delays the end.
   */
  optedOut(account: AccountRef): void {
    const run = this.#live();
    if (run !== null && sameAccount(run.target.account, account)) {
      void this.#finish(run, "opted out", false);
    }
  }

  noteSpoke(at: number): void {
    this.#lastSpokeAt = at;
  }

  /** Resolves when no watch is running. */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.#chain;
      await chain;
      const run = this.#run;
      if (run !== null) await run.done;
      else if (chain === this.#chain) return;
    }
  }

  // -- start -----------------------------------------------------------------------------

  async #start(
    target: WatchTarget,
    ctl: AbortController,
    caller?: AbortSignal,
    ready?: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const signal = caller ? AbortSignal.any([ctl.signal, caller]) : ctl.signal;
    const stopped = (): WatchRefused => new WatchRefused("看直播被停掉了,沒有開始看。");
    if (!this.#canLook()) {
      throw new WatchRefused(
        "你現在沒辦法看圖片(模型不收圖片,或這陣子的預算用完了),所以先不看直播。",
      );
    }
    if (!(await this.#allowed(target.account))) {
      throw new OptedOut(notWatchable(target.name));
    }
    if (signal.aborted) throw stopped();
    if (this.#run !== null) await this.#finish(this.#run, "switching", false);
    if (signal.aborted) throw stopped();

    const source = this.#deps.source(target);
    try {
      await untilAborted(source.start(target, signal), signal);
      // Going live takes seconds: the choice may have changed meanwhile.
      if (!signal.aborted && !(await this.#allowed(target.account))) {
        throw new OptedOut(notWatchable(target.name));
      }
      if (!signal.aborted) await ready?.(signal);
    } catch (error) {
      ctl.abort();
      await source.stop().catch(noop);
      throw signal.aborted && error === signal.reason ? stopped() : error;
    }
    if (signal.aborted) {
      await source.stop().catch(noop);
      throw stopped();
    }
    const run = this.#create(target, source, ctl);
    this.#run = run;
    this.#pending.delete(ctl);
    run.loop = this.#inside.run(run, () => this.#loop(run));
    run.listener = this.#inside.run(run, () => this.#listen(run));
    void source.ended().then(
      (reason) => void this.#finish(run, reason, false),
      (error: unknown) => void this.#finish(run, "the stream failed", true, error),
    );
  }

  #create(target: WatchTarget, source: WatchSource, ctl: AbortController): Run {
    let markDone = noop;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    return {
      target,
      source,
      startedAt: this.#deps.now(),
      ctl,
      notes: new WatchNotes(this.#cfg, this.#deps.now),
      recentTopics: [],
      looks: [],
      failures: 0,
      wake: null,
      loop: Promise.resolve(),
      listener: Promise.resolve(),
      finishing: null,
      done,
      markDone,
    };
  }

  /** Ends `run`, once; later calls get the same promise. Never touches another run. */
  #finish(run: Run, reason: string, failure: boolean, error?: unknown): Promise<void> {
    if (run.finishing !== null) return run.finishing;
    run.ctl.abort(new Error(reason));
    if (failure) this.#deps.warn(`watch ended: ${reason}`, error);
    run.finishing = (async () => {
      try {
        // The loop and the listener may be the caller; they only wait on this when it is not.
        await Promise.allSettled([run.loop, run.listener]);
        await run.source
          .stop()
          .catch((e: unknown) => this.#deps.warn("watch source stop failed", e));
      } finally {
        if (this.#run === run) this.#run = null;
        run.markDone();
      }
    })();
    return run.finishing;
  }

  // -- loop ------------------------------------------------------------------------------

  async #loop(run: Run): Promise<void> {
    const { signal } = run.ctl;
    const maxMs = this.#cfg.max_watch_mins * 60_000;
    let due = true;
    try {
      while (!signal.aborted) {
        const remaining = maxMs - (this.#deps.now() - run.startedAt);
        if (remaining <= 0) {
          void this.#finish(run, "max watch time", false);
          return;
        }
        if (!due) {
          const wake = new AbortController();
          run.wake = wake;
          try {
            await this.#deps.sleep(
              Math.min(this.#cfg.snapshot_secs * 1000, remaining),
              AbortSignal.any([signal, wake.signal]),
            );
          } catch {
            // An aborted sleep is just a wake-up.
          }
          if (run.wake === wake) run.wake = null;
          if (signal.aborted) return;
          if (wake.signal.aborted) continue; // `look` restarted the wait
          due = true;
          continue;
        }
        due = false;
        // Every tick, quiet room or not: an opt-out ends the watch, not only the next look.
        if (!(await this.#allowed(run.target.account))) {
          void this.#finish(run, "opted out", false);
          return;
        }
        if (signal.aborted) return;
        if (this.#active(run) && this.#lookLeft(run)) await this.#round(run);
      }
    } catch (error) {
      if (!signal.aborted) void this.#finish(run, "the watch loop failed", true, error);
    }
  }

  /**
   * Whether a look on her own is worth paying for: someone spoke in the stream's voice room (or
   * the watch began) within `active_secs`. A stream left running to an empty room costs nothing;
   * a question (`look`) is answered either way.
   */
  #active(run: Run): boolean {
    if (this.#cfg.active_secs === 0) return true;
    const last = Math.max(run.startedAt, this.#voiceAt(run) ?? Number.NEGATIVE_INFINITY);
    return this.#deps.now() - last <= this.#cfg.active_secs * 1000;
  }

  #voiceAt(run: Run): number | null {
    return this.#lastVoiceAt.get(roomKey(run.target.guild, run.target.channel)) ?? null;
  }

  /** Whether this watch's hour has a look left (`looks_per_hour`, every kind of look). */
  #lookLeft(run: Run): boolean {
    const now = this.#deps.now();
    run.looks = run.looks.filter((at) => now - at < HOUR_MS);
    return run.looks.length < this.#cfg.looks_per_hour;
  }

  /** A question with no look left is answered from the notes, with when she can look again. */
  #assertLookLeft(run: Run): void {
    if (this.#lookLeft(run)) return;
    const oldest = run.looks[0] ?? this.#deps.now();
    const minutes = Math.max(1, Math.ceil((oldest + HOUR_MS - this.#deps.now()) / 60_000));
    throw new LooksUsedUp(minutes, run.notes.notes());
  }

  async #round(run: Run): Promise<void> {
    const { signal } = run.ctl;
    try {
      if (!this.#canLook()) {
        void this.#finish(run, "cannot look any more", false);
        return;
      }
      let jpeg: Buffer;
      try {
        jpeg = await this.#snapshot(run, signal);
      } catch (error) {
        if (signal.aborted) return;
        run.failures++;
        if (run.failures >= this.#cfg.max_snapshot_failures) {
          void this.#finish(run, "too many failed snapshots", true, error);
        }
        return;
      }
      run.failures = 0;
      if (signal.aborted) return;
      if (!(await this.#allowed(run.target.account))) {
        void this.#finish(run, "opted out", false);
        return;
      }
      if (signal.aborted) return;
      // A question may have taken the last look while the snapshot came.
      if (!this.#lookLeft(run)) return;
      run.looks.push(this.#deps.now());

      let look: ReturnType<typeof LookResultSchema.parse>;
      try {
        const res = await untilAborted(
          completeJson(
            this.#deps.model,
            "watch",
            lookRequest({
              name: run.target.name,
              persona: this.#deps.persona(),
              detail: this.#cfg.image_detail,
              notes: run.notes.notes(),
              transcript: run.notes.transcript(),
              jpeg,
            }),
            LookResultSchema,
            // A second try is another paid picture; the next round is a fresh one anyway.
            { signal, repairs: 0 },
          ),
          signal,
        );
        look = res.value;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof NoImageModelError) {
          void this.#finish(run, "cannot look any more", true, error);
        } else {
          this.#deps.warn("watch look skipped", error);
        }
        return;
      }
      if (signal.aborted) return;

      const topic = cutTopic(look.topic);
      this.#deps.seen?.({ kind: "round", text: look.note, topic, worth: look.worth_saying });
      run.notes.addNote(look.note);
      this.#maybeSpeak(run, look.worth_saying, topic);
    } catch (error) {
      if (!signal.aborted) this.#deps.warn("watch round failed", error);
    }
  }

  #maybeSpeak(run: Run, worth: boolean, topic: string): void {
    const now = this.#deps.now();
    let busy = true;
    try {
      busy = this.#deps.busy(run.target.guild);
    } catch (error) {
      this.#deps.warn("watch busy check failed", error);
    }
    const ok = speakGate(
      {
        worth,
        topic,
        now,
        lastSpokeAt: this.#lastSpokeAt,
        lastVoiceAt: this.#voiceAt(run),
        busy,
        recentTopics: run.recentTopics,
      },
      this.#cfg,
    );
    if (!ok) return; // dropped, not queued
    // Set now, not when playback ends, so a slow playback cannot let a second line through.
    this.#lastSpokeAt = now;
    if (topicKey(topic) !== "")
      run.recentTopics = [...run.recentTopics, topic].slice(-RECENT_TOPICS);
    try {
      this.#deps.initiative(run.target, this.#hint(run), topic);
    } catch (error) {
      this.#deps.warn("watch speak failed", error);
    }
  }

  #hint(run: Run): string {
    const notes = run.notes.notes().map(cutNote);
    // The impulse's note already says she is watching; what the picture showed is untrusted.
    const head = safeName(run.target.name);
    if (notes.length === 0) return head;
    return `${head}\n${dataBlock("watch", "最近看到", notes.join("\n"))}`;
  }

  // -- pieces ----------------------------------------------------------------------------

  async #snapshot(run: Run, parent: AbortSignal): Promise<Buffer> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error("snapshot timed out")),
      SNAPSHOT_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([parent, timeout.signal]);
    try {
      return await untilAborted(run.source.snapshot(signal), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  #listen(run: Run): Promise<void> {
    const hearing = this.#deps.hearing;
    if (hearing === null) return Promise.resolve();
    const { signal } = run.ctl;
    const account = run.target.account;
    const heard = (): Promise<boolean> => hearing.allowed(account).catch(() => false);
    // Hearing needs both: voice consent, and `watch` (turning watching off ends the watch).
    const watched = async (): Promise<boolean> => {
      if (await this.#allowed(account)) return !signal.aborted;
      void this.#finish(run, "opted out", false);
      return false;
    };
    const may = async (): Promise<boolean> => (await heard()) && (await watched());
    return (async () => {
      try {
        if (!(await may()) || signal.aborted) return;
        await listenTo(
          run.source.audio(),
          {
            transcribe: async (samples, s) => {
              if (!(await may())) return null;
              const text = await hearing.transcribe(samples, s);
              // Either choice may have changed while the ASR worked.
              return text !== null && (await may()) ? text : null;
            },
          },
          (text) => {
            if (!signal.aborted) run.notes.addLine(text);
          },
          signal,
        );
      } catch (error) {
        if (!signal.aborted) this.#deps.warn("watch listening failed", error);
      }
    })();
  }

  #resetTimer(run: Run): void {
    run.wake?.abort();
  }

  #live(): Run | null {
    const run = this.#run;
    return run !== null && !run.ctl.signal.aborted ? run : null;
  }

  #assertLive(run: Run): void {
    if (run.ctl.signal.aborted) throw new WatchRefused("直播已經結束了。");
  }

  #canLook(): boolean {
    try {
      return this.#deps.canLook();
    } catch {
      return false;
    }
  }

  async #allowed(account: AccountRef): Promise<boolean> {
    try {
      return await this.#deps.watchAllowed(account);
    } catch {
      return false;
    }
  }
}
