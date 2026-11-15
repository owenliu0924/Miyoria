// Payloads of bus topics whose owning package does not depend on the contracts directly: the gate
// decision (`gate.decision`) and the LLM budget (`llm.budget`). Both are the types inferred from
// the schemas in @miyoria/contracts/events.

import type { ActionOutcomeData, GateDecisionData, LlmBudgetData } from "@miyoria/contracts/events";

/** Payload of `gate.decision` (contract: `GateDecisionSchema` in @miyoria/contracts/events). */
export type GateDecisionPayload = GateDecisionData;

/** Payload of `llm.budget` (contract: `LlmBudgetSchema` in @miyoria/contracts/events). */
export type LlmBudgetPayload = LlmBudgetData;

/** Payload of `actions.outcome` (contract: `ActionOutcomeSchema` in @miyoria/contracts/events). */
export type ActionOutcomePayload = ActionOutcomeData;
