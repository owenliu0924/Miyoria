import { AgentConfigSchema } from "@miyoria/brain/agent";
import { MindConfigSchema } from "@miyoria/heart/mind";
import { Config } from "@miyoria/runtime/kernel";
import { WebConfigSchema } from "@miyoria/workspace/web";
import { describe, expect, it } from "vitest";
import { assertStartConfig } from "../src/config-schema.js";
import { removedConfigKeys, warnRemovedKeys } from "../src/removed-config.js";

const toml = (text: string): Config => Config.fromToml(text, () => "x");

describe("config keys that are no longer read", () => {
  const old = toml(`
[core]
pipeline = "v2"
[modules.agent]
runner = "v2"
debounce_ms = 900
session_usd_per_hour = 2
session_tokens_per_hour = 100000
text_calls_per_round = 4
text_tokens = 500000
text_rounds = 12
[modules.agent.delegate]
daily_usd = 5
daily_tokens = 1000
reflect_daily_tokens = 1000
reflect_daily_usd = 0.3
[modules.agent.delegate.kinds.worker]
calls_per_round = 3
tokens = 9
rounds = 7
[modules.web]
window_s = 300
search_per_person = 2
read_per_job = 5
image_global = 9
region = "us-en"
[modules.mind]
max_calls_per_hour = 7
journal_keep = 7
[modules.social]
appraisal_every_lines = 8
[modules.self.heart]
crush_threshold = 0.4
[modules.world]
care_min_affinity = 20
[modules.mind.daily_posts]
enabled = true
channel = "1"
[modules.agent.attention]
talk_floor = 0.2
[modules.agent.voice]
gray_low = 0.2
debounce_ms = 650
[modules.agent.mainline]
history_lines = 100
self_chars = 1500
[modules.agent.work]
max_steps = 5
daily_tokens = 1000
[modules.agent.corrections]
claims = false
self_talk = false
[modules.agent.rhythm]
looks_per_hour = 3
reactions_per_hour = 9
[llm.thinking]
chat = true
[llm.reasoning]
chat_text = "low"
plan = "high"
`);

  it("load without an error and their values are ignored", () => {
    expect(() => assertStartConfig(old)).not.toThrow();
    const agent = AgentConfigSchema.parse(old.section("modules.agent"));
    expect(agent).not.toHaveProperty("runner");
    expect(agent.debounce_ms).toBe(900);
    expect(agent).not.toHaveProperty("session_usd_per_hour");
    expect(agent).not.toHaveProperty("text_tokens");
    expect(agent.text_rounds).toBe(12);
    expect(agent.delegate).not.toHaveProperty("daily_usd");
    expect(agent.delegate.reflect_daily_usd).toBe(0.3);
    expect(agent.delegate.kinds.worker).not.toHaveProperty("calls_per_round");
    expect(agent.delegate.kinds.worker.rounds).toBe(7);
    const web = WebConfigSchema.parse(old.section("modules.web"));
    expect(web).not.toHaveProperty("search_per_person");
    expect(web.region).toBe("us-en");
    const mind = MindConfigSchema.parse(old.section("modules.mind"));
    expect(mind).not.toHaveProperty("daily_posts");
    expect(mind).not.toHaveProperty("max_calls_per_hour");
    expect(mind.journal_keep).toBe(7);
    // The keys beside the removed ones are still read.
    expect(agent.voice.debounce_ms).toBe(650);
    expect(agent.voice).not.toHaveProperty("gray_low");
    expect(agent.mainline.self_chars).toBe(1500);
    expect(agent.mainline).not.toHaveProperty("history_lines");
    expect(agent.work.daily_tokens).toBe(1000);
    expect(agent.corrections.self_talk).toBe(false);
    expect(agent.corrections).not.toHaveProperty("claims");
  });

  it("are named in one warning, and only the ones the file holds", () => {
    const lines: string[] = [];
    const found = warnRemovedKeys(old, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    const expected = [
      "core.pipeline",
      "llm.thinking",
      "modules.agent.runner",
      "modules.agent.attention",
      "modules.agent.session_usd_per_hour",
      "modules.agent.session_tokens_per_hour",
      "modules.agent.text_calls_per_round",
      "modules.agent.text_tokens",
      "modules.agent.delegate.daily_usd",
      "modules.agent.delegate.daily_tokens",
      "modules.agent.delegate.reflect_daily_tokens",
      "modules.agent.delegate.kinds.worker.calls_per_round",
      "modules.agent.delegate.kinds.worker.tokens",
      "modules.web.window_s",
      "modules.web.search_per_person",
      "modules.web.image_global",
      "modules.web.read_per_job",
      "modules.agent.voice.gray_low",
      "modules.agent.mainline.history_lines",
      "modules.agent.work.max_steps",
      "modules.agent.corrections.claims",
      "modules.agent.rhythm.looks_per_hour",
      "modules.mind.daily_posts",
      "modules.social",
      "modules.self.heart",
      "modules.world.care_min_affinity",
      "modules.mind.max_calls_per_hour",
      "llm.reasoning.plan",
    ];
    expect(found).toEqual(expected);
    for (const path of expected) expect(lines[0]).toContain(`\`${path}\``);
    // Keys that are still read are not named, nor is a table that stays.
    for (const kept of [
      "debounce_ms`",
      "journal_keep",
      "voice.debounce_ms",
      "self_chars",
      "`modules.agent.work.daily_tokens`",
      "self_talk",
      "reactions_per_hour",
      "`llm.reasoning`",
      "text_rounds",
      "reflect_daily_usd",
      "kinds.worker.rounds",
      "region",
    ]) {
      expect(lines[0]).not.toContain(kept);
    }
  });

  it("make no warning in a file that holds none", () => {
    const lines: string[] = [];
    const clean = toml(`[modules.agent]\ndebounce_ms = 900\n`);
    expect(removedConfigKeys(clean)).toEqual([]);
    warnRemovedKeys(clean, (m) => lines.push(m));
    expect(lines).toEqual([]);
  });
});
