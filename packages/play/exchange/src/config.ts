// `[modules.exchange]` (docs/design/exchange.md, owner 2026-11-21): v1 is paper trading of real
// Taiwan and US stocks (quoted by Yahoo Finance) and five local stocks tied to her, with fish
// coins. The market is off until the owner turns `open` on. Tickers are an open universe: the
// first lookup validates one through the provider and stores it.
//
// The old local market (the closed vault, rounds, news) stays in the package behind
// `local_enabled = false` with nothing reaching it; its numbers are at the end, without a place on
// the panel.
//
// ```toml
// [modules.exchange]
// open = true
// colors = "tw"
// starters_tw = ["2330", "0050"]
// ```

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
const date = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** A local stock's anchor price in coins. */
const localAnchor = (d: number) => z.number().min(10).max(1000).default(d);

/**
 * How one local stock's count becomes its signal (`real/signals.ts`): a full signal (the whole
 * ±3% gap) needs the day at least `floor` above or below the usual count, and the signal is held
 * within `up` and `down` (shares of the full one).
 */
const localMapping = (floor: number) =>
  z
    .object({
      floor: z.number().positive().max(1000).default(floor),
      up: ratio(1),
      down: ratio(1),
    })
    .prefault({});

export const ExchangeConfigSchema = z
  .object({
    /** The master switch. Off: nothing is traded, open orders go back, holdings stay. */
    open: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "交易所開關",
          help: "關著時不成交也不能下單;關掉時掛著的委託全部退回。持股留著",
          group: "market",
        }),
      ),
    /** Her local time zone as a UTC offset: what a day is (the daily caps and report). */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60),

    // ---- what is traded ----
    // The universe is open (owner 2026-11-21): any Taiwan listed or TPEx, or US-listed, common stock
    // or ETF a member looks up, validated through the provider the first time.
    /** Which provider each market's tickers use: `yahoo`, or the id of a `providers` entry. */
    provider_tw: z.string().min(1).default("yahoo"),
    provider_us: z.string().min(1).default("yahoo"),
    /** Exchanges and instrument types allowed, as the provider reports them. */
    allowed_exchanges_tw: z.array(z.string()).default(["TAI", "TWO"]),
    allowed_exchanges_us: z
      .array(z.string())
      .default(["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS"]),
    allowed_types: z.array(z.string()).default(["EQUITY", "ETF"]),
    /** The owner's block list (sell only), and an optional allow-only list (empty: open). */
    blocked: z.array(z.string()).default([]),
    allow_only: z.array(z.string()).default([]),
    /** A person may look up this many new tickers an hour; a ticker that did not validate is not asked again for this long. */
    lookups_per_hour: z.number().int().min(1).max(500).default(20),
    negative_cache_minutes: z.number().int().min(1).max(10_080).default(60),
    /** A ticker viewed this recently is kept fresh (besides held or ordered ones). */
    view_minutes: z.number().int().min(1).max(120).default(5),
    /** Symbols per request at most. */
    batch_size: z.number().int().min(1).max(50).default(20),
    /** Trading days without a valid quote before a held ticker is suspended (the owner settles it). */
    suspend_after_days: z.number().int().min(1).max(30).default(3),
    /**
     * Fixed exchange rates (owner 2026-11-21): never fetched, never floating. NT$ per coin is the
     * economy's one rate (`[modules.economy] twd_per_coin`, default 1: a coin is about NT$1, a bowl
     * of rice is 10); this is NT$ per US$. A coin price is TWD ÷ twd_per_coin, or USD × twd_per_usd ÷
     * twd_per_coin. Holdings are shares, so changing a rate re-values everyone's holdings at once.
     */
    twd_per_usd: z
      .number()
      .positive()
      .default(30)
      .meta(
        setting({
          kind: "number",
          label: "一美元等於幾台幣",
          help: "固定匯率,不會自動更新",
          danger: "改匯率會讓所有美股持股的市值一起變動(股數不變)。確定要改嗎?",
          group: "market",
        }),
      ),
    /**
     * Yahoo Finance (the owner's choice for both markets): an unofficial public endpoint, data for
     * personal use per Yahoo's terms, which can change or break without notice. Switch a market to
     * another source by giving its instruments another `provider` from `providers`.
     */
    yahoo: z
      .object({
        host: z
          .string()
          .regex(/^[a-z0-9.-]+$/i)
          .default("query1.finance.yahoo.com"),
        daily_budget: z.number().int().min(10).max(100_000).default(3000),
        timeout_ms: z.number().int().min(1000).max(30_000).default(8000),
        max_backoff_seconds: z.number().int().min(15).max(86_400).default(1800),
      })
      .prefault({}),
    /** Other quote providers: each a JSON endpoint (the generic one). */
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
    /** What each market's provider gives: quotes during the session, or only each day's close. */
    quotes_us: z.enum(["intraday", "close"]).default("intraday"),
    quotes_tw: z.enum(["intraday", "close"]).default("intraday"),
    /** Closed dates in the market's own zone (holidays). */
    holidays_us: z.array(date()).default([]),
    holidays_tw: z.array(date()).default([]),
    /** How often quotes are asked for. */
    quote_poll_seconds: z.number().int().min(10).max(3600).default(60),
    /** A quote older than this is not traded at (an intraday market). */
    quote_max_age_seconds: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .default(300)
      .meta(
        setting({ kind: "duration", unit: "s", label: "報價最久多舊還能成交", group: "market" }),
      ),
    /** A closing price stamped up to this long after the close still counts as that day's close. */
    close_grace_minutes: z.number().int().min(0).max(720).default(180),

    // ---- accounts and orders ----
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
    /** The daily buy cap (coins bought a day, fee included). */
    buy_per_day: coins(DEFAULT_RULES.buy_per_day).meta(
      setting({ kind: "coins", label: "一天最多買多少", group: "account" }),
    ),
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
    /** A holding can be sold this long after it was bought (the one anti-churn rule). */
    min_hold_minutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(10)
      .meta(
        setting({ kind: "duration", unit: "min", label: "買進後多久才能賣", group: "account" }),
      ),
    /** The one fee on every trade, burned (rounded up, at least `fee_min`). */
    fee: ratio(0.01, 0.2).meta(
      setting({
        kind: "number",
        step: 0.001,
        label: "手續費(比例)",
        help: "每一筆買賣都收,無條件進位,最少 1 魚幣,燒掉",
        group: "account",
      }),
    ),
    fee_min: z.number().int().min(0).default(1),

    // ---- the holding cap, by cost (one cap for everything held) ----
    limit_total: coins(DEFAULT_RULES.limit_total).meta(
      setting({
        kind: "coins",
        label: "持有上限",
        help: "照成本算;槓桿照全部部位算;隨羈絆和認識的時間放寬",
        group: "limits",
      }),
    ),
    /** Each tier above the account's tier widens the cap by this share. */
    limit_bond_step: ratio(DEFAULT_RULES.limit_bond_step),
    /** Each `limit_age_days` she has known them widens it by this share. */
    limit_age_step: ratio(DEFAULT_RULES.limit_age_step),
    limit_age_days: z.number().int().min(1).default(DEFAULT_RULES.limit_age_days),
    /** It widens to at most this many times. */
    limit_max_mult: z.number().min(1).max(10).default(DEFAULT_RULES.limit_max_mult),

    // ---- the house ----
    /** Net coins the house may pay out per local day; reached: no new buys today, sales paid in full. */
    payout_cap_daily: coins(1500).meta(
      setting({
        kind: "coins",
        label: "每天最多淨發出",
        help: "到了之後當天停止買進;賣出照常全額付",
        group: "market",
      }),
    ),

    // ---- leverage: 1x or 2x, cross margin ----
    leverage: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "槓桿開關",
          help: "2 倍可能賠超過保證金,最壞賠光錢包和其他持股;關掉時不能開新的槓桿部位",
          group: "leverage",
        }),
      ),
    leverage_line: ratio(DEFAULT_PARAMS.leverage.line, 0.9),
    leverage_warn_half: ratio(DEFAULT_PARAMS.leverage.warn_half, 0.95),
    leverage_warn_near: ratio(DEFAULT_PARAMS.leverage.warn_near, 0.95),
    /** Burned per day from a leveraged position, as a share of what is borrowed (0: none). */
    leverage_carry_daily: ratio(0, 0.05),
    /** 2x only on a ticker at least this many coins a share, with a previous close. */
    leverage_min_coin_price: z.number().min(0).default(50),
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
    /** A bankrupt member waits this long before trading again. */
    bankrupt_cooling_days: z
      .number()
      .int()
      .min(0)
      .max(90)
      .default(7)
      .meta(setting({ kind: "number", label: "破產後幾天不能交易", group: "leverage" })),

    /** The five local stocks tied to her (新手推薦 · 這裡獨家), priced by the simulator in coins, 1x only. */
    local_stocks: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "新手推薦的獨家股票",
          help: "她的五家公司:價格由程式模擬,跟她的生活有關,不開放槓桿",
          group: "market",
        }),
      ),

    /**
     * Each local stock's anchor in coins: its first price and the level its walk returns to (owner
     * 2026-11-21: cheap, about 100 a share). Soft bounds keep it within 0.5×–2× of the anchor.
     */
    local_anchors: z
      .object({
        RICE: localAnchor(100),
        WHLE: localAnchor(108),
        NAPS: localAnchor(88),
        CUBE: localAnchor(116),
        DPSK: localAnchor(94),
      })
      .default({ RICE: 100, WHLE: 108, NAPS: 88, CUBE: 116, DPSK: 94 }),

    /**
     * How her real things move the local stocks (`real/signals.ts`, docs/design/exchange.md §9).
     * Each day's count is compared with the same company's previous `baseline_days` completed
     * days: their median, and their spread (the median distance from it, ×1.4826). The day's
     * distance from the median, over the larger of `spread` spreads, `relative` × the median and
     * the company's `floor`, is its signal, held within [-1, 1] and the company's `up` / `down`:
     * a full signal is the whole ±3% gap at the next day's 12:00 tick. Fewer than
     * `min_history_days` days on record (a new instance), or no record of the day: no signal.
     *
     * Directions are fixed in code: more feedings, songs, silent hours, goals (fewer deaths) push
     * RICE, WHLE, NAPS, CUBE up; more model errors and slow calls push DPSK down, and never up (a
     * quiet day gives it nothing), with its fall held below one round trip's fees (`fee` × 2), so
     * nobody gains by causing errors and buying the dip. The floors are the anti-gaming numbers:
     * `test/signals.test.ts` shows that feeding her as much as the caps allow, buying RICE before
     * the day ends and selling after the next open loses money once the feedings and fees count.
     */
    local_signals: z
      .object({
        baseline_days: z.number().int().min(3).max(60).default(14),
        min_history_days: z.number().int().min(1).max(60).default(7),
        spread: z.number().min(0).max(20).default(3),
        relative: z.number().min(0).max(10).default(0.5),
        /** DPSK: a call that answered but took longer than this counts as slow. */
        slow_call_seconds: z.number().min(1).max(600).default(30),
        /** Feedings (fixed foods by bowl, and food or drink gifts she took). */
        RICE: localMapping(10),
        /** Songs she sang to the end. */
        WHLE: localMapping(3),
        /** Hours of the Taipei day with no line of hers delivered and no failed model call. */
        NAPS: localMapping(3),
        /** Game goals reached less deaths. */
        CUBE: localMapping(3),
        /** Failed model calls plus slow ones; `up` is ignored (always 0). */
        DPSK: localMapping(10),
      })
      .prefault({}),

    /** Which colour means up on every chart (one for the whole product), stated in a legend. */
    colors: z
      .enum(["tw", "us"])
      .default("tw")
      .meta(
        setting({
          kind: "select",
          label: "漲跌顏色",
          labels: { tw: "紅漲綠跌", us: "綠漲紅跌" },
          help: "tw:紅漲綠跌(台股習慣,預設);us:綠漲紅跌(美股習慣)。每張圖都會標示",
          group: "market",
        }),
      ),
    /**
     * The starter lists (熱門台股 / 熱門美股): codes as people type them. Each is validated through
     * the provider like any ticker, a few per pass; one that fails is dropped silently.
     */
    starters_tw: z
      .array(z.string().min(1).max(16))
      .max(50)
      .default([
        "2330",
        "2317",
        "2454",
        "2308",
        "2382",
        "2412",
        "2881",
        "2882",
        "2891",
        "2303",
        "1301",
        "2002",
        "0050",
        "0056",
        "00878",
        "006208",
      ]),
    starters_us: z
      .array(z.string().min(1).max(16))
      .max(50)
      .default([
        "AAPL",
        "MSFT",
        "NVDA",
        "AMZN",
        "GOOGL",
        "META",
        "TSLA",
        "BRK-B",
        "JPM",
        "V",
        "SPY",
        "QQQ",
        "VOO",
        "VTI",
        "DIA",
      ]),
    /** A member's watch list holds at most this many tickers. */
    watch_max: z.number().int().min(1).max(50).default(20),
    /**
     * Watched tickers count as in use for polling only while their market is open and the member
     * used the exchange within this many days (a forgotten watch list spends nothing).
     */
    watch_active_days: z.number().int().min(1).max(30).default(3),
    /** Ticker suggestions while typing: per person per minute (answers are cached). */
    suggest_per_minute: z.number().int().min(1).max(600).default(60),
    /** How long the market's Discord controls work before they ask to be reopened. */
    component_minutes: z.number().int().min(1).max(60).default(15),

    // ---- the old local market (closed vault, rounds): off, no panel ----
    local_enabled: z.boolean().default(false),
    round_grace_minutes: z.number().int().min(1).max(59).default(10),
    limit_company: coins(DEFAULT_RULES.limit_company),
    limit_days_max: z.number().int().min(1).max(20).default(DEFAULT_RULES.limit_days_max),
    concentration: ratio(DEFAULT_RULES.concentration),
    concentration_floor: coins(DEFAULT_RULES.concentration_floor),
    fee_buy: ratio(DEFAULT_PARAMS.fee_buy, 0.2),
    fee_sell: ratio(DEFAULT_PARAMS.fee_sell, 0.2),
    tax_sell: ratio(DEFAULT_PARAMS.tax_sell, 0.2),
    daily_limit: ratio(DEFAULT_PARAMS.daily_limit, 0.5),
    round_limit: ratio(DEFAULT_PARAMS.round_limit, 0.5),
    breaker: ratio(DEFAULT_PARAMS.breaker, 0.5),
    vault_burn_level: z.number().min(1).max(10).default(DEFAULT_PARAMS.vault_burn_level),
    local_leverage: z.boolean().default(DEFAULT_PARAMS.leverage.enabled),
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

