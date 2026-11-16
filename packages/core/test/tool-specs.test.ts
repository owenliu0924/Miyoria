// What the current turn offers the model, held to a file: the real core is booted on an in-memory
// store (no Discord, API, cluster or extensions), the capabilities of modules that cannot start
// here (voice, Stage, the sandbox, the diary) are added from their factories, and every tool's
// spec is written out the way `turn.ts` reads it. A change to the registry must leave
// `tool-specs.snap` as it is.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMIT_SPEC, MainLineConfigSchema, STEER_SPEC, slimTool } from "@miyoria/brain/agent";
import { ActuatorRegistryKey, CapabilityTool, isGatedToolName } from "@miyoria/gate/actions";
import { type Tool, ToolRegistryKey } from "@miyoria/llm/tools";
import { Config } from "@miyoria/runtime/kernel";
import { stageCapabilities } from "@miyoria/stage";
import { openStore } from "@miyoria/store";
import {
  codeRunCapability,
  codeSessionCapability,
  toolProposeCapability,
  workspaceRunCapability,
  workspaceSaveScriptCapability,
} from "@miyoria/workspace/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diaryCapability } from "../../memory/learning/src/diary.js";
import { voiceCapabilities } from "../../voice/voice/src/actions.js";
import { buildCoreWith, type Core } from "../src/boot.js";
import { defaultCatalog } from "../src/modules.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASE = join(ROOT, ".tmp-test-b2", "tool-specs");
const SNAPSHOT = fileURLToPath(new URL("./tool-specs.snap", import.meta.url));

const CONFIG = `
[core]
profiles_dir = '${join(ROOT, "profiles")}'
profile = "deepseek-chan"
[modules.cluster]
enabled = false
[modules.sandbox]
enabled = true
[modules.imagegen]
enabled = true
`;

/** What `turn.ts` reads of a tool besides calling it. */
function view(tool: Tool) {
  return {
    name: tool.spec.name,
    description: tool.spec.description,
    parameters: tool.spec.parameters,
    permission: tool.permission ?? null,
    actsFor: tool.actsFor === true,
    readOnly: tool.readOnly === true,
    framed: tool.framed === true,
  };
}

let core: Core;

beforeAll(async () => {
  mkdirSync(BASE, { recursive: true });
  core = await buildCoreWith(
    { ...defaultCatalog, discoverExtensions: async () => ({ skipped: [], modules: [] }) },
    Config.fromToml(CONFIG),
    { discord: false, api: false, baseDir: BASE, store: await openStore("memory://") },
  );
  await core.start();
  const actuators = core.services.require(ActuatorRegistryKey);
  const stub = {} as never;
  const box = { networkAllow: [] } as never;
  const sandbox = { sandbox: box, tools: stub, resultChars: 0, toolTimeoutMs: 0 };
  const workspace = { sandbox: box, workspace: stub, resultChars: 0, readChars: 0, keepOutputs: 0 };
  const extra = [
    ...voiceCapabilities(stub, () => ""),
    ...stageCapabilities(stub),
    codeRunCapability(sandbox),
    codeSessionCapability(sandbox),
    toolProposeCapability(sandbox),
    workspaceSaveScriptCapability(workspace),
    workspaceRunCapability(workspace),
    diaryCapability(stub, () => []),
  ];
  for (const capability of extra) {
    if (actuators.get(capability.name) === undefined) actuators.register(capability as never);
  }
}, 120_000);

afterAll(async () => {
  await core?.stop();
  rmSync(BASE, { recursive: true, force: true });
});

/** The registered tools a turn can be offered: all but a game adapter's raw ones. */
function offered(): Tool[] {
  const tools = core.services.require(ToolRegistryKey);
  return tools.names().flatMap((name) => {
    const tool = tools.get(name);
    if (!tool) return [];
    return isGatedToolName(name) && !(tool instanceof CapabilityTool) ? [] : [tool];
  });
}

describe("the tools of the current turn", () => {
  it("are offered with the same specs as before", async () => {
    const limits = MainLineConfigSchema.parse({});
    const slim = { description: limits.tool_chars, argument: limits.tool_arg_chars };
    const tools = offered();
    const snapshot = {
      tools: tools.map(view),
      // What the main line sends: each spec cut to its budget, then her own two.
      sent: [...tools.map((t) => slimTool(t.spec, slim)), COMMIT_SPEC, STEER_SPEC],
    };
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(SNAPSHOT);
  });

  it("cover every module that owns tools", () => {
    const names = new Set(offered().map((t) => t.spec.name));
    // One tool of each owner, so a module that stops registering here is noticed.
    const owners: Record<string, string> = {
      agent: "react",
      worklane: "work_start",
      directive: "directive_add",
      memory: "recall",
      notebook: "notebook_read",
      knowledge: "knowledge_note",
      diary: "diary_write",
      social: "set_call_name",
      mind: "remind_me",
      economy: "give_coins",
      game: "game_start",
      party: "party_start",
      sing: "sing_start",
      voice: "voice_join",
      stage: "stage_scene",
      web: "web_search",
      sandbox: "code_run",
      workspace: "workspace_read",
      skills: "skill_read",
      actions: "message_dm",
    };
    const missing = Object.entries(owners).filter(([, tool]) => !names.has(tool));
    expect(missing).toEqual([]);
  });
});
