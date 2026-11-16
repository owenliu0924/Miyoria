// Subject `current`: her brain as it runs today, put together the way the replay runner does it
// (tools/replay/src/runner.ts): the agent (coordinator, attention, the main line, the tool loop and
// the hands), the gate, the Arbiter and its Floor, the ActivityManager, world, self, the mind and
// the fact layer, on one supervisor and one bus, with the character's real profile.
//
// What is not hers here, and only this:
// - the model is whatever router the caller passes (the live one, or a scripted one in tests);
// - the platform: scene lines are published as `platform.message.created`, and a sink records what
//   she sends and reports it delivered;
// - the store: settings and the event log stay in memory, and each scene starts a fresh brain, so
//   nothing carries over from one scene to the next;
// - who people are: the scene's closeness is served as `SocialSignals` (the social module's seat),
//   so the people block of her prompt shows the bond level the scene says;
// - her state line, when the scene sets one, is one prompt contributor section;
// - tools of a tool scene: fake-world tools registered in her registry under the task's names. Her
//   own loop and hands decide where each one runs (`loop_tools`), as in production;
// - her attention's dice are fixed at 0 (every chance above zero passes). A `mention` or a `dm`
//   never rolls. For `none` her attention still decides, as in production: at the profile's
//   default channel level a line that is not for her usually gets no model call at all;
// - the mind's Plan and the Arbiter's greetings are off (`DEFAULT_MODULES`), so what she does in a
//   scene is her answer to it and what follows from that.
//
// The modules of the core that the replay runner leaves out are left out here too: memory (so no
// `recall` / `remember` and nothing remembered in her prompt), the social engine, moderation, the
// owner's directives, the economy, the sandbox and web tools, voice.

