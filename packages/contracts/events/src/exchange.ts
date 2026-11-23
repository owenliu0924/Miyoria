// The exchange on the bus (docs/design/exchange.md): `exchange.quotes` says that new quotes were
// taken, so the member pages' push builds the ticker views again at once instead of at their next
// tick. It carries only the tickers' codes (public market data, no person) and is sent at most
// about once a second while US quotes stream in; never stored (not a recorded topic).

import { z } from "zod";
import { defineEvent } from "./registry.js";

/** An `exchange.quotes` payload: the codes whose quote was taken since the last one. */
export const ExchangeQuotesSchema = z
  .object({ codes: z.array(z.string()) })
  .meta({ id: "EventsExchangeQuotes" });
export type ExchangeQuotesData = z.output<typeof ExchangeQuotesSchema>;

export const ExchangeQuotes = defineEvent({
  type: "exchange.quotes",
  v: 1,
  data: ExchangeQuotesSchema,
  scope: "public",
  tier: "ambient",
});

/** The exchange's topics of the bus. */
export const EXCHANGE_BUS_EVENTS = [ExchangeQuotes] as const;
