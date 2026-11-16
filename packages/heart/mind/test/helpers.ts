// A real supervisor with the mind module, the real `self` module, a stub `llm` module (mock
// provider), an app actuator registry with fake capabilities, and fakes for the world, social
// and the agent's intent sink.

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/gate/actions";
import {
  type ChatProvider,
  type ChatRequest,
  LlmRouter,
  LlmRouterKey,
  type ModelRef,
  parseModelRef,
} from "@miyoria/llm/llm";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type Subscription,
  Supervisor,
} from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  type Envelope,
  type EventPayload,
  Events,
  is,
  type JsonValue,
  type Mind,
  MindKey,
  type PersonPresence,
  type Publish,
  SocialSignalsKey,
  toTimestamp,
  type VoiceActivity,
  type WorldSnapshot,
  type WorldState,
  WorldStateKey,
} from "@miyoria/types";
import { vi } from "vitest";
import { z } from "zod";
import { SelfModule } from "../../self/src/index.js";
import { type Social, SocialKey } from "../../social/src/index.js";
import { MindModule, type MindModuleOptions } from "../src/index.js";
import type { FakeArbiter } from "./fakes.js";

export const GUILD = "g1";
export const TEXT: ContextKey = {
  platform: "discord",
  scope: GUILD,
  channel: "c1",
  kind: "channel",
};
export const VOICE: ContextKey = {
  platform: "discord",
  scope: GUILD,
  channel: "v1",
  kind: "voice",
};
export const OWEN: AccountRef = { platform: "discord", id: "100" };
export const HER: AccountRef = { platform: "discord", id: "999" };

class Stub implements Module {
  readonly manifest;
  constructor(
    id: string,
    readonly provide: (ctx: ModuleContext) => void,
  ) {
    this.manifest = defineManifest(id, `${id} stub`);
  }
  async start(ctx: ModuleContext): Promise<void> {
    this.provide(ctx);
  }
}

export class FakeWorld implements WorldState {
  voiceMembers: { account: AccountRef; name: string }[] = [];
  /** Accounts online (Owen by default). */
  online = new Set<string>([OWEN.id]);
  herVoice: ContextKey | null = null;
  /** Conversation in the voice channel (from utterances). */
  voiceActivity: VoiceActivity | null = null;
  game: string | null = null;
  lively = false;
  summaryText = "Owen 在線,在玩 Minecraft。";

  snapshot(): WorldSnapshot {
    return {
      at: toTimestamp(Date.now()),
      time: { local: "", weekday: 1, weekend: false, part_of_day: "晚上", utc_offset_minutes: 480 },
      her: {
        voice: this.herVoice,
        voice_name: null,
        golive: null,
        streaming: false,
        scene: null,
        game: this.game,
      },
      people: [...this.online].flatMap((id) => {
        const p = this.person({ platform: "discord", id });
        return p ? [p] : [];
      }),
      voice_channels:
        this.voiceMembers.length === 0
          ? []
          : [
              {
                platform: "discord",
                guild: GUILD,
                channel: VOICE.channel,
                name: "聊天室",
                activity: this.voiceActivity,
                members: this.voiceMembers.map((m) => ({
                  account: m.account,
                  person: null,
                  display_name: m.name,
                  is_self: false,
                  muted: false,
                  deafened: false,
                  video: false,
                  streaming: false,
                  since: toTimestamp(0),
                })),
              },
            ],
      channels: [
        {
          context: TEXT,
          recent_messages: 6,
          per_minute: 1,
          last_at: null,
          recent_authors: ["Owen"],
          topic: ["海豚"],
          lively: this.lively,
          her_last_at: null,
        },
      ],
    };
  }
  person(account: AccountRef): PersonPresence | null {
    if (account.id !== OWEN.id) return null;
    return {
      account,
      person: "person-owen",
      display_name: "Owen",
      status: this.online.has(account.id) ? "online" : "offline",
      activities: [
        {
          type: "playing",
          name: "Minecraft",
          details: null,
          state: null,
          started_at: null,
          url: null,
        },
      ],
      voice: null,
      online_since: null,
      updated_at: toTimestamp(0),
    };
  }
  personById() {
    return null;
  }
  summary() {
    return this.summaryText;
  }
}

/** Attitudes for the gate / prompt, and the capped events social would apply. */
export class FakeSocial {
  readonly events: [string, unknown][] = [];
  attitude(account: AccountRef): Attitude | null {
    if (account.id !== OWEN.id) return null;
    return {
      person: "person-owen",
      affinity: 40,
      trust: 50,
      familiarity: 60,
      blocked: false,
      label: "朋友",
      call_name: null,
    };
  }
  personOf(account: AccountRef) {
    return account.id === OWEN.id ? "person-owen" : null;
  }
  displayName() {
    return "Owen";
  }
  async applyEvents(person: string, events: unknown): Promise<void> {
    this.events.push([person, events]);
  }
}

