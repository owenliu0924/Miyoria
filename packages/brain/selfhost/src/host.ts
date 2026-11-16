// The text conversations on the phase-3 turn runner (`[modules.agent] runner = "self"`): the
// agent hands every line of a channel, thread or DM here instead of to its coordinators.
//
// Intake. Each line goes into the transcript of its place as it comes (`entryOfIncoming`): her
// own lines' echoes are skipped (the runner wrote them), a flagged line carries the input
// defence's note, a reply whose parent is not in the transcript gets the quote the platform sent
// along (`attachParent`), and the first line of a place that has no transcript yet comes after the
// platform's earlier lines (the backfill). The agent already dropped blocked people and lines the
// defence ignores.
//
// When she runs. `triage` decides per line: said to her (mention, name, reply, DM) wakes her,
// after the waits of the place's lane (`lane.ts`); anything else may earn a glance, under the
// place's level (`GLANCES_PER_HOUR`), a cap for the day and the panel's switch that pauses her
// own initiative (the Arbiter's `paused`). A long tool she started that comes back (`<owner>
// .task.done|failed`, `activity.done|failed` of the job the call reported) and a due timer of
// hers (`mind.reminder` fired) wake her as `result` and `timer`.
//
// A run. One `SelfRunner` for the process, the text profile, the blocks of `HostPrompt`, the
// service guard over the real services (directives, permissions, budget, Floor, moderation,
// quiet hours), the mouth as the outlet (`MouthOutlet`), `say` to the places she knows. Her
// delivered lines get their platform id in the transcript (`confirm`); a line the scheduler failed
// late is marked as not heard. What a run did is published as today's turn records.

import { type ContentPart, type LlmRouter, LlmRouterKey, withLlmTag } from "@miyoria/llm/llm";
import {
  type EntryInput,
  entryOfIncoming,
  type TranscriptStore,
  transcriptTables,
} from "@miyoria/memory/transcript";
import { errorMessage, type Subscription, sleep } from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ActionSinkKey,
  ArbiterKey,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type Envelope,
  Events,
  holdsBack,
  type IncomingMessage,
  is,
  type MessageRef,
  newId,
  PlatformHistoriesKey,
  parseTaskEvent,
  parseTaskTopic,
  sameAccount,
  type TurnOutcome,
  type TurnReason,
  timestampMs,
  toTimestamp,
} from "@miyoria/types";
import {
  type Agent,
  agentTurns,
  asideOf,
  backfillLimit,
  type CallKind,
  CorrectionTally,
  callKind,
  callsHer,
  directReason,
  maxDebounceMs,
  type TextLineMarks,
  type TextRunner,
  type TextRunnerFactory,
  TimeoutError,
  timeout,
  typingRefreshMs,
} from "../../agent/src/index.js";
import type { LocalTime } from "../../arbiter/src/index.js";
import {
  addressedReason,
  composeGuards,
  DEFAULT_TRIAGE,
  floorKind,
  noteGlance,
  type OutgoingLine,
  PROFILES,
  type RunEvent,
  type RunModel,
  type RunnerOptions,
  type RunResult,
  SelfRunner,
  sayTool,
  serviceGuard,
  type TriageDecision,
  type TriageEvent,
  type TriageState,
  triage,
  type Wake,
  type WakeAuthor,
  wakeAuthor,
} from "../../self/src/index.js";
import { LookAround } from "./around.js";
import { Lane, type LaneHost, type LaneRun } from "./lane.js";
import { MouthOutlet, Settlements, submitTyping } from "./outlet.js";
import { resolvePlace } from "./places.js";
import { HostPrompt } from "./prompt.js";
import { SAY_DM } from "./texts.js";

/** Lines of a place before the first one the backfill fetches at most. */
const MAX_BACKFILL = 50;
/** Jobs remembered while they run. */
const MAX_JOBS = 256;
/** Lines triage holds that move nothing in their place: no restart, no longer wait. */
const INERT: ReadonlySet<string> = new Set(["own", "bot", "flagged", "muted"]);

export interface SelfHostOptions {
  /** The Arbiter's clock (`[modules.arbiter]`), for the quiet hours; `null`: none. */
  quiet?: LocalTime | null;
  /** Glances a day over all places. Default `DEFAULT_TRIAGE.perDay`. */
  glancesPerDay?: number;
  /** The runner's own options (tests). */
  runner?: RunnerOptions;
  /** The transcripts; default: the store's (`StoreKey`, `transcriptTables`). */
  transcript?: TranscriptStore;
}

