// `[modules.exchange]` (docs/design/exchange.md §10, owner 2026-11-21): every rule and every
// number of the deep-sea exchange. The market is off until the owner turns `enabled` on; the
// defaults below are the ones the offline simulation passed with (§9). The price process's own
// numbers are here too, without a place on the panel: changing them means running the
// simulation again (`exchange/test/sim-report.ts`).

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { BOND_LADDER } from "@miyoria/types";
import { z } from "zod";
import { DEFAULT_RULES, type Rules } from "./engine/guards.js";
import { DEFAULT_PARAMS, type EngineParams } from "./engine/params.js";
import type { HouseParams } from "./real/house.js";
import { DEFAULT_SESSIONS, type MarketKind, type Session } from "./real/instruments.js";

/** The bond tiers a requirement may name, lowest first. */
const TIERS = BOND_LADDER.map((t) => t.label) as [string, ...string[]];

const ratio = (d: number, max = 1) => z.number().min(0).max(max).default(d);
const coins = (d: number) => z.number().int().positive().default(d);
const tier = (d: string) => z.enum(TIERS).default(d);
/** A Discord channel id (empty: none). */
const channel = () =>
  z
    .string()
    .regex(/^(\d{5,30})?$/, "a channel id")
    .default("");

/**
 * ```toml
 * [modules.exchange]
 * open = true
 * channel = "123456789012345678"
 * ```
 */
