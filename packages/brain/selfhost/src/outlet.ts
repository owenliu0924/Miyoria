// How a line of hers leaves: through the mouth (`MainLine.say`), so the one-mouth rule, the
// output review and the delivery ledger stay what they are, then the scheduler and the platform.
// The run holds the Floor for all its lines (`SelfHost`, `MainLine.holdsFloor`), so a line takes no
// hold of its own. A line may carry the platform's reply reference (the host says which,
// `replyTo`; `MainLine.replyNext` hands it to the mouth). The outlet waits
// for `action.settled` of the line to tell the runner whether it reached anyone and under which
// platform id.
//
// In the place of the run, the second and later lines wait about as long as typing them takes
// (`paceMs`, today's `#pace`), with the typing indicator shown.

import { sleep } from "@miyoria/runtime/kernel";
import {
  type ActionSettled,
  ActionSinkKey,
  type ContextKey,
  contextKeyString,
  type MessageRef,
  newAction,
  textLane,
} from "@miyoria/types";
import { type Agent, paceMs } from "../../agent/src/index.js";
import type { Delivery, OutgoingLine, Outlet } from "../../self/src/index.js";

/** How a typing indicator lasts. */
export const TYPING_TTL_MS = 10_000;
/** Longest wait for a line's `action.settled` beyond its TTL. */
const SETTLE_SLACK_MS = 5_000;
/** Longest wait for a line's `action.settled`, whatever its TTL. */
const SETTLE_MAX_MS = 30_000;

/** A line's end as the scheduler told it. */
export interface Settled {
  ok: boolean;
  error: string | null;
  message_id: string | null;
  blocked: string | null;
}

function lineKey(turn: string | null, context: ContextKey, text: string): string {
  return `${turn ?? ""}\n${contextKeyString(context)}\n${text.trim()}`;
}

/** Lines handed to the mouth, waiting for how they left the scheduler. */
export class Settlements {
  readonly #waiting = new Map<string, ((s: Settled) => void)[]>();

  /**
   * Resolves with how the line left, `null` after `ms`; rejects when `signal` aborts. Call before
   * the line is handed over: the answer can come before `say` returns.
   */
  wait(
    turn: string,
    context: ContextKey,
    text: string,
    ms: number,
    signal: AbortSignal,
  ): Promise<Settled | null> {
    const key = lineKey(turn, context, text);
    return new Promise<Settled | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: Settled | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const list = this.#waiting.get(key)?.filter((w) => w !== take) ?? [];
        if (list.length === 0) this.#waiting.delete(key);
        else this.#waiting.set(key, list);
        resolve(value);
      };
      const take = (s: Settled) => done(s);
      const onAbort = () => {
        clearTimeout(timer);
        const list = this.#waiting.get(key)?.filter((w) => w !== take) ?? [];
        if (list.length === 0) this.#waiting.delete(key);
        else this.#waiting.set(key, list);
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => done(null), ms);
      this.#waiting.set(key, [...(this.#waiting.get(key) ?? []), take]);
    });
  }

  /** `action.settled` of a `send_message`. Returns whether a line waited for it. */
  settled(event: ActionSettled): boolean {
    if (event.type !== "send_message") return false;
    const key = lineKey(event.turn, event.context, event.text);
    const take = this.#waiting.get(key)?.[0];
    if (take === undefined) return false;
    take({
      ok: event.ok,
      error: event.error,
      message_id: event.message?.id ?? null,
      blocked: event.blocked ?? event.message?.blocked ?? null,
    });
    return true;
  }
}

/** The outlet of the host: `MainLine.say`, then the scheduler's word on it. */
export class MouthOutlet implements Outlet {
  readonly #agent: Agent;
  readonly #settlements: Settlements;
  /** When the last line of each turn went out (clock ms), for the pace. */
  readonly #lastAt = new Map<string, number>();
  /** A line of hers in another place went out (`say`). */
  readonly #elsewhere: (line: OutgoingLine, messageId: string | null) => void;
  /** The platform reply reference a line carries, if any. */
  readonly #replyTo: (line: OutgoingLine) => MessageRef | null;

  constructor(
    agent: Agent,
    settlements: Settlements,
    elsewhere: (line: OutgoingLine, messageId: string | null) => void,
    replyTo: (line: OutgoingLine) => MessageRef | null = () => null,
  ) {
    this.#agent = agent;
    this.#settlements = settlements;
    this.#elsewhere = elsewhere;
    this.#replyTo = replyTo;
  }

  /** The turn ended: its pace is forgotten. */
  ended(turn: string): void {
    this.#lastAt.delete(turn);
  }

  async deliver(line: OutgoingLine, signal: AbortSignal): Promise<Delivery> {
    const agent = this.#agent;
    if (agent.muted) return { status: "blocked", reason: "緊急停止中" };
    signal.throwIfAborted();
    agent.mainline.own(line.turn);
    if (line.focus) await this.#pace(line, signal);
    const cfg = agent.config;
    const ms = Math.min(cfg.reply_ttl_ms + SETTLE_SLACK_MS, SETTLE_MAX_MS);
    const settled = this.#settlements.wait(line.turn, line.place, line.text, ms, signal);
    settled.catch(() => undefined);
    agent.mainline.replyNext(line.turn, line.place, this.#replyTo(line));
    await agent.mainline.say({
      context: line.place,
      text: line.text,
      emotion: line.emotion,
      turn: line.turn,
      source: "self",
    });
    const end = await settled;
    if (line.focus) this.#lastAt.set(line.turn, agent.ctx.clock.now());
    if (end === null) {
      // The scheduler did not say in time: the line was queued, and is taken as said.
      agent.log.debug({ turn: line.turn }, "no word from the scheduler on a line");
      if (!line.focus) this.#elsewhere(line, null);
      return { status: "delivered", message_id: null };
    }
    if (!end.ok) return { status: "blocked", reason: end.error ?? "failed" };
    if (end.blocked !== null) return { status: "blocked", reason: end.blocked };
    if (!line.focus) this.#elsewhere(line, end.message_id);
    return { status: "delivered", message_id: end.message_id };
  }

  async #pace(line: OutgoingLine, signal: AbortSignal): Promise<void> {
    const last = this.#lastAt.get(line.turn);
    if (last === undefined) return;
    const agent = this.#agent;
    const wait = paceMs(agent.rhythm.config, line.text) - (agent.ctx.clock.now() - last);
    if (wait <= 0) return;
    await submitTyping(agent, line.place, line.turn);
    await sleep(wait, signal);
  }
}

/** Shows her typing in `context` for `turn`. Never throws. */
export async function submitTyping(agent: Agent, context: ContextKey, turn: string): Promise<void> {
  const sink = agent.ctx.services.get(ActionSinkKey);
  if (!sink) return;
  try {
    await sink.submit(
      newAction(
        textLane(context),
        "direct",
        { type: "typing", context },
        {
          ttl: TYPING_TTL_MS,
          turn,
          coalesce_key: `typing:${contextKeyString(context)}`,
        },
      ),
    );
  } catch (error) {
    agent.log.debug({ turn, err: String(error) }, "could not submit a typing action");
  }
}
