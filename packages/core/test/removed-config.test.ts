import { AgentConfigSchema } from "@miyoria/brain/agent";
import { MindConfigSchema } from "@miyoria/heart/mind";
import { Config } from "@miyoria/runtime/kernel";
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
[modules.mind]
max_calls_per_hour = 7
[modules.mind.daily_posts]
enabled = true
channel = "1"
`);

  it("load without an error and their values are ignored", () => {
    expect(() => assertStartConfig(old)).not.toThrow();
    const agent = AgentConfigSchema.parse(old.section("modules.agent"));
    expect(agent).not.toHaveProperty("runner");
    expect(agent.debounce_ms).toBe(900);
    const mind = MindConfigSchema.parse(old.section("modules.mind"));
    expect(mind).not.toHaveProperty("daily_posts");
    expect(mind.max_calls_per_hour).toBe(7);
  });

  it("are named in one warning, and only the ones the file holds", () => {
    const lines: string[] = [];
    const found = warnRemovedKeys(old, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    for (const path of ["core.pipeline", "modules.agent.runner", "modules.mind.daily_posts"]) {
      expect(found).toContain(path);
      expect(lines[0]).toContain(`\`${path}\``);
    }
    expect(lines[0]).not.toContain("debounce_ms");
    expect(lines[0]).not.toContain("max_calls_per_hour");
  });

  it("make no warning in a file that holds none", () => {
    const lines: string[] = [];
    const clean = toml(`[modules.agent]\ndebounce_ms = 900\n`);
    expect(removedConfigKeys(clean)).toEqual([]);
    warnRemovedKeys(clean, (m) => lines.push(m));
    expect(lines).toEqual([]);
  });
});
