// The deep-sea exchange (docs/design/exchange.md): the market as a member sees it (the eight
// companies, the index, the vault and the level, the news, the rules), a company's page, their
// account, a quote before an order, their orders and portfolio (only ever their own), the boards
// (people who hide are left out), and the owner's side: the state, the pause, a sale with an
// audit line. Prices are in cents (10000 = 100.00) and holdings in thousandths of a share, as the
// exchange keeps them. Without the `exchange` module these are a `503` that names it.

import { z } from "zod";
import { IdempotencyHeaders, route } from "./route.js";

/** The node of the owner's hand on the exchange (the same as on someone's coins). */
const NODE_EXCHANGE = "admin.economy.adjust";

const Limit = z.enum(["up", "down"]).nullable();
const Direction = z.enum(["up", "down"]);
const Size = z.enum(["small", "medium", "large"]);

export const ExchangeCompanySchema = z
  .object({
    code: z.string(),
    name: z.string(),
    sector: z.string(),
    blurb: z.string(),
    price: z.number().int(),
    ref: z.number().int(),
    change: z.number(),
    limit: Limit,
    spark: z.array(z.number().int()),
  })
  .meta({ id: "ApiExchangeCompany" });
export type ExchangeCompany = z.output<typeof ExchangeCompanySchema>;

export const ExchangeNewsSchema = z
  .object({
    id: z.string(),
    company: z.string().nullable(),
    kind: z.enum(["event", "earnings"]),
    direction: Direction,
    size: Size,
    headline: z.string(),
    body: z.string(),
    /** `her`: she worded it; `plain`: the program's words. */
    by: z.enum(["her", "plain"]),
    round: z.number().int(),
    at: z.string(),
  })
  .meta({ id: "ApiExchangeNews" });
export type ExchangeNews = z.output<typeof ExchangeNewsSchema>;

export const ExchangeRulesSchema = z
  .object({
    rounds_per_day: z.number().int(),
    first_hour: z.number().int(),
    daily_limit: z.number(),
    round_limit: z.number(),
    breaker: z.number(),
    fee_buy: z.number(),
    fee_sell: z.number(),
    tax_sell: z.number(),
    fee_min: z.number().int(),
    order_min: z.number().int(),
    order_max: z.number().int(),
    orders_per_day: z.number().int(),
    buy_per_day: z.number().int(),
    limit_company: z.number().int(),
    limit_total: z.number().int(),
    concentration: z.number(),
    transfer_lock_hours: z.number().int(),
    account_min_days: z.number().int(),
    account_min_tier: z.string(),
    leverage: z.object({
      enabled: z.boolean(),
      max: z.number().int(),
      line: z.number(),
      warn_half: z.number(),
      warn_near: z.number(),
      carry_daily: z.number(),
      min_days: z.number().int(),
      min_tier: z.string(),
      margin_cap: z.number().int(),
    }),
  })
  .meta({ id: "ApiExchangeRules" });

const RatingItem = z.object({ code: z.string(), rating: z.string(), reason: z.string() });

/** `GET /api/member/exchange`. */
export const ExchangeMarketSchema = z
  .object({
    enabled: z.boolean(),
    paused: z.boolean(),
    halted: z.boolean(),
    currency: z.string(),
    last_round: z
      .object({ round: z.number().int(), at: z.string(), status: z.string() })
      .nullable(),
    next_round_at: z.string().nullable(),
    fish: z.number(),
    fish_ref: z.number(),
    level: z.number().nullable(),
    vault: z.number().int(),
    obligations: z.number(),
    burned_week: z.number().int(),
    companies: z.array(ExchangeCompanySchema),
    news: z.array(ExchangeNewsSchema),
    rules: ExchangeRulesSchema,
    her: z.object({ text: z.string(), kind: z.string(), at: z.string() }).nullable(),
    rating: z
      .object({ day: z.number().int(), items: z.array(RatingItem), at: z.string() })
      .nullable(),
  })
  .meta({ id: "ApiExchangeMarket" });
export type ExchangeMarket = z.output<typeof ExchangeMarketSchema>;