/** The factory Core installs on the agent module (`AgentModule.withTextRunner`). */
export function selfHost(options: SelfHostOptions = {}): TextRunnerFactory {
  return (agent) => new SelfHost(agent, options);
}

/** A place on the runner. */
interface Place {
  context: ContextKey;
  session: string;
  lane: Lane;
  /** Intake of its lines, one after another (the backfill comes first). */
  intake: Promise<void>;
}

/** What a run keeps while it goes. */
interface TurnState {
  place: Place;
  run: LaneRun;
  /** Her lines of the run that reached the place. */
  lines: number;
  firstLineAt: number | null;
  /** A line of the run carried the platform's reply reference already. */
  quoted: boolean;
  tally: CorrectionTally;
  /** The files and images of its lines, once asked for (`LookAround`). */
  attached: Promise<ContentPart[]> | null;
}

/** Something she started that has not come back. */
interface Job {
  context: ContextKey;
  tool: string;
  from: WakeAuthor | null;
}

export class SelfHost implements TextRunner {
  readonly #agent: Agent;
  readonly #o: SelfHostOptions;
  readonly transcript: TranscriptStore;
  readonly runner: SelfRunner;
  readonly prompt: HostPrompt;
  readonly #settlements = new Settlements();
  readonly #outlet: MouthOutlet;
  readonly #around: LookAround;
  readonly #places = new Map<string, Place>();
  readonly #turns = new Map<string, TurnState>();
  readonly #jobs = new Map<string, Job>();
  /** When she glanced at each place (`contextKeyString`). */
  #glances = new Map<string, readonly number[]>();
  #day = { key: "", count: 0 };
  readonly #stop = new AbortController();
  #subscription: Subscription | null = null;

  constructor(agent: Agent, options: SelfHostOptions = {}) {
    this.#agent = agent;
    this.#o = options;
    const transcript =
      options.transcript ?? agent.ctx.services.get(StoreKey)?.plugin(transcriptTables) ?? null;
    if (transcript === null) throw new Error("the text runner needs the store's transcripts");
    this.transcript = transcript;
    this.#around = new LookAround(agent, transcript);
    const sessionOf = (context: ContextKey) => this.#sessionFor(context);
    this.prompt = new HostPrompt(agent, {
      transcript,
      sessionOf,
      attachments: (input) => this.#attachments(input.turn),
    });
    this.#outlet = new MouthOutlet(
      agent,
      this.#settlements,
      (line, id) => this.#saidElsewhere(line.place, line.text, line.turn, id),
      (line) => this.#replyTarget(line),
    );
    const services = agent.ctx.services;
    const router = (): LlmRouter => {
      const r = services.get(LlmRouterKey);
      if (!r) throw new Error("the llm module is not running");
      return r;
    };
    const model: RunModel = {
      stream: (purpose, request, signal) => router().stream(purpose, request, signal),
      complete: (purpose, request, signal) => router().complete(purpose, request, signal),
      prices: () => services.get(LlmRouterKey)?.prices() ?? {},
    };
    this.runner = new SelfRunner(
      {
        transcript,
        tools: agent.tools,
        model,
        prompt: this.prompt,
        guard: composeGuards(serviceGuard({ services, quiet: options.quiet ?? null })),
        outlet: this.#outlet,
        clock: agent.ctx.clock,
        log: agent.log,
        onEvent: (event) => this.#onRunEvent(event),
        selfAccount: (platform) => agent.selfAccount(platform),
      },
      options.runner ?? {},
    );
    agent.tools.register(
      sayTool({
        resolve: (name, from) =>
          resolvePlace(
            {
              transcript,
              live: () => [...this.#places.values()].map((p) => p.context),
              sessionOf,
            },
            name,
            from,
          ),
        // A DM goes through `message_dm` only: one path for consent, permission and its limits.
        refuses: (place) => (place.kind === "dm" ? SAY_DM : null),
        sayIn: this.runner.sayIn,
      }),
    );
    // Every topic: task events come from any owner (`<owner>.task.done`).
    const sub = agent.ctx.subscribe("*");
    this.#subscription = sub;
    agent.ctx.spawn("selfhost.events", async () => {
      for await (const env of sub) {
        try {
          this.#event(env);
        } catch (error) {
          agent.log.warn({ err: errorMessage(error) }, "the text runner could not handle an event");
        }
      }
    });
  }

