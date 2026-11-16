// What other modules ask her to say, on the new runner: the Arbiter's `ImpulseHost` (a game's
// narration, a song's announcement, a notice) and the capabilities `chat.start` / `chat.dm`.
//
// The Arbiter still decides whether and when: its floors, the Floor's claims, and retrying a
// place that is busy, most urgent first. What it admits is a run of the place's lane, as the turn
// the Arbiter books: the voice channel she is in when it is news of hers (a game, a song, a
// notice) and she is in voice on that server, else the place it names. The lane starts it at once
// or answers `busy` (never queued behind a run), as the old coordinator did; a claim that cuts
// into her speech there does so first (`Agent.yieldTo`, the Floor's interrupt level).
//
// The run's wake: a notice is a `result` whose data is the notices waiting for that place (taken
// when the run starts, so block 6 does not show them again); anything else is a `world` wake with
// what happened (`ADMITTED_NOTES`) and the Floor row it was admitted under. Lines that are fixed
// text do not come here: they go out through the mouth (`MouthKey.say`).
//
// `chat.start` and `chat.dm` keep their gate (consent, `chat.dm`'s permission and limits); the
// channel's level and her budget still hold. Running one puts a `self` wake in that place (the
// DM it opens, for `chat.dm`) that says she wanted to talk; she may still stay quiet.

import {
  type Capability,
  CapabilityError,
  defineCapability,
  recipient,
} from "@miyoria/gate/actions";
import {
  type ArbiterReason,
  CHAT_DM,
  CHAT_START,
  type ContextKey,
  type ConversationFacts,
  claimOf,
  type Impulse,
  type ImpulseHost,
  type ImpulseRun,
  newId,
  PlatformSinksKey,
} from "@miyoria/types";
import { z } from "zod";
import type { Agent } from "../../agent/src/index.js";
import type { Wake } from "../../self/src/index.js";
import { ADMITTED_NOTES, CHAT_NOTES, NOTICE_TOOL, noticeLine } from "./impulse-texts.js";
import type { AdmittedAnswer, AdmittedInput } from "./lane.js";

/** How long the Arbiter waits for a lane to take (or refuse) what it admitted. */
const OPEN_TIMEOUT_MS = 5_000;

export interface ImpulseDeskHost {
  agent: Agent;
  /** Hands `input` to the lane of `context`; `false`: no lane took it. */
  admit(context: ContextKey, input: AdmittedInput): boolean;
  /** Puts `wake` in the lane of `context`, after what is there. */
  wake(context: ContextKey, wake: Wake): boolean;
}

const refused = (reason: ArbiterReason, detail: string): ImpulseRun => ({
  status: "refused",
  reason,
  detail,
});

/** The Arbiter's host on the new runner (`ImpulseHostKey`). */
export class ImpulseDesk implements ImpulseHost {
  readonly #h: ImpulseDeskHost;

  constructor(host: ImpulseDeskHost) {
    this.#h = host;
  }

  facts(context: ContextKey): ConversationFacts {
    return this.#h.agent.facts(context);
  }

  async open(impulse: Impulse, signal?: AbortSignal): Promise<ImpulseRun> {
    const agent = this.#h.agent;
    if (agent.muted) return refused("denied", "緊急停止中");
    if (impulse.kind !== "speak") return refused("denied", "沒有動作的執行者");
    const target = impulse.target.context;
    if (target === null) return refused("denied", "沒有地方可以說");
    const source = impulse.source;
    const hers = source === "game" || source === "song" || source === "notice";
    const context = hers ? agent.ownLinesContext(target) : target;
    if (context.kind === "voice" && !agent.inVoice(context)) {
      return refused("denied", "不在那個語音頻道");
    }
    const claim = claimOf(impulse);
    agent.yieldTo(context, claim);
    const hint = (impulse.hint ?? "").trim();
    const wake = (): Wake | null => {
      if (source === "notice") return this.#notices(context);
      const what =
        source === "game"
          ? ADMITTED_NOTES.game(hint)
          : source === "song"
            ? ADMITTED_NOTES.song(hint)
            : ADMITTED_NOTES.other(hint === "" ? impulse.why : hint);
      return what.trim() === "" ? null : { kind: "world", what, claim };
    };
    const turn = newId();
    const answer = await this.#admit(context, turn, wake, signal);
    switch (answer.status) {
      case "started":
        return { status: "started", turn, task: null, detail: "" };
      case "busy":
        return { status: "busy", detail: answer.why };
      case "empty":
        return refused("repeat", "已經說過了");
    }
  }