/** The local engine's numbers from the config (the local market is off in v1). */
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
      enabled: c.local_leverage,
      max: 2,
      line: c.leverage_line,
      warn_half: Math.max(c.leverage_warn_half, c.leverage_warn_near),
      warn_near: Math.max(c.leverage_warn_near, c.leverage_line),
      carry_daily: 0.002,
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
    fee: c.fee,
    fee_min: c.fee_min,
    cap_daily: c.payout_cap_daily,
    leverage_max: c.leverage ? 2 : 1,
    line: c.leverage_line,
    warn_half: Math.max(c.leverage_warn_half, c.leverage_warn_near),
    warn_near: Math.max(c.leverage_warn_near, c.leverage_line),
    carry_daily: c.leverage_carry_daily,
    min_hold_ms: c.min_hold_minutes * 60_000,
    cooling_ms: c.bankrupt_cooling_days * 86_400_000,
  };
}

/** The sessions of each market, holidays from the config. */
export function sessionsOf(c: ExchangeConfig): Record<MarketKind, Session> {
  return {
    us: { ...DEFAULT_SESSIONS.us, holidays: c.holidays_us },
    tw: { ...DEFAULT_SESSIONS.tw, holidays: c.holidays_tw },
    crypto: DEFAULT_SESSIONS.crypto,
    local: DEFAULT_SESSIONS.local,
  };
}
