// @miyoria/play/market: the weekly market (docs/design/v5-play.md §4.5, §11.4).
//
// - `config.ts`: `[modules.market]` (the song priority ticket, the auction, the lottery).
// - `time.ts`: her local days and weeks, when a lot opens and the lottery is drawn.
// - `lots.ts`: what the auction sells, the rotation, and her pick of the week's lot.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `market` store plugin (`market_lots`,
//   `market_bids`, `market_lottery_weeks`, `market_lottery_tickets`) and its events
//   (`events.ts`); `retireMarketSql` gives every hold and open ticket back when it is removed.
// - `service.ts`: `MarketService`: bids and holds, a won lot burned, the name lot, lottery tickets
//   and the draw, the song priority ticket (`SongPriorityKey`), the views and the owner's controls.
// - `notices.ts`, `commands.ts`: the neutral cards it posts and `/me auction`, `/me lottery`.
// - `notes.ts`: what she hears of a lot won and of a draw.
// - `module.ts`: module `market` and `MarketKey`.

export { registerCommands, unregisterCommands } from "./commands.js";
export {
  LOT_KINDS,
  type LotKind,
  lotteryChannel,
  type MarketConfig,
  MarketConfigSchema,
  marketConfig,
} from "./config.js";
export { MARKET_SOURCE } from "./events.js";
export {
  LlmLotPicker,
  LOT_TITLE,
  type LotPick,
  type LotPicker,
  parsePick,
  rotationKind,
} from "./lots.js";
export { marketSchema, retireMarketSql } from "./migrations.js";
export { MarketKey, MarketModule, type MarketModuleOptions, TICK_MS } from "./module.js";
export {
  auctionNotice,
  BUY_COUNTS,
  lotResultNotice,
  lotteryNotice,
  lotteryResultNotice,
  ROUTES,
} from "./notices.js";
export {
  type AuctionView,
  type BidResult,
  type BuyResult,
  type CallNames,
  type LotteryView,
  type LotView,
  MAX_BID,
  type MarketDeps,
  type MarketHistory,
  type MarketRefusal,
  MarketService,
  type MyBid,
  type MyTickets,
  type NameResult,
  STALE_MS,
} from "./service.js";
export {
  type Bid,
  type Lot,
  type LotteryWeek,
  MarketStore,
  marketTables,
  type Ticket,
} from "./store.js";
export { lastSlot, localDay, nextSlot, weekdayOf } from "./time.js";