/** `GET /api/member/exchange/company/{code}`. */
export const ExchangeCompanyPageSchema = z
  .object({
    company: ExchangeCompanySchema,
    history: z.array(
      z.object({ round: z.number().int(), at: z.string(), price: z.number().int() }),
    ),
    closes: z.array(z.object({ day: z.number().int(), date: z.string(), price: z.number().int() })),
    news: z.array(ExchangeNewsSchema),
    mine: z
      .object({
        qty: z.number().int(),
        cost: z.number().int(),
        value: z.number(),
        leveraged: z.number().int(),
      })
      .nullable(),
  })
  .meta({ id: "ApiExchangeCompanyPage" });
export type ExchangeCompanyPage = z.output<typeof ExchangeCompanyPageSchema>;

/** `GET /api/member/exchange/account`: who they are here, what they may do, today's counts. */
export const ExchangeAccountSchema = z
  .object({
    currency: z.string(),
    known: z.boolean(),
    blocked: z.boolean(),
    opened: z.boolean(),
    opened_at: z.string().nullable(),
    cannot_open: z.string().nullable(),
    leverage: z.object({ allowed: z.boolean(), why: z.string().nullable(), opted_in: z.boolean() }),
    limits: z.object({ company: z.number().int(), total: z.number().int(), mult: z.number() }),
    today: z.object({
      orders: z.number().int(),
      bought: z.number().int(),
      orders_left: z.number().int(),
      buy_left: z.number().int(),
    }),
    balance: z.number().nullable(),
    investable: z.number().nullable(),
    hide_boards: z.boolean(),
    show_holdings: z.boolean(),
  })
  .meta({ id: "ApiExchangeAccount" });
export type ExchangeAccount = z.output<typeof ExchangeAccountSchema>;

/** An order as a member asks for it; prices in coins with two decimals, shares with three. */
export const ExchangeOrderRequestSchema = z
  .strictObject({
    side: z.enum(["buy", "sell"]),
    company: z.string().regex(/^[A-Z]{4}$/),
    coins: z.number().int().positive().optional(),
    shares: z.number().positive().optional(),
    all: z.boolean().optional(),
    limit: z.number().positive().nullable().optional(),
    days: z.number().int().min(1).max(20).optional(),
    leverage: z.number().int().min(1).max(2).optional(),
    position: z.string().max(40).optional(),
  })
  .meta({ id: "ApiExchangeOrderRequest" });
export type ExchangeOrderRequest = z.input<typeof ExchangeOrderRequestSchema>;

export const ExchangeQuoteSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    code: z.string(),
    price: z.number().int(),
    coins: z.number().int(),
    margin: z.number().int(),
    exposure: z.number().int(),
    fee: z.number().int(),
    qty: z.number().int(),
    leverage: z.number().int(),
    gross: z.number().int(),
    tax: z.number().int(),
    net: z.number().int(),
    max_loss: z.number().int().nullable(),
    line_price: z.number().int().nullable(),
    warn_half_price: z.number().int().nullable(),
    warn_near_price: z.number().int().nullable(),
    sentence: z.string(),
  })
  .meta({ id: "ApiExchangeQuote" });
export type ExchangeQuote = z.output<typeof ExchangeQuoteSchema>;

export const ExchangeOrderSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    side: z.enum(["buy", "sell"]),
    kind: z.enum(["market", "limit"]),
    limit: z.number().int().nullable(),
    coins: z.number().int(),
    qty: z.number().int(),
    leverage: z.number().int(),
    position: z.string().nullable(),
    status: z.string(),
    why: z.string().nullable(),
    at: z.string(),
  })
  .meta({ id: "ApiExchangeOrder" });
export type ExchangeOrder = z.output<typeof ExchangeOrderSchema>;

export const ExchangeLeveragedSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    qty: z.number().int(),
    leverage: z.number().int(),
    exposure: z.number().int(),
    margin: z.number().int(),
    loan: z.number().int(),
    carry: z.number().int(),
    price: z.number().int(),
    value: z.number(),
    equity: z.number(),
    ratio: z.number(),
    line_price: z.number().int(),
    warn_half_price: z.number().int(),
    warn_near_price: z.number().int(),
    opened_day: z.number().int(),
    can_close: z.boolean(),
    at_risk: z.number().int(),
  })
  .meta({ id: "ApiExchangeLeveraged" });
export type ExchangeLeveraged = z.output<typeof ExchangeLeveragedSchema>;

