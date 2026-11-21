// Module `exchange` (docs/design/exchange.md): the owner of the `exchange` plugin's tables. It
// puts `[modules.exchange]` in force and provides `ExchangeKey` (`ExchangeService`: the market,
// accounts, orders, portfolios, the boards and the owner's hand). Coins go through
// `ExchangeWalletKey`, which the economy provides; without it nothing that costs anything goes
// through, and nothing is paid out until it is back.
//
// One pass at start and every `TICK_MS`: the rounds due are handled in order, the wallets are paid,
// a member's margin warnings and liquidations go to them by DM (`ReplySink.sendDirect`, a neutral
// card; their page has them too). The market is off until the owner turns `enabled` on.

import { CommandMount, type CommandReply, cardReply, ReplySinkKey } from "@miyoria/commands";
import { heartTables, labelOf, PeopleDirectoryKey } from "@miyoria/heart/person";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { AuditLogKey, PeopleStoreKey, StoreKey } from "@miyoria/store";
import {
  AuthorizerKey,
  BOND_LADDER,
  type Clock,
  type ContextKey,
  EventLogKey,
  ExchangeWalletKey,
  ExchangeWordsKey,
  isOwnerAccount,
  newId,
  type PersonId,
  PicturesKey,
  serviceKey,
  toTimestamp,
} from "@miyoria/types";
import { registerCommands, unregisterCommands } from "./commands.js";
import { ExchangeConfigSchema } from "./config.js";
import { ExchangeService, type Traders } from "./service.js";
import { exchangeTables } from "./store.js";
import { HerDesk } from "./words.js";

export const ExchangeKey = serviceKey<ExchangeService>("Exchange");

/** How often the pass runs. */
export const TICK_MS = 30_000;
const DAY_MS = 86_400_000;
/** The panel's write node: someone holding it sees what the panel shows and never trades. */
const INSIDER_NODE = "admin.panel.write";

export interface ExchangeModuleOptions {
  clock?: Clock;
  tickMs?: number;
  /** The seed of a new market (tests). */
  seed?: string;
}

export class ExchangeModule implements Module {
  static readonly ID = "exchange";
  readonly manifest = defineManifest(ExchangeModule.ID, "Exchange", {
    icon: "chart-candlestick",
    category: "play",
    description:
      "The deep-sea exchange: eight made-up companies priced by a seeded engine, a closed vault, fees burned, leverage with isolated margin, the boards",
    optional: ["economy", "heart", "commands"],
    configSchema: ExchangeConfigSchema,
  });
  readonly #options: ExchangeModuleOptions;
  #mount: CommandMount | null = null;
  #running: { service: ExchangeService; clock: Clock } | null = null;

