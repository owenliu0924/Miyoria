// A message someone asked her not to remember ("不要記住這個", `MessageActions.dontRemember`).
//
// The agent hides it from her prompts at once (its text in the conversation she sees becomes a
// placeholder) and publishes this event, so whatever else keeps what people said (memory
// consolidation, reflection, person notes) can leave it out as well. The event names the message;
// it never repeats its text.

import type { MessageExcludedData } from "@miyoria/contracts/events";

/** Topic of `MessageExcluded` (a `custom` event). */
export const MESSAGE_EXCLUDED_TOPIC = "agent.message.excluded";

/** The payload of `MESSAGE_EXCLUDED_TOPIC` (contract: `MessageExcludedSchema`). */
export type MessageExcluded = MessageExcludedData;