/** `GET /api/member/exchange/portfolio`: only ever the member's own. */
export const ExchangePortfolioSchema = z
  .object({
    account: ExchangeAccountSchema,
    holdings: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        qty: z.number().int(),
        sellable: z.number().int(),
        cost: z.number().int(),
        value: z.number(),
        price: z.number().int(),
      }),
    ),
    leveraged: z.array(ExchangeLeveragedSchema),
    orders: z.array(ExchangeOrderSchema),
    fills: z.array(
      z.object({
        id: z.string(),
        code: z.string(),
        side: z.enum(["buy", "sell"]),
        kind: z.string(),
        qty: z.number().int(),
        price: z.number().int(),
        gross: z.number().int(),
        fee: z.number().int(),
        tax: z.number().int(),
        carry: z.number().int(),
        paid: z.number().int(),
        leverage: z.number().int(),
        at: z.string(),
      }),
    ),
    notices: z.array(
      z.object({ id: z.string(), kind: z.string(), text: z.string(), at: z.string() }),
    ),
    totals: z.object({ cost: z.number().int(), value: z.number(), worth: z.number().nullable() }),
  })
  .meta({ id: "ApiExchangePortfolio" });
export type ExchangePortfolio = z.output<typeof ExchangePortfolioSchema>;

/** `GET /api/member/exchange/boards`. */
export const ExchangeBoardsSchema = z
  .object({
    currency: z.string(),
    rich: z.array(
      z.object({
        rank: z.number().int(),
        name: z.string(),
        worth: z.number().int(),
        holdings: z.array(z.object({ code: z.string(), value: z.number().int() })).nullable(),
        me: z.boolean(),
      }),
    ),
    volume: z.array(
      z.object({
        rank: z.number().int(),
        name: z.string(),
        volume: z.number().int(),
        trades: z.number().int(),
        me: z.boolean(),
      }),
    ),
    me: z
      .object({
        rich: z.number().int().nullable(),
        volume: z.number().int().nullable(),
        hidden: z.boolean(),
      })
      .nullable(),
    week_start: z.string(),
  })
  .meta({ id: "ApiExchangeBoards" });
export type ExchangeBoards = z.output<typeof ExchangeBoardsSchema>;

export const ExchangeLeverageRequestSchema = z
  .strictObject({ accept: z.boolean() })
  .meta({ id: "ApiExchangeLeverageRequest" });
export const ExchangeVisibilityRequestSchema = z
  .strictObject({ hide_boards: z.boolean().optional(), show_holdings: z.boolean().optional() })
  .meta({ id: "ApiExchangeVisibilityRequest" });
export const ExchangeCancelRequestSchema = z
  .strictObject({ order: z.string().min(1).max(40) })
  .meta({ id: "ApiExchangeCancelRequest" });
export const ExchangeMarginRequestSchema = z
  .strictObject({ position: z.string().min(1).max(40), coins: z.number().int().positive() })
  .meta({ id: "ApiExchangeMarginRequest" });

/** `GET /api/exchange`: the owner's look (no hidden value, no seed). */
export const ExchangeAdminSchema = z
  .object({
    enabled: z.boolean(),
    paused: z.boolean(),
    paused_by: z.string().nullable(),
    vault: z.number().int(),
    vault_rows: z.number().int().nullable(),
    burned: z.number().int(),
    burned_week: z.number().int(),
    obligations: z.number(),
    level: z.number().nullable(),
    fish: z.number(),
    owed: z.array(
      z.object({ person: z.string(), name: z.string().nullable(), gross: z.number().int() }),
    ),
    pending_postings: z.number().int(),
    accounts: z.number().int(),
    positions: z.number().int(),
    open_orders: z.number().int(),
    rounds: z.array(
      z.object({
        round: z.number().int(),
        at: z.string(),
        status: z.string(),
        fish: z.number(),
        level: z.number().nullable(),
        vault: z.number().int(),
        burned: z.number().int(),
        volume: z.number().int(),
      }),
    ),
    holders: z.array(
      z.object({
        person: z.string(),
        name: z.string().nullable(),
        positions: z.array(
          z.object({
            id: z.string(),
            code: z.string(),
            leverage: z.number().int(),
            qty: z.number().int(),
            value: z.number(),
            equity: z.number(),
          }),
        ),
      }),
    ),
    params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
  })
  .meta({ id: "ApiExchangeAdmin" });