export const ExchangeConfigSchema = z
  .object({
    /** The master switch. Off: no round is held, nothing can be placed, open orders go back. */
    open: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "交易所開關",
          help: "關著時不撮合也不能下單;關掉時掛著的委託全部退回。持股留著",
          group: "market",
        }),
      ),
    /** Her local time zone as a UTC offset: what a day and a trading hour are. */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60),
    /** Where her opening and closing lines and the day's summary picture go; empty: nowhere. */
    channel: channel().meta(
      setting({
        kind: "channel",
        room: "text",
        ref: "id",
        scope: "space",
        label: "交易所頻道",
        help: "開盤、收盤的講評和每天的行情圖貼在這裡;沒設就不貼",
        group: "market",
      }),
    ),
    /** Her opening and closing lines and the weekly rating. */
    commentary: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "她的講評",
          help: "開盤、收盤一句和每週五的評等",
          group: "market",
        }),
      ),
    /** The model chain her lines and the news are worded with (`[llm.purposes]`). */
    purpose: z.string().default("exchange"),
    /** A round due longer ago than this when Core gets to it is skipped, its market orders given back. */
    round_grace_minutes: z.number().int().min(1).max(59).default(10),

    // ---- accounts and orders (owner 2026-11-21) ----
    account_min_days: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RULES.min_days)
      .meta(setting({ kind: "number", label: "開戶:認識滿幾天", group: "account" })),
    account_min_tier: tier("認識").meta(
      setting({ kind: "select", label: "開戶:羈絆至少", group: "account" }),
    ),
    order_min: coins(DEFAULT_RULES.order_min).meta(
      setting({ kind: "coins", label: "一筆最少", group: "account" }),
    ),
    order_max: coins(DEFAULT_RULES.order_max).meta(
      setting({ kind: "coins", label: "一筆最多", group: "account" }),
    ),
    orders_per_day: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_RULES.orders_per_day)
      .meta(setting({ kind: "number", label: "一天最多幾筆委託", group: "account" })),
    buy_per_day: coins(DEFAULT_RULES.buy_per_day).meta(
      setting({ kind: "coins", label: "一天最多買多少", group: "account" }),
    ),
    limit_days_max: z.number().int().min(1).max(20).default(DEFAULT_RULES.limit_days_max),
    /** Coins received by transfer this recently cannot be put in. */
    transfer_lock_hours: z
      .number()
      .int()
      .min(0)
      .max(168)
      .default(DEFAULT_RULES.transfer_lock_hours)
      .meta(
        setting({ kind: "duration", unit: "h", label: "轉來的錢多久後才能投入", group: "account" }),
      ),

    // ---- holding limits, by cost ----
    limit_company: coins(DEFAULT_RULES.limit_company).meta(
      setting({
        kind: "coins",
        label: "每家公司持有上限",
        help: "照成本算;槓桿照全部部位算",
        group: "limits",
      }),
    ),
    limit_total: coins(DEFAULT_RULES.limit_total).meta(
      setting({ kind: "coins", label: "全部合計上限", group: "limits" }),
    ),
    /** Each tier above the account's tier widens the limits by this share. */
    limit_bond_step: ratio(DEFAULT_RULES.limit_bond_step),
    /** Each `limit_age_days` she has known them widens them by this share. */
    limit_age_step: ratio(DEFAULT_RULES.limit_age_step),
    limit_age_days: z.number().int().min(1).default(DEFAULT_RULES.limit_age_days),
    /** The limits widen to at most this many times. */
    limit_max_mult: z.number().min(1).max(10).default(DEFAULT_RULES.limit_max_mult),
    /** One person holds at most this share of a company's value held (counted on at least the floor). */
    concentration: ratio(DEFAULT_RULES.concentration),
    concentration_floor: coins(DEFAULT_RULES.concentration_floor),

    // ---- fees (owner 2026-11-21: all burned) ----
    fee_buy: ratio(DEFAULT_PARAMS.fee_buy, 0.2),
    fee_sell: ratio(DEFAULT_PARAMS.fee_sell, 0.2),
    tax_sell: ratio(DEFAULT_PARAMS.tax_sell, 0.2),
    fee_min: z.number().int().min(0).default(DEFAULT_PARAMS.fee_min),

    // ---- limits on prices ----
    daily_limit: ratio(DEFAULT_PARAMS.daily_limit, 0.5),
    round_limit: ratio(DEFAULT_PARAMS.round_limit, 0.5),
    breaker: ratio(DEFAULT_PARAMS.breaker, 0.5),
    /** Each Sunday the vault burns what it holds above this level. */
    vault_burn_level: z.number().min(1).max(10).default(DEFAULT_PARAMS.vault_burn_level),

    // ---- leverage (owner 2026-11-21: allowed, up to 2x) ----
    leverage: z
      .boolean()
      .default(DEFAULT_PARAMS.leverage.enabled)
      .meta(
        setting({
          kind: "switch",
          label: "槓桿開關",
          help: "關掉時不能開新的槓桿部位;已經開的照規則跑到賣掉為止",
          group: "leverage",
        }),
      ),
    leverage_max: z.number().int().min(1).max(2).default(DEFAULT_PARAMS.leverage.max),
    leverage_line: ratio(DEFAULT_PARAMS.leverage.line, 0.9),
    leverage_warn_half: ratio(DEFAULT_PARAMS.leverage.warn_half, 0.95),
    leverage_warn_near: ratio(DEFAULT_PARAMS.leverage.warn_near, 0.95),
    leverage_carry_daily: ratio(DEFAULT_PARAMS.leverage.carry_daily, 0.05),
    leverage_min_days: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RULES.leverage_min_days)
      .meta(setting({ kind: "number", label: "槓桿:認識滿幾天", group: "leverage" })),
    leverage_min_tier: tier("朋友").meta(
      setting({ kind: "select", label: "槓桿:羈絆至少", group: "leverage" }),
    ),
    leverage_margin_cap: coins(DEFAULT_RULES.leverage_margin_cap).meta(
      setting({ kind: "coins", label: "每人保證金合計上限", group: "leverage" }),
    ),

    // ---- real instruments (owner 2026-11-21): the house is the counterparty ----
    /** The real instruments people may trade; none until the owner adds them (and a provider). */
    instruments: z
      .array(
        z.object({
          code: z.string().regex(/^[A-Z0-9]{2,10}$/),
          name: z.string().min(1).max(40),
          market: z.enum(["us", "tw", "crypto"]),
          provider: z.string().min(1),
          symbol: z.string().min(1).max(40),
          vol: z.enum(["low", "mid", "high", "crypto"]).default("mid"),
          coins_per_unit: z.number().positive().default(1),
          enabled: z.boolean().default(true),
        }),
      )
      .default([]),
    /** Quote providers: each a JSON endpoint (no vendor is wired until the owner names one). */
    providers: z
      .array(
        z.object({
          id: z.string().min(1),
          url: z.string().regex(/^https:\/\/[^/{}?#]+[/?]/, "https:// with a fixed host"),
          separator: z.string().default(","),
          price_path: z.string().min(1),
          time_path: z.string().nullable().default(null),
          time_unit: z.enum(["s", "ms", "iso"]).default("s"),
          prev_close_path: z.string().nullable().default(null),
          rate_per_minute: z.number().int().positive().default(30),
          cache_seconds: z.number().int().min(0).default(30),
          timeout_ms: z.number().int().min(500).max(30_000).default(5_000),
          max_backoff_seconds: z.number().int().min(1).default(600),
          api_key_env: z.string().nullable().default(null),
          api_key_header: z.string().nullable().default(null),
          api_key_param: z.string().nullable().default(null),
        }),
      )
      .default([]),
    /** Closed dates (`YYYY-MM-DD`, the market's own zone) of the US and Taiwan markets. */
    holidays_us: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
    holidays_tw: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
    /** How often real quotes are asked for. */
    quote_poll_seconds: z.number().int().min(10).max(600).default(60),
    /** A quote older than this is not traded at. */
    quote_max_age_seconds: z.number().int().min(10).max(3600).default(300),
    /** A real holding can be sold this long after it was bought (in place of T+1). */
    real_min_hold_minutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(60)
      .meta(
        setting({
          kind: "duration",
          unit: "min",
          label: "真實行情:買進後多久才能賣",
          group: "real",
        }),
      ),
    real_order_ttl_minutes: z.number().int().min(1).max(1440).default(30),
    /** Net coins the house may pay out per local day, in all and per instrument. */
    payout_cap_daily: coins(1500).meta(
      setting({
        kind: "coins",
        label: "每天最多淨發出",
        help: "賣出的錢超過時,超過的部分隔天早上第一個付,當天停止買進",
        group: "real",
      }),
    ),
    payout_cap_instrument: coins(500).meta(
      setting({ kind: "coins", label: "每個標的每天最多淨發出", group: "real" }),
    ),
    /** Real buys stop when the net minted over `halt_window_days` passes `halt_net`. */
    halt_window_days: z.number().int().min(1).max(60).default(7),
    halt_net: coins(4000).meta(
      setting({
        kind: "coins",
        label: "自動停止買進的門檻",
        help: "最近幾天淨發出超過這麼多就自動停止買進(賣出照常)",
        group: "real",
      }),
    ),
    real_leverage: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "真實行情的槓桿",
          help: "可能賠超過保證金;關掉時不能開新的槓桿部位",
          group: "real",
        }),
      ),
    leverage_max_low: z.number().min(1).max(2).default(2),
    leverage_max_mid: z.number().min(1).max(2).default(2),
    leverage_max_high: z.number().min(1).max(2).default(1.5),
    leverage_max_crypto: z.number().min(1).max(2).default(1.5),
    /** A bankrupt member waits this long before trading again. */
    bankrupt_cooling_days: z
      .number()
      .int()
      .min(0)
      .max(90)
      .default(7)
      .meta(setting({ kind: "number", label: "破產後幾天不能交易", group: "real" })),

    // ---- the price process (no panel; run the simulation before changing) ----
    market_sigma: z.number().min(0).max(0.05).default(DEFAULT_PARAMS.market_sigma),
    sector_sigma: z.number().min(0).max(0.05).default(DEFAULT_PARAMS.sector_sigma),
    reversion: ratio(DEFAULT_PARAMS.reversion),
    fundamental_sigma: z.number().min(0).max(0.1).default(DEFAULT_PARAMS.fundamental_sigma),
    level_pull: z.number().min(0).max(0.05).default(DEFAULT_PARAMS.level_pull),
    level_floor: z.number().int().min(0).default(DEFAULT_PARAMS.level_floor),
    impact: z.number().min(0).max(0.2).default(DEFAULT_PARAMS.impact),
    impact_decay: ratio(DEFAULT_PARAMS.impact_decay),
    mood_drift: z.number().min(0).max(0.01).default(DEFAULT_PARAMS.mood_drift),
    mood_switch: ratio(DEFAULT_PARAMS.mood_switch),
    event_rate: ratio(DEFAULT_PARAMS.event_rate),
    event_min: ratio(DEFAULT_PARAMS.event_min, 0.2),
    event_max: ratio(DEFAULT_PARAMS.event_max, 0.2),
    earnings_sigma: ratio(DEFAULT_PARAMS.earnings_sigma, 0.2),
  })
  .meta(
    settingGroups([
      { id: "market", label: "市場" },
      { id: "account", label: "開戶和委託" },
      { id: "limits", label: "持有上限" },
      { id: "leverage", label: "槓桿" },
      { id: "real", label: "真實行情" },
    ]),
  );