  get #now(): number {
    return this.#agent.ctx.clock.now();
  }

  // ---- TextRunner ------------------------------------------------------------------------------

  line(msg: IncomingMessage, marks: TextLineMarks): void {
    // Her own line: the runner wrote it when she said it.
    if (marks.own) return;
    const place = this.#place(msg.id.context);
    place.intake = place.intake
      .then(() => this.#take(place, msg, marks))
      .catch((error: unknown) =>
        this.#agent.log.warn({ err: errorMessage(error) }, "the text runner could not take a line"),
      );
  }

  typing(context: ContextKey): void {
    const place = this.#places.get(contextKeyString(context));
    if (place === undefined) return;
    // After the lines before it: a wait their line opens is the one it pushes out.
    place.intake = place.intake.then(() => {
      place.lane.push({ type: "typing" });
    });
  }

  halt(): void {
    for (const place of this.#places.values()) place.lane.push({ type: "halt" });
  }

  stop(): void {
    this.#stop.abort();
    this.#subscription?.close();
    for (const place of this.#places.values()) place.lane.close();
    this.#places.clear();
    this.#agent.tools.unregister("say");
  }

  /** The session of `context` on the runner. */
  sessionOf(context: ContextKey): string {
    return this.#sessionFor(context);
  }

  #sessionFor(context: ContextKey): string {
    const key = contextKeyString(context);
    return this.#places.get(key)?.session ?? this.transcript.sessionFor(context) ?? key;
  }

  /** Waits until every line handed over so far is in its transcript (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.#places.values()].map((p) => p.intake));
  }

  // ---- places ----------------------------------------------------------------------------------

  #place(context: ContextKey): Place {
    const key = contextKeyString(context);
    const known = this.#places.get(key);
    if (known !== undefined && !known.lane.ended) return known;
    const session = this.#sessionFor(context);
    const lane = new Lane(this.#laneHost(context));
    const place: Place = { context, session, lane, intake: known?.intake ?? Promise.resolve() };
    this.#places.set(key, place);
    this.#agent.ctx.spawn("selfhost.lane", (signal) => {
      const both = AbortSignal.any([signal, this.#stop.signal]);
      return lane.run(both);
    });
    return place;
  }

  #laneHost(context: ContextKey): LaneHost {
    const agent = this.#agent;
    const cfg = agent.config;
    return {
      context,
      now: () => this.#now,
      debounceMs: () => cfg.debounce_ms,
      maxDebounceMs: () => maxDebounceMs(cfg),
      typingExtendMs: () => cfg.typing_extend_ms,
      oneCallerPerTurn: () => cfg.one_caller_per_turn,
      idleMs: () => cfg.session_idle_ms,
      newTurn: () => newId(),
      addressedWake: (inputs) => this.#addressedWake(inputs),
      glanceWake: () => this.#glanceWake(context),
      execute: (run) => this.#execute(context, run),
      delivered: (turn) => this.#turns.get(turn)?.lines ?? 0,
      cancelQueued: async (turn) => {
        await agent.ctx.services.get(ActionSinkKey)?.cancelTurn(turn);
        agent.mainline.lines.cancelUnstarted(turn, "the run was cut");
      },
      handleOf: (author) => agent.handleOf(author.account, author.display_name),
      warn: (what, error) => agent.log.warn({ err: errorMessage(error) }, what),
    };
  }

  // ---- intake ----------------------------------------------------------------------------------

  /** How `msg` relates to her (the coordinator's `#callKind` without the voice facts). */
  #call(msg: IncomingMessage): CallKind {
    const names = this.#agent.persona.names();
    return callKind(msg, directReason(msg, names), null, asideOf(msg, names, [], false));
  }

  async #take(place: Place, msg: IncomingMessage, marks: TextLineMarks): Promise<void> {
    const agent = this.#agent;
    const { session, context } = place;
    const tail = this.transcript.tail(session);
    if (tail.entries.length === 0 && tail.summary === null) {
      await this.#backfill(place, msg);
    }
    const entry = entryOfIncoming(msg, {
      person_id: agent.attitude(msg.author.account)?.person ?? null,
    });
    const note = marks.verdict?.note ?? null;
    if (note) entry.flagged = note;
    this.transcript.append(session, [entry], { context });
    this.#around.recent.add(msg);
    this.#attachParent(place, msg);
    const call = this.#call(msg);
    const said = callsHer(call);
    const decision = triage(
      {
        kind: "line",
        place: contextKeyString(context),
        at: this.#now,
        addressed: said
          ? (addressedReason(directReason(msg, agent.persona.names())) ?? "mention")
          : null,
        own: false,
        bot: marks.bot,
        flagged: holdsBack(marks.verdict),
        muted: marks.muted || agent.handle.channelMode(context) === "off",
      },
      this.#triageState(context),
      this.#now,
    );
    agent.log.debug(
      { context: contextKeyString(context), message: msg.id.id, triage: describe(decision) },
      "text line triaged",
    );
    // The place's lane now: an idle one may have ended while the line was taken in.
    this.#place(context).lane.push({
      type: "line",
      msg,
      call: decision.decision === "wake" ? call : null,
      glance: decision.decision === "glance",
      inert: decision.decision === "hold" && INERT.has(decision.why),
    });
  }

  /** The quote the platform sent with a reply, when its parent is not in the transcript. */
  #attachParent(place: Place, msg: IncomingMessage): void {
    const ref = msg.reply_to ?? null;
    const quoted = msg.referenced ?? null;
    if (ref === null || quoted === null) return;
    const entries = this.transcript.tail(place.session).entries;
    if (entries.some((e) => e.message_id === ref.id && e.kind !== "note")) return;
    this.transcript.attachParent(place.session, msg.id.id, {
      author: quoted.author_name,
      text: quoted.text,
      message_id: ref.id,
      person_id: quoted.author ? (this.#agent.attitude(quoted.author)?.person ?? null) : null,
    });
  }

  /** The platform's lines before `first`, for a place she has no transcript of. */
  async #backfill(place: Place, first: IncomingMessage): Promise<void> {
    const agent = this.#agent;
    const limit = Math.min(backfillLimit(agent), MAX_BACKFILL);
    const history = agent.ctx.services.get(PlatformHistoriesKey)?.get(place.context.platform);
    if (limit <= 0 || !history) return;
    try {
      const fetched = await timeout(agent.config.history.timeout_ms, agent.ctx.signal, (s) =>
        history.recent(place.context, { before: first.id.id, limit }, s),
      );
      const entries: EntryInput[] = [];
      for (const m of fetched) {
        if (m.id.id === first.id.id || agent.isBlocked(m.author.account)) continue;
        if (agent.isSelf(m.author.account)) {
          if (m.text.trim() === "") continue;
          entries.push({ kind: "self", content: m.text, message_id: m.id.id, at: m.ts });
        } else {
          entries.push(entryOfIncoming(m));
          this.#around.recent.add(m);
        }
      }
      entries.sort((a, b) => timestampMs(a.at ?? first.ts) - timestampMs(b.at ?? first.ts));
      if (entries.length > 0) {
        this.transcript.append(place.session, entries, { context: place.context });
      }
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        agent.log.debug({ err: errorMessage(error) }, "no backfill for a new place");
      }
    }
  }

  // ---- triage ----------------------------------------------------------------------------------

  #today(): number {
    const key = new Date(this.#now - (this.#o.quiet?.day_start_hour ?? 4) * 3_600_000)
      .toISOString()
      .slice(0, 10);
    if (this.#day.key !== key) this.#day = { key, count: 0 };
    return this.#day.count;
  }

  #triageState(context: ContextKey): TriageState {
    const paused = this.#agent.ctx.services.get(ArbiterKey)?.ledger(context).limits.paused;
    return {
      config: {
        glances: paused !== true,
        perDay: this.#o.glancesPerDay ?? DEFAULT_TRIAGE.perDay,
      },
      level: () => this.#agent.handle.channelMode(context),
      glances: this.#glances,
      today: this.#today(),
    };
  }

  #addressedWake(inputs: readonly IncomingMessage[]): Wake | null {
    const names = this.#agent.persona.names();
    const first = inputs.find((m) => callsHer(this.#call(m)));
    if (first === undefined) return null;
    const reason =
      addressedReason(directReason(first, names)) ?? (first.reply_to_self ? "reply" : "mention");
    return {
      kind: "addressed",
      reason,
      from: { account: first.author.account, name: first.author.display_name },
      message: first.id,
    };
  }

  /** A glance at `context` if it is still due (another place may have taken the day's last). */
  #glanceWake(context: ContextKey): Wake | null {
    const place = contextKeyString(context);
    const now = this.#now;
    const event: TriageEvent = {
      kind: "line",
      place,
      at: now,
      addressed: null,
      own: false,
      bot: false,
      flagged: false,
      muted: this.#agent.muted,
    };
    const state = this.#triageState(context);
    if (triage(event, state, now).decision !== "glance") return null;
    const next = noteGlance(state, place, now);
    this.#glances = new Map(next.glances);
    this.#day.count = next.today;
    const entries = this.transcript.tail(this.#place(context).session).entries;
    let lines = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined || e.kind === "self" || e.kind === "tool_calls") break;
      if (e.kind === "other") lines += 1;
    }
    return lines === 0 ? null : { kind: "glance", lines };
  }

  // ---- a run -----------------------------------------------------------------------------------

  async #execute(context: ContextKey, run: LaneRun): Promise<void> {
    const agent = this.#agent;
    const place = this.#place(context);
    const turn = run.turn;
    const state: TurnState = {
      place,
      run,
      lines: 0,
      firstLineAt: null,
      quoted: false,
      tally: new CorrectionTally(false),
      attached: null,
    };
    agent.mainline.own(turn);
    agent.ctx.publish(Events.AgentTurnStarted, { turn, context }, { turn });
    // The Floor, once for the whole run (the old turn's `MainTurn.take`): a glance the Floor
    // refuses is no run at all; any other run holds the mic until it ends.
    const floor = agent.mainline.floor();
    const kind = floorKind(run.wake);
    const refused = kind === "ambient" ? (floor?.refuses("ambient", context) ?? null) : null;
    if (refused !== null) {
      agent.ctx.publish(
        Events.AgentDecision,
        {
          turn,
          context,
          respond: false,
          score: 0,
          reasons: [...decisionReasons(run.wake), `floor: ${refused}`],
        },
        { turn },
      );
      agentTurns.inc({ decision: "ignored" });
      this.#publish(state, null, null, { type: "silence" });
      return;
    }
    floor?.hold(turn, context, kind);
    this.#turns.set(turn, state);
    agent.ctx.publish(
      Events.AgentDecision,
      { turn, context, respond: true, score: 0, reasons: decisionReasons(run.wake) },
      { turn },
    );
    agentTurns.inc({ decision: "responded" });
    const typing = new AbortController();
    if (run.wake.kind === "addressed" || run.wake.kind === "result") {
      void this.#keepTyping(context, turn, AbortSignal.any([typing.signal, run.controller.signal]));
    }
    let result: RunResult | null = null;
    let error: string | null = null;
    try {
      result = await withLlmTag({ module: "agent", turn, label: "self" }, () =>
        this.runner.run({
          session: { id: place.session, context },
          wake: run.wake,
          profile: PROFILES.text,
          signal: run.controller.signal,
          turn,
        }),
      );
    } catch (e) {
      error = errorMessage(e);
      agent.log.warn({ turn, err: error }, "the runner failed");
    } finally {
      typing.abort();
      this.#outlet.ended(turn);
      this.#turns.delete(turn);
      // Freed once its lines settled (`Floor.turnEnded`), cancelled or not.
      floor?.turnEnded(turn);
    }
    if (result?.compacted) this.prompt.forget(place.session);
    this.#publish(state, result, error);
  }

  /** The files and images of the lines of the run of `turn` (block 6), looked at once. */
  #attachments(turn: string): Promise<ContentPart[]> {
    const state = this.#turns.get(turn);
    if (state === undefined) return Promise.resolve([]);
    state.attached ??= this.#around.parts({
      session: state.place.session,
      context: state.place.context,
      turn,
      inputs: this.#linesOf(state),
      signal: state.run.controller.signal,
    });
    return state.attached;
  }

  /**
   * The lines a run is about: those that called her; for a glance, the other people's lines since
   * her last one. A result or a timer has none.
   */
  #linesOf(state: TurnState): IncomingMessage[] {
    const { run, place } = state;
    if (run.wake.kind === "addressed") return run.inputs;
    if (run.wake.kind !== "glance") return [];
    const entries = this.transcript.tail(place.session).entries;
    const out: IncomingMessage[] = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined || e.kind === "self" || e.kind === "tool_calls") break;
      if (e.kind !== "other" || e.message_id === null) continue;
      const msg = this.#around.recent.get(place.context, e.message_id);
      if (msg !== undefined) out.unshift(msg);
    }
    return out;
  }

  async #keepTyping(context: ContextKey, turn: string, signal: AbortSignal): Promise<void> {
    const refresh = typingRefreshMs(this.#agent.config);
    while (!signal.aborted) {
      await submitTyping(this.#agent, context, turn);
      try {
        await sleep(refresh, signal);
      } catch {
        return;
      }
    }
  }

  /**
   * The platform reply reference of a line (`[modules.agent] reply_reference`), as the old turn
   * set it: the first line of a run that answers someone, in a channel or thread (not a DM), and
   * only when one person called her; with several, an unmarked reply quotes nobody.
   */
  #replyTarget(line: OutgoingLine): MessageRef | null {
    const state = this.#turns.get(line.turn);
    const agent = this.#agent;
    if (state === undefined || !line.focus || line.replyTo === null || state.quoted) return null;
    if (!agent.config.reply_reference || line.place.kind === "dm") return null;
    if (state.run.wake.kind !== "addressed") return null;
    const callers: AccountRef[] = [];
    for (const m of state.run.inputs) {
      if (!callsHer(this.#call(m))) continue;
      if (!callers.some((a) => sameAccount(a, m.author.account))) callers.push(m.author.account);
    }
    if (callers.length > 1) return null;
    state.quoted = true;
    return line.replyTo;
  }

  #onRunEvent(event: RunEvent): void {
    const state = this.#turns.get(event.turn);
    if (state === undefined) return;
    const agent = this.#agent;
    const context = state.place.context;
    switch (event.type) {
      case "line": {
        if (contextKeyEquals(event.place, context) && event.via !== "say") {
          state.lines += 1;
          state.firstLineAt ??= this.#now;
        }
        if (event.emotion !== null) {
          agent.ctx.publish(
            Events.AgentEmotion,
            { turn: event.turn, context: event.place, emotion: event.emotion.toLowerCase() },
            { turn: event.turn },
          );
        }
        break;
      }
      case "screened":
        if (event.kind !== "tag_stripped") state.tally.count(event.kind, event.count);
        break;
      case "tool_call":
        if (event.job !== null) {
          this.#jobs.set(event.job, {
            context,
            tool: event.name,
            from: wakeAuthor(state.run.wake),
          });
          while (this.#jobs.size > MAX_JOBS) {
            const oldest = this.#jobs.keys().next().value;
            if (oldest === undefined) break;
            this.#jobs.delete(oldest);
          }
        }
        break;
      case "refusal":
        agent.log.debug(
          { turn: event.turn, what: event.what, name: event.name, code: event.code },
          "the guard refused",
        );
        break;
      case "step":
        agent.log.debug(
          {
            turn: event.turn,
            round: event.round,
            model: event.model,
            finish: event.finish_reason,
            calls: event.calls,
            cost_usd: event.cost_usd,
          },
          "runner step",
        );
        break;
      case "started":
      case "finished":
        break;
    }
  }

  /**
   * `agent.tool`, `agent.turn.completed` and `agent.turn.outcome` of a run; `decided`: the outcome
   * of a run that never started (the Floor refused it).
   */
  #publish(
    state: TurnState,
    result: RunResult | null,
    error: string | null,
    decided: TurnOutcome | null = null,
  ): void {
    const agent = this.#agent;
    const { run } = state;
    const turn = run.turn;
    const context = state.place.context;
    for (const call of result?.calls ?? []) {
      agent.ctx.publish(
        Events.AgentTool,
        { turn, context, tool: call.name, ok: call.ok, result: call.text },
        { turn },
      );
    }
    agent.ctx.publish(
      Events.AgentTurnCompleted,
      { turn, context, text: result?.lines.join("\n") ?? "" },
      { turn },
    );
    const outcome: TurnOutcome = decided ?? runOutcome(state, result, error);
    const wake = run.wake;
    const lastInput = run.inputs.at(-1);
    agent.publishOutcome({
      turn,
      context,
      reason: turnReason(wake),
      outcome,
      addressed_by:
        wake.kind === "addressed" ? [agent.handleOf(wake.from.account, wake.from.name)] : [],
      focus: run.inputs.map((m) => ({ ...m.id })),
      restarts: run.restarts,
      reasoning: null,
      latency_ms:
        state.firstLineAt === null || lastInput === undefined
          ? null
          : Math.max(0, state.firstLineAt - timestampMs(lastInput.ts)),
      at: toTimestamp(this.#now),
      ...(result !== null && result.rounds > 0 ? { corrections: state.tally.counts() } : {}),
    });
  }

  /** A `say` of hers went out in another place: that place's transcript has it too. */
  #saidElsewhere(context: ContextKey, text: string, turn: string, id: string | null): void {
    const place = this.#place(context);
    place.intake = place.intake.then(() => {
      this.transcript.append(
        place.session,
        [{ kind: "self", content: text, turn, message_id: id }],
        { context },
      );
    });
  }

  // ---- what comes back -------------------------------------------------------------------------

  #event(env: Envelope): void {
    if (is(Events.ActionSettled, env)) {
      const taken = this.#settlements.settled(env.data);
      // Taken as said when the scheduler was slow, then it failed: nobody heard it.
      const turn = env.data.turn;
      if (!taken && !env.data.ok && turn !== null && env.data.type === "send_message") {
        const place = this.#places.get(contextKeyString(env.data.context));
        if (place !== undefined) this.transcript.heard(place.session, { turn }, "");
      }
      return;
    }
    if (is(Events.ActivityDone, env) || is(Events.ActivityFailed, env)) {
      const ok = env.type === Events.ActivityDone.type;
      this.#ended(env.data.task, ok, env.data.detail ?? "");
      return;
    }
    if (is(Events.MindReminder, env)) {
      const { state, reminder } = env.data;
      const context = reminder.context;
      if (state !== "fired" || context === null || context.kind === "voice") return;
      this.#place(context).lane.push({
        type: "wake",
        wake: { kind: "timer", note: reminder.what },
      });
      return;
    }
    if (is(Events.AgentMessageExcluded, env)) {
      this.transcript.redactMessage(env.data.message.id);
      return;
    }
    if (parseTaskTopic(env.type) !== null) {
      const event = parseTaskEvent(env.data);
      if (event === null || (event.type !== "done" && event.type !== "failed")) return;
      this.#ended(event.task, event.type === "done", event.detail);
    }
  }

  /** A job she started ended: the place it was started in hears it. */
  #ended(task: string, ok: boolean, detail: string): void {
    const job = this.#jobs.get(task);
    if (job === undefined) return;
    this.#jobs.delete(task);
    this.#place(job.context).lane.push({
      type: "wake",
      wake: { kind: "result", tool: job.tool, job: task, ok, text: detail, from: job.from },
    });
  }
}

