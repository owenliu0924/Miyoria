import { CommandMount } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import {
  IdentityStoreKey,
  MemoryRecordStoreKey,
  PeopleStoreKey,
  RelationshipStoreKey,
  StoreKey,
} from "@miyoria/store";
import {
  AuthorizerKey,
  type ContextKey,
  contextKeyString,
  EMOTION_LABELS,
  Events,
  is,
  isJsonObject,
  type JsonValue,
  MindKey,
  type PersonId,
  type ProfileId,
  RelationshipEffectsKey,
  type SelfState,
  SelfStateKey,
  SocialSignalsKey,
  safeName,
} from "@miyoria/types";
import { callNameCapability } from "./call-name-tool.js";
import { registerCommands, unregisterCommands } from "./commands.js";
import { SocialConfigSchema } from "./config.js";
import { type Observed, Social, SocialKey, type SocialStores } from "./engine.js";

/** Thrown by `start` when a required store is missing. */
export class SocialError extends Error {
  override readonly name = "SocialError";
}

interface Running {
  social: Social;
  commands: CommandMount;
  off: () => void;
}

/** Liked this much counts as someone she cares about, for the appraisal. */
const CARES_AFFINITY = 40;

/**
 * What she cares about, for the appraisal to read her feelings: the people she likes, her
 * secret crush, her strongest emotions and wants. Short; names are made inert.
 */
export function concerns(social: Social, self: SelfState): string {
  const lines: string[] = [];
  const name = (p: PersonId) => safeName(social.displayName(p) ?? "某人", 24);
  const liked = social.liked(CARES_AFFINITY, 5);
  if (liked.length > 0) lines.push(`- 她喜歡的人:${liked.map(name).join("、")}`);
  const crush = self.crush();
  if (crush) lines.push(`- 她偷偷喜歡(暗戀,祕密):${name(crush.person)}`);
  const felt = self.emotions().slice(0, 3);
  if (felt.length > 0) {
    lines.push(`- 她現在的情緒:${felt.map((e) => EMOTION_LABELS[e.name]).join("、")}`);
  }
  const drives = self.drives();
  const wants: string[] = [];
  if (drives.esteem >= 0.65) wants.push("被誇、被認可");
  if (drives.attention >= 0.65) wants.push("被注意");
  if (drives.social >= 0.65) wants.push("有人陪她聊天");
  if (drives.longing >= 0.5 && crush) wants.push("那個人注意她");
  if (drives.hunger >= 0.7) wants.push("吃白飯(Token)");
  if (wants.length > 0) lines.push(`- 她現在很想要:${wants.join("、")}`);
  return lines.join("\n");
}

function stores(ctx: ModuleContext): SocialStores {
  const services = ctx.services;
  const bundle = services.get(StoreKey);
  const people = services.get(PeopleStoreKey) ?? bundle?.people;
  if (!people) throw new SocialError("social needs a `dyn PeopleStore` (or `Store`) service");
  const relationships = services.get(RelationshipStoreKey) ?? bundle?.relationships;
  if (!relationships) throw new SocialError("social needs a `dyn RelationshipStore` service");
  const identity = services.get(IdentityStoreKey) ?? bundle?.identity ?? null;
  if (!identity) ctx.log.warn("no identity store: `/me link` is unavailable");
  // The memory plugin's tables: the `Store` bundle holds no memories of its own.
  const memories = services.get(MemoryRecordStoreKey) ?? null;
  if (identity && !memories) {
    ctx.log.warn("no memory record store: `/me link` does not move memories");
  }
  return { people, relationships, identity, memories };
}

/**
 * Module `social`. Requires `llm`; `commands` is optional.
 *
 * Services used: `RelationshipStoreKey` (required), `PeopleStoreKey` (or the `StoreKey`
 * bundle), `IdentityStoreKey` (optional, for `/me link`), `MemoryRecordStoreKey` (optional, so
 * `/me link` moves memories too), `PromptContributorsKey`, `CommandRegistryKey` and
 * `AuthorizerKey` (optional). Provides `SocialSignalsKey`, `SocialKey` and `RelationshipEffectsKey`.
 */
