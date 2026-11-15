// The agent's turns besides its decision and outcome (`turn.ts`), in docs/design/v5-contracts.md
// §3, K12a: a turn started and ended, and a request to start a turn on her own. Each type is the
// bus topic it is published on, and its payload is that event's data.
//
// Turn internals: kept 90 days (`short`), no default scope (the session decides).

import { z } from "zod";
import { AccountRefSchema, ContextKeySchema, TurnIdSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** A turn started: `agent.turn.started` (typed bus variant `agent_turn_started`). */
export const TurnStartedSchema = z
  .object({ turn: TurnIdSchema, context: ContextKeySchema })
  .meta({ id: "EventsTurnStarted" });
export type TurnStartedData = z.output<typeof TurnStartedSchema>;

/**
 * A turn's generation ended: `agent.turn.completed` (`agent_turn_completed`). `text`: what she
 * wrote, empty for a cancelled or dropped turn.
 */
export const TurnCompletedSchema = z
  .object({ turn: TurnIdSchema, context: ContextKeySchema, text: z.string() })
  .meta({ id: "EventsTurnCompleted" });
export type TurnCompletedData = z.output<typeof TurnCompletedSchema>;

/** Asks the agent to start a turn on her own: `agent.initiative` (`agent_initiative`). */
export const AgentInitiativeSchema = z
  .object({
    context: ContextKeySchema,
    /** Why, for the decision trace (`idle_channel`, `followup`). */
    reason: z.string(),
    /** What she might bring up. */
    hint: z.string(),
    /** Accounts the hint is about. */
    about: z.array(AccountRefSchema),
  })
  .meta({ id: "EventsAgentInitiative" });
export type AgentInitiativeData = z.output<typeof AgentInitiativeSchema>;

export const AgentTurnStarted = defineEvent({
  type: "agent.turn.started",
  v: 1,
  data: TurnStartedSchema,
  tier: "short",
});

export const AgentTurnCompleted = defineEvent({
  type: "agent.turn.completed",
  v: 1,
  data: TurnCompletedSchema,
  tier: "short",
});

export const AgentInitiative = defineEvent({
  type: "agent.initiative",
  v: 1,
  data: AgentInitiativeSchema,
  tier: "short",
});

/** Every agent type besides the turn records (`TURN_EVENTS`). */
export const AGENT_EVENTS = [AgentTurnStarted, AgentTurnCompleted, AgentInitiative] as const;