import { ActivityModule } from "@miyoria/brain/activity";
import { AgentModule } from "@miyoria/brain/agent";
import { ArbiterModule } from "@miyoria/brain/arbiter";
import { ActionsModule, ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { MindModule } from "@miyoria/heart/mind";
import { SelfModule } from "@miyoria/heart/self";
import { type LlmRouter, LlmRouterKey } from "@miyoria/llm/llm";
import { type Tool, ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import { FactsModule } from "@miyoria/memory/facts";
import { WorldModule } from "@miyoria/memory/world";
import {
  defineManifest,
  type EventBus,
  type Module,
  type ModuleContext,
  Supervisor,
  sleep,
} from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  type Action,
  type ActionSettled,
  type ActionSink,
  ActionSinkKey,
  type Attitude,
  type Clock,
  type ContextKey,
  Events,
  type IncomingMessage,
  is,
  isJsonObject,
  type JsonValue,
  type PersonId,
  PromptContributors,
  PromptContributorsKey,
  relationshipLabel,
  type SocialSignals,
  SocialSignalsKey,
  type TurnId,
  toTimestamp,
} from "@miyoria/types";
import { FAKE_TOOL_SPECS } from "./fake-tools.js";
import type { Meter } from "./meter.js";
import {
  type Closeness,
  type Reply,
  type ReplyCall,
  type Scene,
  type ScenePerson,
  type Subject,
  subUsage,
} from "./subject.js";

export interface CurrentOptions {
  router: LlmRouter;
  /** The meter the router's providers are wrapped with: a reply's usage is what it counted. */
  meter: Meter;
  profile: Profile;
  /** The longest a scene may take in all (default 180 s). */
  timeoutMs?: number;
  /**
   * After she used a tool: she is done when no turn is in flight, no result waits for the Floor
   * and nothing happened for this long (default 8 s; the Arbiter retries a deferred result after 3).
   */
  settleMs?: number;
  /** The same for a scene in which she used no tool (default 1.5 s). */
  quietMs?: number;
  /** No turn started this long after the last line: she let it pass (default 20 s). */
  startMs?: number;
  /** Config per module id, as `[modules.<id>]`, over `DEFAULT_MODULES`. */
  modules?: Record<string, JsonValue>;
  /** Every bus event of a scene after its last line, with the ms since then (for looking into a run). */
  onEvent?: (type: string, data: unknown, ms: number) => void;
}

/**
 * Every module runs on its defaults but two switches. Both are things a brain that starts with an
 * empty store does a few seconds into every scene, and neither is an answer to the scene:
 * - the mind makes its first plan of the day (a model call, and maybe lines of her own): it gets
 *   no Plan calls;
 * - the Arbiter greets a friend on their first message of the day (a second turn, some seconds
 *   after her reply): greetings are off.
 */
export const DEFAULT_MODULES: Record<string, JsonValue> = {
  mind: { max_calls_per_hour: 0 },
  arbiter: { greeting: false },
};

const PLATFORM = "eval";
const SELF: AccountRef = { platform: PLATFORM, id: "self" };
const POLL_MS = 25;

class Stub implements Module {
  readonly manifest;
  constructor(
    id: string,
    readonly provide: (ctx: ModuleContext) => void,
  ) {
    this.manifest = defineManifest(id, `${id} (eval)`);
  }
  async start(ctx: ModuleContext): Promise<void> {
    this.provide(ctx);
  }
}

/** The scheduler and the platform: records her messages and reports each as delivered. */
class CaptureSink implements ActionSink {
  readonly lines: string[] = [];
  onSubmit: () => void = () => undefined;

  constructor(readonly bus: EventBus) {}

  async submit(action: Action): Promise<void> {
    this.onSubmit();
    const payload = action.payload;
    if (payload.type !== "send_message") return;
    this.lines.push(payload.message.text);
    const message = { context: payload.context, id: `sent-${action.id}` };
    const settled: ActionSettled = {
      action: action.id,
      turn: action.turn,
      type: "send_message",
      context: payload.context,
      text: payload.message.text,
      ok: true,
      error: null,
      message,
    };
    queueMicrotask(() => {
      this.bus.publish("scheduler", Events.ActionCompleted, {
        action: action.id,
        turn: action.turn,
        ok: true,
        error: null,
        message,
      });
      this.bus.publish("scheduler", Events.ActionSettled, settled);
    });
  }

  async cancelTurn(_turn: TurnId): Promise<void> {}
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

function accountOf(index: number): AccountRef {
  return { platform: PLATFORM, id: `u${index + 1}` };
}

function attitudeOf(index: number, person: ScenePerson, c: Closeness): Attitude {
  const familiarity = clamp(c.familiarity ?? c.bond, 0, 100);
  return {
    person: `eval-person-${index + 1}` as PersonId,
    affinity: clamp(c.bond, -100, 1000),
    trust: clamp(c.trust ?? c.bond, 0, 100),
    familiarity,
    blocked: false,
    label: relationshipLabel({ affinity: c.bond, familiarity }),
    call_name: null,
    display_name: person.name,
  };
}

/** `YYYY-MM-DD HH:MM` in the local time zone, as epoch ms. */
function localMs(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!m) throw new Error(`bad scene time ${text}`);
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime();
}

function merge(base: JsonValue | undefined, over: JsonValue | undefined): JsonValue {
  if (over === undefined) return base ?? null;
  if (!isJsonObject(base) || !isJsonObject(over)) return over;
  const out: Record<string, JsonValue> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

export class CurrentSubject implements Subject {
  readonly name = "current";
  readonly #o: CurrentOptions;

  constructor(options: CurrentOptions) {
    this.#o = options;
  }

  unsupported(scene: Scene): string | null {
    const unknown = (scene.tools?.tools ?? []).filter((t) => FAKE_TOOL_SPECS[t] === undefined);
    if (unknown.length > 0) return `no fake tool definition for ${unknown.join(", ")}`;
    if (scene.lines.length === 0) return "the scene has no line";
    if (scene.place === "dm" && scene.address !== "dm") return "a DM scene is addressed by `dm`";
    if (scene.place === "text" && scene.address === "dm") return "`dm` needs the place to be a DM";
    return null;
  }

  async respond(scene: Scene): Promise<Reply> {
    const o = this.#o;
    // Tool scenes with a time run on a clock shifted to it, so the dates she reads in her prompt
    // are the fake world's. Only what reads the module clock follows; timers stay real.
    const shift = scene.now === undefined ? 0 : localMs(scene.now) - Date.now();
    const clock: Clock = { now: () => Date.now() + shift };
    const sup = new Supervisor({ clock });
    const all = sup.bus.subscribe("*");

    const services = sup.services;
    services.provide("app", SettingsStoreKey, new MemorySettingsStore());
    const tools = new ToolRegistry();
    services.provide("app", ToolRegistryKey, tools);
    const contributors = new PromptContributors();
    services.provide("app", PromptContributorsKey, contributors);
    const actuators = new ActuatorRegistry({
      services,
      tools,
      publish: sup.bus.publisher("actions"),
    });
    services.provide("app", ActuatorRegistryKey, actuators);

    const accounts = new Map<string, AccountRef>();
    const attitudes = new Map<string, Attitude>();
    scene.people.forEach((p, i) => {
      const account = accountOf(i);
      accounts.set(p.name, account);
      if (p.closeness) attitudes.set(account.id, attitudeOf(i, p, p.closeness));
    });
    const social: SocialSignals = {
      attitude: (account) => attitudes.get(account.id) ?? null,
      attitudeOf: (person) => [...attitudes.values()].find((a) => a.person === person) ?? null,
    };
    services.provide("app", SocialSignalsKey, social);

    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const sink = new CaptureSink(sup.bus);
    sink.onSubmit = touch;
    const profile = o.profile;
    const config = (id: string) => merge(DEFAULT_MODULES[id], o.modules?.[id]);

    await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, o.router)), null, true);
    await sup.register(
      new Stub("scheduler", (ctx) => ctx.provide(ActionSinkKey, sink)),
      null,
      true,
    );
    const agent = new AgentModule(profile)
      .withRandom({ nextF32: () => 0 })
      .withImageFetch(async () => {
        throw new Error("no network in an eval scene");
      });
    const modules: Module[] = [
      // First, as in the core: the main line and the Floor read the log.
      new FactsModule(null, profile.id, { names: profile.names() }),
      agent,
      new ActionsModule(profile.displayName),
      new ActivityModule(),
      new WorldModule(),
      new SelfModule(profile.id),
      new ArbiterModule(profile.id),
      new MindModule(profile.id, {
        name: profile.displayName,
        persona: () => profile.personaPrompt(),
      }),
    ];
    for (const m of modules) await sup.register(m, config(m.manifest.id), true);

    const before = o.meter.usage();
    const calls: ReplyCall[] = [];
    const flying = new Set<string>();
    /** Impulses the Arbiter deferred and has not settled yet. */
    const waiting = new Set<string>();
    /** She used a tool or her hands reported: more turns may follow. */
    let acted = false;
    let outcomes = 0;
    let timedOut = false;
    let startedAt = Date.now();
    try {
      await sup.startAll();
      sup.bus.publish(`platform.${PLATFORM}`, Events.PlatformReady, {
        platform: PLATFORM,
        self_account: SELF,
      });

      // After the modules are up: a module's own tool of the same name (the mind's `remind_me`)
      // gives way to the fake world's for this scene.
      const env = scene.tools;
      for (const name of env?.tools ?? []) {
        const spec = FAKE_TOOL_SPECS[name];
        if (!spec || !env) continue;
        const tool: Tool = {
          spec: { name, description: spec.description, parameters: spec.parameters },
          ...(spec.readOnly ? { readOnly: true } : {}),
          async call(_ctx, args) {
            const given = isJsonObject(args) ? (args as Record<string, unknown>) : {};
            const result = env.call(name, given);
            calls.push({ tool: name, args: given, ...result });
            acted = true;
            touch();
            if (!result.ok) throw new Error(result.text);
            return result.text;
          },
        };
        tools.register(tool);
      }
      const state = scene.state;
      if (state !== undefined) {
        contributors.register({
          key: "eval.state",
          contribute: async () => [{ key: "eval.state", title: "現在", body: state, order: 0 }],
        });
      }

      const context: ContextKey =
        scene.place === "dm"
          ? { platform: PLATFORM, scope: null, channel: "dm-1", kind: "dm" }
          : { platform: PLATFORM, scope: "guild-1", channel: "channel-1", kind: "channel" };
      let ts = clock.now();
      scene.lines.forEach((line, i) => {
        const lastLine = i === scene.lines.length - 1;
        const account = accounts.get(line.who) ?? {
          platform: PLATFORM,
          id: `guest-${line.who}`,
        };
        ts = Math.max(clock.now(), ts + 1);
        const message: IncomingMessage = {
          id: { context, id: `m${i + 1}` },
          author: { account, display_name: line.who, is_bot: false },
          text: line.text,
          mentions_self: lastLine && scene.address === "mention",
          reply_to_self: false,
          attachments: [],
          ts: toTimestamp(ts),
        };
        sup.bus.publish(`platform.${PLATFORM}`, Events.PlatformMessageCreated, message);
      });
      startedAt = Date.now();
      touch();

      const timeoutMs = o.timeoutMs ?? 180_000;
      const settleMs = o.settleMs ?? 8_000;
      const quietMs = o.quietMs ?? 1_500;
      const startMs = o.startMs ?? 20_000;
      for (;;) {
        for (let env = all.tryRecv(); env !== null; env = all.tryRecv()) {
          o.onEvent?.(env.type, env.data, Date.now() - startedAt);
          if (is(Events.AgentTurnStarted, env)) {
            flying.add(env.data.turn);
          } else if (is(Events.AgentTurnOutcome, env)) {
            flying.delete(env.data.turn);
            outcomes += 1;
          } else if (is(Events.AgentTool, env)) {
            acted = true;
          } else if (is(Events.ArbiterDecided, env) && env.data.source === "followup") {
            // A result of her hands waits for the Floor as an impulse; it becomes a turn later.
            if (env.data.verdict === "deferred") waiting.add(env.data.impulse);
            else waiting.delete(env.data.impulse);
          } else continue;
          touch();
        }
        const now = Date.now();
        const idle = flying.size === 0 && waiting.size === 0;
        if (idle && outcomes > 0 && now - last >= (acted ? settleMs : quietMs)) break;
        if (idle && outcomes === 0 && now - startedAt >= startMs) break;
        if (now - startedAt >= timeoutMs) {
          timedOut = true;
          break;
        }
        await sleep(POLL_MS);
      }
    } finally {
      await sup.stopAll();
      all.close();
    }
    const lines = sink.lines.filter((l) => l.trim() !== "");
    return {
      lines,
      calls,
      silent: lines.length === 0,
      usage: subUsage(o.meter.usage(), before),
      ms: Math.max(0, last - startedAt),
      ...(timedOut ? { timed_out: true } : {}),
    };
  }
}