export type ExchangeAdmin = z.output<typeof ExchangeAdminSchema>;

export const ExchangePauseRequestSchema = z
  .strictObject({ paused: z.boolean() })
  .meta({ id: "ApiExchangePauseRequest" });
export const ExchangeAdminSellRequestSchema = z
  .strictObject({ position: z.string().min(1).max(40), note: z.string().max(200).optional() })
  .meta({ id: "ApiExchangeAdminSellRequest" });

const member = () => route.meta({ audience: "member", permission: null, limited: true });
const Code = z.object({ code: z.string().regex(/^[A-Z]{4}$/) });

/** The member's side: needs a session (by cookie), limited per account. */
export const exchange = {
  market: member()
    .route({ method: "GET", path: "/api/member/exchange" })
    .output(ExchangeMarketSchema),
  company: member()
    .route({ method: "GET", path: "/api/member/exchange/company/{code}" })
    .input(z.object({ params: Code }))
    .output(ExchangeCompanyPageSchema),
  account: member()
    .route({ method: "GET", path: "/api/member/exchange/account" })
    .output(ExchangeAccountSchema),
  /** Opens their account (`403` with a sentence when they may not yet). */
  open: member()
    .route({ method: "POST", path: "/api/member/exchange/account" })
    .output(ExchangeAccountSchema),
  /** The one-time opt-in to leverage, after its risks were shown. */
  leverage: member()
    .route({ method: "POST", path: "/api/member/exchange/leverage" })
    .input(z.object({ body: ExchangeLeverageRequestSchema }))
    .output(ExchangeAccountSchema),
  visibility: member()
    .route({ method: "POST", path: "/api/member/exchange/visibility" })
    .input(z.object({ body: ExchangeVisibilityRequestSchema }))
    .output(ExchangeAccountSchema),
  /** What an order would do, for the confirmation; a refusal says why it would not go through. */
  quote: member()
    .route({ method: "POST", path: "/api/member/exchange/quote" })
    .input(z.object({ body: ExchangeOrderRequestSchema }))
    .output(ExchangeQuoteSchema),
  /** Places an order; the same `Idempotency-Key` is the same order. */
  order: member()
    .route({ method: "POST", path: "/api/member/exchange/order" })
    .input(z.object({ headers: IdempotencyHeaders, body: ExchangeOrderRequestSchema }))
    .output(ExchangeOrderSchema),
  cancel: member()
    .route({ method: "POST", path: "/api/member/exchange/cancel" })
    .input(z.object({ body: ExchangeCancelRequestSchema }))
    .output(z.object({ refunded: z.number().int() })),
  /** Adds margin to a leveraged position; the same `Idempotency-Key` adds it once. */
  margin: member()
    .route({ method: "POST", path: "/api/member/exchange/margin" })
    .input(z.object({ headers: IdempotencyHeaders, body: ExchangeMarginRequestSchema }))
    .output(z.object({ added: z.number().int(), position: ExchangeLeveragedSchema.nullable() })),
  portfolio: member()
    .route({ method: "GET", path: "/api/member/exchange/portfolio" })
    .output(ExchangePortfolioSchema),
  boards: member()
    .route({ method: "GET", path: "/api/member/exchange/boards" })
    .output(ExchangeBoardsSchema),
};

/** The owner's side. */
export const exchangeAdmin = {
  view: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/exchange" })
    .output(ExchangeAdminSchema),
  /** Pauses (open orders go back) or resumes the market. */
  pause: route
    .meta({ audience: "admin", permission: NODE_EXCHANGE })
    .route({ method: "POST", path: "/api/exchange/pause" })
    .input(z.object({ body: ExchangePauseRequestSchema }))
    .output(z.object({ paused: z.boolean(), refunded: z.number().int() })),
  /** Sells one position now at the last price, no fee; recorded in the audit log. */
  sell: route
    .meta({ audience: "admin", permission: NODE_EXCHANGE })
    .route({ method: "POST", path: "/api/exchange/sell" })
    .input(z.object({ body: ExchangeAdminSellRequestSchema }))
    .output(z.object({ paid: z.number().int() })),
};