export type ExchangeConfig = z.output<typeof ExchangeConfigSchema>;

/** The defaults, optionally overridden. */
export function exchangeConfig(overrides: Partial<ExchangeConfig> = {}): ExchangeConfig {
  return { ...ExchangeConfigSchema.parse({}), ...overrides };
}

/** A tier's place on the ladder (0: 認識). */
export function tierIndex(label: string): number {
  return BOND_LADDER.findIndex((t) => t.label === label);
}

/** The engine's numbers from the config. */
export function engineParams(c: ExchangeConfig): EngineParams {
  return {
    ...DEFAULT_PARAMS,
    daily_limit: c.daily_limit,
    round_limit: c.round_limit,
    breaker: c.breaker,
    fee_buy: c.fee_buy,
    fee_sell: c.fee_sell,
    tax_sell: c.tax_sell,
    fee_min: c.fee_min,
    market_sigma: c.market_sigma,
    sector_sigma: c.sector_sigma,
    reversion: c.reversion,
    fundamental_sigma: c.fundamental_sigma,
    level_pull: c.level_pull,
    level_floor: c.level_floor,
    impact: c.impact,
    impact_decay: c.impact_decay,
    mood_drift: c.mood_drift,
    mood_switch: c.mood_switch,
    event_rate: c.event_rate,
    event_min: c.event_min,
    event_max: Math.max(c.event_min, c.event_max),
    earnings_sigma: c.earnings_sigma,
    vault_burn_level: c.vault_burn_level,
    leverage: {
      enabled: c.leverage,
      max: c.leverage_max,
      line: c.leverage_line,
      warn_half: Math.max(c.leverage_warn_half, c.leverage_warn_near),
      warn_near: Math.max(c.leverage_warn_near, c.leverage_line),
      carry_daily: c.leverage_carry_daily,
    },
  };
}

