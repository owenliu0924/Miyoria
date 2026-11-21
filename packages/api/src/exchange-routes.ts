// The deep-sea exchange's routes (docs/design/exchange.md), over `ExchangeKey`:
//
// * Member (`exchange` group, a session, limited per account): the market, a company, their
//   account (open it, take leverage's risks, hide from the boards), a quote, an order (with an
//   `Idempotency-Key`), a cancel, margin (with an `Idempotency-Key`), their portfolio, the boards.
//   The person is the session's; a refusal is its status and sentence, the same as in Discord.
//   Nobody sees anybody else's holdings or orders here, except on the boards of someone who chose
//   to show what they hold.
// * Admin (`exchangeAdmin`): `GET /api/exchange`; `POST /api/exchange/pause` and
//   `POST /api/exchange/sell` need `admin.economy.adjust`, like a hand on someone's coins.
//
// Without the `exchange` module every route is a `503` that names it.

import type {
  ExchangeAccount,
  ExchangeAdmin,
  ExchangeBoards,
  ExchangeCompanyPage,
  ExchangeMarket,
  ExchangeOrder,
  ExchangePortfolio,
  ExchangeQuote,
} from "@miyoria/contracts/api";
import {
  ExchangeKey,
  type ExchangeService,
  type OrderRequest,
  type Refusal,
} from "@miyoria/play/exchange";
import type { AccountRef } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import type { SessionRecord } from "./session.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";
import { keyOf } from "./wallet.js";

function service(state: ApiState): ExchangeService {
  return state.service(ExchangeKey, "exchange module");
}

function accountOf(c: ApiContext): AccountRef {
  return (c.get("member") as SessionRecord).account;
}

function refused(r: Refusal): never {
  throw new ApiError(r.status, r.message);
}

/** The request as the service takes it (absent fields left out). */
function orderOf(body: {
  side: "buy" | "sell";
  company: string;
  coins?: number | undefined;
  shares?: number | undefined;
  all?: boolean | undefined;
  limit?: number | null | undefined;
  days?: number | undefined;
  leverage?: number | undefined;
  position?: string | undefined;
}): OrderRequest {
  const out: OrderRequest = { side: body.side, company: body.company };
  if (body.coins !== undefined) out.coins = body.coins;
  if (body.shares !== undefined) out.shares = body.shares;
  if (body.all !== undefined) out.all = body.all;
  if (body.limit !== undefined) out.limit = body.limit;
  if (body.days !== undefined) out.days = body.days;
  if (body.leverage !== undefined) out.leverage = body.leverage;
  if (body.position !== undefined) out.position = body.position;
  return out;
}

const STRANGER = "她還不認識你,先和她說說話吧";

export const exchangeRpc = {
  market: os.exchange.market.handler(
    async ({ context: { state } }): Promise<ExchangeMarket> => service(state).market(),
  ),
  company: os.exchange.company.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeCompanyPage> => {
      const page = await service(state).company(input.params.code, accountOf(c));
      if (!page) throw ApiError.notFound("沒有這家公司");
      return page;
    },
  ),
  account: os.exchange.account.handler(
    async ({ context: { state, c } }): Promise<ExchangeAccount> => {
      const view = await service(state).accountView(accountOf(c));
      if (!view) throw new ApiError(403, STRANGER);
      return view;
    },
  ),
  open: os.exchange.open.handler(async ({ context: { state, c } }): Promise<ExchangeAccount> => {
    const r = await service(state).openAccount(accountOf(c));
    if (!r.ok) refused(r);
    return r.account;
  }),
  leverage: os.exchange.leverage.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeAccount> => {
      const r = await service(state).optInLeverage(accountOf(c), input.body.accept);
      if (!r.ok) refused(r);
      return r.account;
    },
  ),
  visibility: os.exchange.visibility.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeAccount> => {
      const patch: { hide_boards?: boolean; show_holdings?: boolean } = {};
      if (input.body.hide_boards !== undefined) patch.hide_boards = input.body.hide_boards;
      if (input.body.show_holdings !== undefined) patch.show_holdings = input.body.show_holdings;
      const r = await service(state).setVisibility(accountOf(c), patch);
      if (!r.ok) refused(r);
      return r.account;
    },
  ),
  quote: os.exchange.quote.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeQuote> => {
      const r = await service(state).quote(accountOf(c), orderOf(input.body));
      if (!r.ok) refused(r);
      return r.quote;
    },
  ),
  order: os.exchange.order.handler(
    async ({ input, context: { state, c } }): Promise<ExchangeOrder> => {
      const key = `web:${keyOf(input.headers["idempotency-key"])}`;
      const r = await service(state).place(accountOf(c), orderOf(input.body), key);
      if (!r.ok) refused(r);
      return r.order;
    },
  ),
  cancel: os.exchange.cancel.handler(async ({ input, context: { state, c } }) => {
    const r = await service(state).cancel(accountOf(c), input.body.order);
    if (!r.ok) refused(r);
    return { refunded: r.refunded };
  }),
  margin: os.exchange.margin.handler(async ({ input, context: { state, c } }) => {
    const key = `web:${keyOf(input.headers["idempotency-key"])}`;
    const r = await service(state).addMargin(
      accountOf(c),
      input.body.position,
      input.body.coins,
      key,
    );
    if (!r.ok) refused(r);
    return { added: r.added, position: r.position };
  }),
  portfolio: os.exchange.portfolio.handler(
    async ({ context: { state, c } }): Promise<ExchangePortfolio> => {
      const view = await service(state).portfolio(accountOf(c));
      if (!view) throw new ApiError(403, STRANGER);
      return view;
    },
  ),
  boards: os.exchange.boards.handler(
    async ({ context: { state, c } }): Promise<ExchangeBoards> =>
      service(state).boards(accountOf(c)),
  ),
};

export const exchangeAdminRpc = {
  view: os.exchangeAdmin.view.handler(
    async ({ context: { state } }): Promise<ExchangeAdmin> => service(state).adminView(),
  ),
  pause: os.exchangeAdmin.pause.handler(async ({ input, context: { state, c } }) =>
    service(state).setPaused(input.body.paused, actorOf(c)),
  ),
  sell: os.exchangeAdmin.sell.handler(async ({ input, context: { state, c } }) => {
    const r = await service(state).adminSell(
      input.body.position,
      actorOf(c),
      input.body.note?.trim() || null,
    );
    if (!r.ok) refused(r);
    return { paid: r.paid };
  }),
};
