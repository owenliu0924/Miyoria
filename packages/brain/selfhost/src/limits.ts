// The limits of a text run as its place sets them: `[modules.agent]` `text_rounds`,
// `text_seconds`, `text_tool_seconds`, a room's own value, then its channel's, its Space's, the
// cluster's (`AgentHandle.configAt`). Read per run, so a place's new value counts from its next
// run. Calls per step and the token ceiling are the profile's own; money is the person's quota.

import type { ContextKey } from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import type { RunLimits } from "../../self/src/index.js";

/** The steps and time of one text run at `context` (voice keeps its own). */
export function textLimits(
  agent: Agent,
  context: ContextKey,
): Pick<RunLimits, "rounds" | "wallMs" | "toolMs"> {
  const config = agent.handle.configAt(context);
  return {
    rounds: config.text_rounds,
    wallMs: config.text_seconds * 1000,
    toolMs: config.text_tool_seconds * 1000,
  };
}
