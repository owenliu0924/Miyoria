// @miyoria/play/exchange: the deep-sea exchange (深海交易所, docs/design/exchange.md).
//
// - `engine/`: the pure engine (prices, rounds, orders, fees, the vault, the level, the limits,
//   leverage and liquidation), seeded and without a clock. The module and the simulation run it.
// - `sim/`: the offline simulation and its pass criteria.
// - `config.ts`: `[modules.exchange]`; `schema.ts`, `migrations.ts`, `store.ts`: the `exchange`
//   store plugin; `service.ts`: `ExchangeService`; `texts.ts`: what a member is told.
// - `pictures.ts`, `commands.ts`: the picture answers and `/me market`.
// - `words.ts`: her side (news worded, opening and closing lines, the weekly rating).
// - `module.ts`: module `exchange` and `ExchangeKey`.

export { PATHS, registerCommands, unregisterCommands } from "./commands.js";
export {
  type ExchangeConfig,
  ExchangeConfigSchema,
  engineParams,
  exchangeConfig,
  rulesOf,
  tierIndex,
} from "./config.js";
export * from "./engine/index.js";
export { exchangeSchema } from "./migrations.js";
export { ExchangeKey, ExchangeModule, type ExchangeModuleOptions, TICK_MS } from "./module.js";
export {
  boardPictureData,
  dayPictureData,
  drawPicture,
  portfolioPictureData,
  quotePictureData,
  withPicture,
} from "./pictures.js";
export * from "./service.js";
export { STRATEGY_LABEL, type StrategyName } from "./sim/agents.js";
export { defaultAgents, runSim, type SimOptions, type SimResult } from "./sim/run.js";
export {
  type StrategyRow,
  type Summary,
  simulate,
  stressParams,
  summarize,
} from "./sim/summary.js";
export * from "./store.js";
export { CURRENCY, END_WHY, hourOf, noticeText, refundText } from "./texts.js";
export { draftOf, HerDesk, type HerDeskDeps, plainLine, plainRating } from "./words.js";