/** The guards' rules from the config; `paused` is the owner's pause, kept by the module. */
export function rulesOf(c: ExchangeConfig, paused: boolean): Rules {
  return {
    enabled: c.open,
    paused,
    min_days: c.account_min_days,
    min_tier: Math.max(0, tierIndex(c.account_min_tier)),
    order_min: c.order_min,
    order_max: Math.max(c.order_min, c.order_max),
    orders_per_day: c.orders_per_day,
    buy_per_day: c.buy_per_day,
    limit_company: c.limit_company,
    limit_total: c.limit_total,
    limit_bond_step: c.limit_bond_step,
    limit_age_step: c.limit_age_step,
    limit_age_days: c.limit_age_days,
    limit_max_mult: c.limit_max_mult,
    concentration: c.concentration,
    concentration_floor: c.concentration_floor,
    transfer_lock_hours: c.transfer_lock_hours,
    limit_days_max: c.limit_days_max,
    leverage_min_days: c.leverage_min_days,
    leverage_min_tier: Math.max(0, tierIndex(c.leverage_min_tier)),
    leverage_margin_cap: c.leverage_margin_cap,
  };
}

/** The house's numbers from the config. */
export function houseParams(c: ExchangeConfig): HouseParams {
  return {
    fee_buy: c.fee_buy,
    fee_sell: c.fee_sell,
    tax_sell: c.tax_sell,
    fee_min: c.fee_min,
    cap_daily: c.payout_cap_daily,
    cap_instrument: c.payout_cap_instrument,
    halt_window_days: c.halt_window_days,
    halt_net: c.halt_net,
    leverage_max: c.real_leverage
      ? {
          low: c.leverage_max_low,
          mid: c.leverage_max_mid,
          high: c.leverage_max_high,
          crypto: c.leverage_max_crypto,
        }
      : { low: 1, mid: 1, high: 1, crypto: 1 },
    line: c.leverage_line,
    warn_half: Math.max(c.leverage_warn_half, c.leverage_warn_near),
    warn_near: Math.max(c.leverage_warn_near, c.leverage_line),
    carry_daily: c.leverage_carry_daily,
    min_hold_ms: c.real_min_hold_minutes * 60_000,
    order_ttl_ms: c.real_order_ttl_minutes * 60_000,
    cooling_ms: c.bankrupt_cooling_days * 86_400_000,
  };
}

/** The sessions of each market, holidays from the config. */
export function sessionsOf(c: ExchangeConfig): Record<MarketKind, Session> {
  return {
    us: { ...DEFAULT_SESSIONS.us, holidays: c.holidays_us },
    tw: { ...DEFAULT_SESSIONS.tw, holidays: c.holidays_tw },
    crypto: DEFAULT_SESSIONS.crypto,
  };
}