  /** The notices waiting for `context` as a result to tell, taken; `null`: none are left. */
  #notices(context: ContextKey): Wake | null {
    const notices = this.#h.agent.takeNotices(context);
    if (notices.length === 0) return null;
    const only = notices.length === 1 ? notices[0] : undefined;
    return {
      kind: "result",
      tool: NOTICE_TOOL,
      job: only?.task ?? null,
      ok: notices.every((n) => n.ok),
      text: notices.map((n) => noticeLine(n.ok, n.text)).join("\n"),
      from: null,
    };
  }

  /** Hands the run to the lane of `context` and waits for its answer (busy after a while). */
  #admit(
    context: ContextKey,
    turn: string,
    wake: () => Wake | null,
    signal: AbortSignal | undefined,
  ): Promise<AdmittedAnswer> {
    return new Promise<AdmittedAnswer>((resolve) => {
      let settled = false;
      const done = (answer: AdmittedAnswer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = (): void => done({ status: "busy", why: "the arbiter gave up on it" });
      const timer = setTimeout(
        () => done({ status: "busy", why: "the place did not answer" }),
        OPEN_TIMEOUT_MS,
      );
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const taken = this.#h.admit(context, {
        type: "admitted",
        turn,
        // An answer that came too late is no run: the Arbiter already took it as busy.
        wake: () => (settled ? null : wake()),
        answer: done,
      });
      if (!taken) done({ status: "busy", why: "the place is closing" });
    });
  }
}

/** Why she may not start talking in `context` now; `null`: she may. */
function startRefusal(agent: Agent, context: ContextKey): string | null {
  if (agent.muted) return "the emergency stop";
  if (context.kind !== "dm") {
    const mode = agent.handle.channelMode(context);
    if (mode === "off" || mode === "mention-only") return `mode ${mode}`;
  }
  const budget = agent.handle.llmBudget();
  return budget === "ok" ? null : `llm budget ${budget}`;
}

const NoArgs = z.object({});
const DmArgs = z.object({ to: z.string().trim().min(1).max(64) });

/** `chat.start` and `chat.dm` on the new runner. */
export function chatCapabilities(host: ImpulseDeskHost): Capability[] {
  const agent = host.agent;
  const start = defineCapability<z.output<typeof NoArgs>>({
    name: CHAT_START,
    summary: "主動開口說話(在頻道或她所在的語音頻道)",
    risk: "medium",
    args: NoArgs,
    permission: null,
    limits: { per_day: 200, per_person_per_day: 50, cooldown_ms: 0 },
    scope: (_args, principal) => principal.context?.scope ?? null,
    check: (_args, principal) => {
      const context = principal.context;
      if (context === null) return "no context to talk in";
      if (context.kind === "dm") return "use chat.dm for DMs";
      if (context.kind === "voice" && !agent.inVoice(context)) {
        return "she is not in that voice channel";
      }
      return null;
    },
    async execute(_args, ctx) {
      const context = ctx.principal.context;
      if (context === null) throw new CapabilityError("no context to talk in");
      const why = startRefusal(agent, context);
      if (why !== null) throw new CapabilityError(why);
      if (!host.wake(context, { kind: "self", note: CHAT_NOTES.start(ctx.request.why) })) {
        throw new CapabilityError("the place is closing");
      }
      return { text: "her run is queued", data: null };
    },
  });
  const dm = defineCapability<z.output<typeof DmArgs>>({
    name: CHAT_DM,
    summary: "主動私訊某個人聊天",
    risk: "medium",
    args: DmArgs,
    permission: "chat.dm",
    consent: "dm",
    limits: { per_day: 6, per_person_per_day: 2, cooldown_ms: 600_000 },
    target: (args, principal) => recipient(args.to, principal),
    check: (args, principal) =>
      recipient(args.to, principal) === null ? "`to` must be a mention or an id" : null,
    async execute(args, ctx) {
      const to = recipient(args.to, ctx.principal);
      if (to === null) throw new CapabilityError("no recipient");
      const sink = ctx.services.get(PlatformSinksKey)?.get(to.platform);
      if (!sink?.openDm) throw new CapabilityError(`cannot send DMs on ${to.platform}`);
      const context = await sink.openDm(to, ctx.signal);
      const why = startRefusal(agent, context);
      if (why !== null) throw new CapabilityError(why);
      if (!host.wake(context, { kind: "self", note: CHAT_NOTES.dm(ctx.request.why) })) {
        throw new CapabilityError("the place is closing");
      }
      return { text: "her DM run is queued", data: null };
    },
  });
  return [start as Capability, dm as Capability];
}