export class SocialModule implements Module {
  static readonly ID = "social";
  readonly manifest = defineManifest(SocialModule.ID, "Social", {
    description: "Relationships, appraisal and account linking",
    requires: ["llm"],
    optional: ["commands"],
    configSchema: SocialConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #herName: string;
  readonly #names: string[];
  #running: Running | null = null;

  constructor(profile: ProfileId, herName: string, names: readonly string[]) {
    this.#profile = profile;
    this.#herName = herName;
    this.#names = [...names];
  }

  /** Uses the profile's id, display name and nicknames. */
  static fromProfile(profile: Profile): SocialModule {
    return new SocialModule(profile.id, profile.displayName, profile.names());
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(SocialConfigSchema);
    const social = new Social(
      this.#profile,
      this.#herName,
      this.#names,
      config,
      stores(ctx),
      ctx.publisher,
      ctx.clock,
    );
    social.setAuthorizer(ctx.services.get(AuthorizerKey) ?? null);
    // Appraise (the `mind` module) is the one reader of what a conversation meant to her. Only
    // without it, and with her emotions (the `self` module), this pass reads how she feels too.
    social.setConcerns(() => {
      if (ctx.services.get(MindKey)) return null;
      const self = ctx.services.get(SelfStateKey);
      return self ? concerns(social, self) : null;
    });
    await social.load();

    ctx.provide(SocialSignalsKey, social);
    ctx.provide(SocialKey, social);
    ctx.provide(RelationshipEffectsKey, social);

    const commands = new CommandMount(
      "social",
      (registry) => registerCommands(registry, social),
      unregisterCommands,
    );
    commands.attach(ctx);
    // Her tool `set_call_name`: the speaker's own 稱呼, said in chat.
    const off = actuatorsFor(ctx).register(callNameCapability(social));
    this.#running = { social, commands, off };

    // Subscribe before returning so no event published after start is missed.
    const sub = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceUtteranceEvent.type,
      Events.AgentTurnCompleted.type,
      Events.AffectBond.type,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of sub) {
        const now = ctx.clock.now();
        let observed: Observed | null = null;
        if (is(Events.PlatformReady, env)) {
          social.addSelfAccount(env.data.self_account);
        } else if (is(Events.PlatformMessageCreated, env)) {
          const m = env.data;
          const own = m.author.is_bot || social.isSelf(m.author.account);
          if (!own) {
            observed = {
              context: m.id.context,
              account: m.author.account,
              display_name: m.author.display_name,
              text: m.text,
              directed: m.mentions_self || m.reply_to_self || m.id.context.kind === "dm",
              ts: now,
            };
          }
        } else if (is(Events.VoiceUtteranceEvent, env)) {
          const u = env.data;
          const own = u.speaker.is_bot || social.isSelf(u.speaker.account);
          if (!own) {
            observed = {
              context: u.context,
              account: u.speaker.account,
              display_name: u.speaker.display_name,
              text: u.text,
              directed: false,
              ts: now,
            };
          }
        } else if (is(Events.AgentTurnCompleted, env)) {
          social.observeSelf(env.data.context, env.data.text, now);
        } else if (is(Events.AffectBond, env)) {
          // A bond change Reflect proposed through the affect service (small, already capped).
          await applyBond(social, env.data as JsonValue, now).catch((error: unknown) => {
            ctx.log.warn({ err: errorMessage(error) }, "cannot apply a proposed bond change");
          });
        }
        if (observed === null) continue;
        const key = observed.context;
        try {
          if (await social.observe(observed)) spawnAppraisal(ctx, social, key);
        } catch (error) {
          ctx.log.warn(
            { err: errorMessage(error), context: contextKeyString(key) },
            "social appraisal of a line failed",
          );
        }
      }
    });
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(Math.max(config.tick_secs, 1) * 1000, signal)) {
        // The authorizer may be replaced at runtime (e.g. by `auth`).
        social.setAuthorizer(ctx.services.get(AuthorizerKey) ?? null);
        const now = ctx.clock.now();
        for (const key of social.dueAppraisals(now)) spawnAppraisal(ctx, social, key);
        const person = social.dueNotes(now)[0];
        if (person !== undefined) spawnNotes(ctx, social, person);
        try {
          await social.flush();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "cannot write relationship counters");
        }
      }
    });
    ctx.log.info("social module running");
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.commands.detach();
    running.off();
    await running.social.flush();
  }
}

/** Applies an `affect.bond` payload (`AffectBondPayload`) to the relationship. */
export async function applyBond(social: Social, payload: JsonValue, now: number): Promise<void> {
  if (!isJsonObject(payload) || typeof payload.person !== "string") return;
  const num = (v: JsonValue | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const [affinity, trust, familiarity] = [
    num(payload.affinity),
    num(payload.trust),
    num(payload.familiarity),
  ];
  if (affinity === 0 && trust === 0 && familiarity === 0) return;
  const why = typeof payload.why === "string" ? payload.why.slice(0, 80) : "";
  await social.modify(payload.person, `reflect: ${why}`, now, (r) => {
    r.affinity += affinity;
    r.trust += trust;
    r.familiarity += familiarity;
  });
}

function spawnAppraisal(ctx: ModuleContext, social: Social, key: ContextKey): void {
  const router = ctx.services.get(LlmRouterKey);
  if (!router) return;
  ctx.spawn("appraisal", async (signal) => {
    try {
      await social.appraise(router, key, ctx.clock.now(), signal);
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn(
        { err: errorMessage(error), context: contextKeyString(key) },
        "LLM appraisal failed",
      );
    }
  });
}

function spawnNotes(ctx: ModuleContext, social: Social, person: PersonId): void {
  const router = ctx.services.get(LlmRouterKey);
  if (!router) return;
  ctx.spawn("notes", async (signal) => {
    try {
      await social.refreshNotes(router, person, ctx.clock.now(), signal);
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn({ err: errorMessage(error), person }, "notes refresh failed");
    }
  });
}
