// @miyoria/play/exchange: the deep-sea exchange (深海交易所, docs/design/exchange.md).
//
// - `engine/`: the pure engine (prices, rounds, orders, fees, the vault, the level, the limits,
//   leverage and liquidation), seeded and without a clock. The module and the simulation run it.
// - `sim/`: the offline simulation and its pass criteria.

export * from "./engine/index.js";
export { STRATEGY_LABEL, type StrategyName } from "./sim/agents.js";
export { defaultAgents, runSim, type SimOptions, type SimResult } from "./sim/run.js";
export {
  type StrategyRow,
  type Summary,
  simulate,
  stressParams,
  summarize,
} from "./sim/summary.js";