/** How a run that started ended, as today's turn records say it. */
function runOutcome(state: TurnState, result: RunResult | null, error: string | null): TurnOutcome {
  if (result === null) return { type: "error", error: error ?? "the run failed" };
  if (result.outcome === "cancelled") {
    const cancel = state.run.cancel;
    return { type: "cancelled", cause: cancel?.cause ?? "shutdown", by: cancel?.by ?? null };
  }
  if (state.lines > 0 || result.outcome === "said") {
    return { type: "sent", parts: Math.max(state.lines, result.lines.length) };
  }
  if (result.outcome === "silent") return { type: "silence" };
  return { type: "error", error: result.outcome };
}

function describe(decision: TriageDecision): string {
  return decision.decision === "glance" ? "glance" : `${decision.decision}:${decision.why}`;
}

function decisionReasons(wake: Wake): string[] {
  const reasons = ["runner self"];
  switch (wake.kind) {
    case "addressed":
      reasons.push(`addressed: ${wake.reason}`);
      break;
    case "glance":
      reasons.push(`glance: ${wake.lines} line(s)`);
      break;
    case "result":
      reasons.push(`result: ${wake.tool}${wake.ok ? "" : " (failed)"}`);
      break;
    default:
      reasons.push(wake.kind);
  }
  return reasons;
}

function turnReason(wake: Wake): TurnReason {
  switch (wake.kind) {
    case "addressed":
      return wake.reason === "reply" ? "reply_to_her" : "addressed";
    case "glance":
      return "ambient";
    default:
      return "initiative";
  }
}
