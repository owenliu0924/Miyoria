// The registry of bus topics: every event type that is published on the in-process bus today,
// named after its dotted topic, with the schema of the payload it is published with. The store's
// registry (`coreEventRegistry` in @miyoria/store) is a different list: what the event log
// records, some of it under other names (`facts.*`).
//
// Tests check every published event against it (`bus-check.ts`). Topics are added area by area
// (K12a in docs/design/v5-contracts.md); a topic missing here is reported as unregistered.

import { CHAT_EVENTS } from "./chat.js";
import { LlmCall } from "./llm.js";
import { type AnyEventDefinition, EventRegistry } from "./registry.js";
import { TURN_EVENTS } from "./turn.js";

/** Every bus topic with a payload schema, families included. */
export const BUS_EVENTS: readonly AnyEventDefinition[] = [...CHAT_EVENTS, ...TURN_EVENTS, LlmCall];

/** A new registry holding `BUS_EVENTS`. */
export function busEventRegistry(): EventRegistry {
  return new EventRegistry().register(...BUS_EVENTS);
}
