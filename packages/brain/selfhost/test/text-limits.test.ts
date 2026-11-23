// One text run's limits in the text host: `[modules.agent]` `text_rounds`, `text_seconds` and
// `text_tool_seconds` are what the run is held to, and their defaults are the text profile's; the
// calls of a step and the token ceiling are the profile's own.

import { defineTool } from "@miyoria/llm/tools";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultAgentConfig } from "../../agent/src/index.js";
import { TEXT_LIMITS } from "../../self/src/index.js";
import { calls, channel, mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");

const look = defineTool({
  name: "look_up",
  description: "查一下。",
  parameters: z.object({}),
  effect: "read",
  speed: "instant",
  risk: "low",
  group: "test",
  core: true,
  next: true,
  readOnly: true,
  async call() {
    return "查到了";
  },
});

describe("one text run's limits", () => {
  it("default to the text profile's", () => {
    const config = defaultAgentConfig();
    expect({
      rounds: config.text_rounds,
      wallMs: config.text_seconds * 1000,
      toolMs: config.text_tool_seconds * 1000,
    }).toEqual({
      rounds: TEXT_LIMITS.rounds,
      wallMs: TEXT_LIMITS.wallMs,
      toolMs: TEXT_LIMITS.toolMs,
    });
    expect(TEXT_LIMITS).toMatchObject({ callsPerRound: 8, tokens: 3_000_000 });
    expect(config).not.toHaveProperty("text_calls_per_round");
    expect(config).not.toHaveProperty("text_tokens");
  });

  it("are the ones [modules.agent] sets", async () => {
    const rig = await Rig.create({
      config: { text_rounds: 2 },
      provide: (_sup, tools) => tools.register(look),
    });
    rig.model.push(calls("look_up", {}), calls("look_up", {}), says("查完了"));
    rig.say(mention(C1, "amy", "@她 幫我查"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(rig.model.requests).toHaveLength(3);
    expect(textOf(rig.model.requests[2])).toContain("這一回合能用工具的次數用完了");
  });
});