  constructor(options: ExchangeModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ExchangeConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no exchange");
      return;
    }
    const tables = store.plugin(exchangeTables);
    const heart = store.plugin(heartTables).people;
    const clock = this.#options.clock ?? ctx.clock;
    let names: { at: number; map: Map<string, string> } | null = null;
    const traders: Traders = {
      about: async (account, person) => {
        const people = ctx.services.get(PeopleStoreKey);
        const row = people ? await people.personByAccount(account) : null;
        const since = row ? Date.parse(row.created_at) : clock.now();
        const label = labelOf(heart.get(person));
        const authorizer = ctx.services.get(AuthorizerKey);
        return {
          known_days: Math.max(0, (clock.now() - since) / DAY_MS),
          tier: BOND_LADDER.findIndex((t) => t.label === label),
          insider:
            isOwnerAccount(authorizer, account) ||
            authorizer?.allows(account, INSIDER_NODE) === true,
          self: ctx.services.get(PeopleDirectoryKey)?.isSelf(account) ?? false,
        };
      },
      name: async (person) => {
        if (names === null || clock.now() - names.at > 60_000) {
          const all = (await ctx.services.get(PeopleStoreKey)?.all()) ?? [];
          names = { at: clock.now(), map: new Map(all.map((p) => [p.id, p.display_name])) };
        }
        return names.map.get(person) ?? null;
      },
    };
    const service = new ExchangeService({
      config,
      store: tables,
      wallet: () => ctx.services.get(ExchangeWalletKey) ?? null,
      traders,
      now: () => clock.now(),
      log: ctx.log,
      dm: (person, text) => dm(ctx, person, text),
      audit: (action, target, detail, by) => {
        void ctx.services
          .get(AuditLogKey)
          ?.append({
            id: newId(),
            at: toTimestamp(clock.now()),
            actor: by,
            action,
            target,
            detail: detail as never,
            ok: true,
          })
          .catch(() => undefined);
      },
      ...(this.#options.seed === undefined ? {} : { seed: this.#options.seed }),
    });
    ctx.provide(ExchangeKey, service);
    this.#running = { service, clock };
    const desk = new HerDesk({
      service,
      words: () => ctx.services.get(ExchangeWordsKey) ?? null,
      pictures: () => ctx.services.get(PicturesKey) ?? null,
      post: (channel, reply) => post(ctx, channel, reply),
      tell: (summary, key) => tell(ctx, summary, key),
      log: ctx.log,
      now: () => clock.now(),
    });
    this.#mount = new CommandMount(
      "exchange",
      (registry) =>
        registerCommands(
          registry,
          () => service,
          () => ctx.services.get(PicturesKey) ?? null,
        ),
      unregisterCommands,
    );
    this.#mount.attach(ctx);
    const every = this.#options.tickMs ?? TICK_MS;
    ctx.spawn("pass", async (signal) => {
      const pass = async () => {
        try {
          await service.tick();
          await desk.run();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "exchange: the pass failed");
        }
      };
      await pass();
      for await (const _ of interval(every, signal)) await pass();
    });
  }

  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (running === null) return { facts: [] };
    const m = running.service.market();
    return {
      facts: [
        { label: "狀態", value: !m.enabled ? "關" : m.paused ? "暫停" : m.halted ? "熔斷" : "開" },
        { label: "FISH", value: m.fish },
        { label: "金庫", value: m.vault, unit: m.currency },
        { label: "水位", value: m.level === null ? "—" : m.level.toFixed(2) },
        { label: "本週燒掉", value: m.burned_week, unit: m.currency },
      ],
      ...(m.next_round_at === null ? {} : { next: { label: "下一盤", at: m.next_round_at } }),
    };
  }

  async stop(): Promise<void> {
    this.#running = null;
    this.#mount?.detach();
    this.#mount = null;
  }
}

/** A neutral card by DM to the person's first account on a platform that can send one. */
async function dm(ctx: ModuleContext, person: PersonId, text: string): Promise<boolean> {
  const sink = ctx.services.get(ReplySinkKey);
  const people = ctx.services.get(PeopleStoreKey);
  if (!sink || !people) return false;
  const all = await people.all();
  const account = all
    .find((p) => p.id === person)
    ?.accounts.find((a) => a.account.platform === sink.platform)?.account;
  if (!account) return false;
  try {
    await sink.sendDirect(
      account,
      cardReply([{ type: "text", text }], { accent: "neutral", title: "深海交易所" }),
    );
    return true;
  } catch (error) {
    ctx.log.info({ err: errorMessage(error) }, "exchange: cannot send a DM");
    return false;
  }
}

/** Posts a card in a Discord channel; its message id, or `null` when it could not. */
async function post(
  ctx: ModuleContext,
  channel: string,
  reply: CommandReply,
): Promise<string | null> {
  const sink = ctx.services.get(ReplySinkKey);
  const context: ContextKey = { platform: "discord", scope: null, channel, kind: "channel" };
  if (!sink?.sendCard || sink.platform !== context.platform) return null;
  try {
    return (await sink.sendCard(context, reply)).id;
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error), channel }, "exchange: cannot post");
    return null;
  }
}

/** Something she hears about the market (totals only), as a quiet note. */
function tell(ctx: ModuleContext, summary: string, key: string): void {
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "exchange",
      silent: true,
      salience: "ambient",
      attention_key: key,
      revision: 1,
      summary,
      addressed_to_her: false,
      from: null,
      context: null,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer: "exchange",
          owner: ExchangeModule.ID,
          untrusted: false,
          max_entries: 3,
        },
      ],
    },
  );
}