/** A provider that records its requests (`MockProvider`, `ScriptedProvider`). */
export type TestProvider = ChatProvider & { requests(): ChatRequest[] };

export interface Rig {
  sup: Supervisor;
  store: MemorySettingsStore;
  provider: TestProvider;
  registry: ActuatorRegistry;
  world: FakeWorld;
  social: FakeSocial;
  events: Subscription;
  mind(): Mind;
  publish: Publish;
  thoughts(): JsonValue[];
}

export interface RigOptions {
  config?: JsonValue;
  /** Only a `chat` chain (the mind purpose falls back). */
  chatOnly?: boolean;
  store?: MemorySettingsStore;
  /** Provides more app services before start. */
  extra?: (sup: Supervisor) => void;
  /** An Arbiter to provide (none: `arbiter` is not running). */
  arbiter?: FakeArbiter;
  /** More options of the mind module. */
  module?: Partial<MindModuleOptions>;
}

const running: Supervisor[] = [];

export async function stopRigs(): Promise<void> {
  for (const s of running.splice(0)) await s.stopAll();
}

export async function rig(provider: TestProvider, options: RigOptions = {}): Promise<Rig> {
  const sup = new Supervisor();
  running.push(sup);
  const store = options.store ?? new MemorySettingsStore();
  sup.services.provide("app", SettingsStoreKey, store);
  const registry = new ActuatorRegistry({
    services: sup.services,
    builtins: false,
    publish: sup.bus.publisher("actions"),
  });
  for (const name of ["chat.start", "chat.dm", "voice.join", "speak"]) {
    registry.register(
      defineCapability({
        name,
        summary: `fake ${name}`,
        risk: "low",
        args: z.looseObject({}),
        permission: null,
        async execute() {
          return "ok";
        },
      }),
    );
  }
  sup.services.provide("app", ActuatorRegistryKey, registry);
  if (options.arbiter) sup.services.provide("app", ArbiterKey, options.arbiter);
  options.extra?.(sup);
  const world = new FakeWorld();
  const social = new FakeSocial();
  const purposes = new Map<string, ModelRef[]>([["chat", [parseModelRef("p:chat")]]]);
  if (!options.chatOnly) purposes.set("mind", [parseModelRef("p:mind")]);
  const router = new LlmRouter(new Map([["p", provider]]), purposes);
  await sup.register(new Stub("llm", (ctx) => ctx.provide(LlmRouterKey, router)), null, true);
  await sup.register(new Stub("world", (ctx) => ctx.provide(WorldStateKey, world)), null, true);
  await sup.register(
    new Stub("social", (ctx) => {
      ctx.provide(SocialSignalsKey, social);
      ctx.provide(SocialKey, social as unknown as Social);
    }),
    null,
    true,
  );
  await sup.register(new SelfModule("p"), null, true);
  const events = sup.bus.subscribe("mind.*");
  await sup.register(
    new MindModule("p", {
      name: "DeepSeek-chan",
      persona: () => "你是住在深海的鯨魚娘。",
      ...options.module,
    }),
    // Her day plan is past by default (20:00 local in most tests): tests ask for it.
    { daily_hour: 23, ...((options.config as object | null) ?? {}) } as JsonValue,
    true,
  );
  await sup.startAll();
  return {
    sup,
    store,
    provider,
    registry,
    world,
    social,
    events,
    mind: () => sup.services.require(MindKey),
    publish: sup.bus.publisher("test"),
    thoughts: () => {
      const out: JsonValue[] = [];
      for (let e: Envelope | null = events.tryRecv(); e !== null; e = events.tryRecv()) {
        if (is(Events.MindThought, e)) out.push(e.data as unknown as JsonValue);
      }
      return out;
    },
  };
}

export function wait(ms: number): Promise<void> {
  return vi.advanceTimersByTimeAsync(ms).then(() => undefined);
}

export function salient(
  detail: string,
  account: AccountRef | null = OWEN,
): EventPayload<typeof Events.WorldSalient> {
  return {
    kind: "joined_voice",
    key: `joined_voice:${account?.id ?? "x"}`,
    account: account === null ? null : { ...account },
    person: account ? "person-owen" : null,
    display_name: account ? "Owen" : null,
    context: VOICE as unknown as JsonValue,
    detail,
    score: 0.8,
    count: 1,
    first_at: toTimestamp(Date.now()),
    at: toTimestamp(Date.now()),
  } as never;
}
