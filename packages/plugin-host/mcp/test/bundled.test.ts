// MCP servers an extension bundles: connected through the extension launcher, with the
// extension's environment, tuned by the owner like a configured server, gated like one.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  EventBus,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  AuthorizerKey,
  BaseAuthorizer,
  type JsonObject,
  type JsonValue,
  Principals,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtensionCatalog,
  ExtensionCatalogKey,
  type ExtensionLauncher,
  ExtensionLauncherKey,
  ExtensionManifest,
  type LaunchSpec,
  localLauncher,
} from "../../ext-host/src/index.js";
import { bundledLaunchSpec, bundledServerName } from "../src/bundled.js";
import { McpModule, parseMcpConfig } from "../src/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fixture-server.mjs");
const DIR = dirname(FIXTURE);

class AllowAll extends BaseAuthorizer {
  allowsSubject(): boolean {
    return true;
  }
}

function catalog(enabled = true, extra = ""): ExtensionCatalog {
  const manifest = ExtensionManifest.parse(
    [
      'id = "made.up"',
      'version = "1"',
      'runtime = "node"',
      'entry = "index.mjs"',
      "[env]",
      'pass = ["MADE_*"]',
      "[[mcp_servers]]",
      'name = "fx"',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(FIXTURE)}]`,
      'env = { FIXTURE_VAR = "from-manifest" }',
      extra,
    ].join("\n"),
  );
  return new ExtensionCatalog([
    {
      enabled,
      spec: {
        manifest,
        dir: DIR,
        granted: { events: [], tools: true, commands: false, network: [], input: [] },
        runIn: "host",
      },
    },
  ]);
}

interface Harness {
  sup: Supervisor;
  tools: ToolRegistry;
  actuators: ActuatorRegistry;
  module: McpModule;
}

const running: Harness[] = [];
afterEach(async () => {
  for (const h of running.splice(0)) await h.sup.stopAll();
});

async function start(
  mcp: JsonValue,
  cat: ExtensionCatalog,
  launcher?: ExtensionLauncher,
): Promise<Harness> {
  const services = new ServiceRegistry();
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", AuthorizerKey, new AllowAll());
  services.provide("app", ExtensionCatalogKey, cat);
  if (launcher) services.provide("app", ExtensionLauncherKey, launcher);
  const actuators = new ActuatorRegistry({ services, tools, builtins: false });
  services.provide("app", ActuatorRegistryKey, actuators);
  const sup = new Supervisor({ bus: new EventBus({ capacity: 64 }), services });
  services.provide("app", SupervisorKey, sup);
  const module = new McpModule(parseMcpConfig(mcp));
  await sup.register(module, null, true);
  await sup.startAll();
  const h = { sup, tools, actuators, module };
  running.push(h);
  return h;
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("condition not met within 20s");
}

function unframe(text: string): string {
  const match = /^<data [^>]*>\n([\s\S]*)\n<\/data>$/u.exec(text);
  if (!match) throw new Error(`not a data block: ${text}`);
  return match[1] as string;
}

async function call(h: Harness, capability: string, args: JsonObject): Promise<string> {
  const out = await h.actuators.invoke({
    principal: Principals.self(null),
    capability,
    args,
    why: null,
    turn: null,
  });
  if (out.status !== "done") throw new Error(`${capability}: ${JSON.stringify(out)}`);
  return unframe(out.result.text);
}

const SERVER = bundledServerName("made.up", "fx");

describe("bundled MCP servers", { timeout: 40_000 }, () => {
  it("are named after their extension", () => {
    expect(SERVER).toBe("made_up-fx");
  });

  it("start through the extension's launcher, in its folder, with its environment", async () => {
    const seen: [string, LaunchSpec][] = [];
    const local = localLauncher();
    const launcher: ExtensionLauncher = {
      launch: (spec, signal) => local.launch(spec, signal),
      launchInSame: (extension, spec, signal) => {
        seen.push([extension, spec]);
        return local.launch(spec, signal);
      },
    };
    process.env.LLM_API_KEY = "sk-never-to-a-bundled-server";
    process.env.MADE_URL = "https://made.example";
    try {
      const h = await start({}, catalog(), launcher);
      await eventually(() => h.module.status()?.server(SERVER)?.connected === true);
      expect(seen.map(([extension]) => extension)).toEqual(["made.up"]);
      expect(seen[0]?.[1]).toMatchObject({ cwd: DIR, runIn: "host", program: process.execPath });
      const capability = `mcp.${SERVER}.echo`;
      expect(h.actuators.get(capability)).toMatchObject({
        risk: "medium",
        permission: `tools.mcp.${SERVER}`,
      });
      expect(await call(h, capability, { text: "hi" })).toBe("hi");
      expect(await call(h, `mcp.${SERVER}.env`, { name: "FIXTURE_VAR" })).toBe("from-manifest");
      expect(await call(h, `mcp.${SERVER}.env`, { name: "MADE_URL" })).toBe("https://made.example");
      expect(await call(h, `mcp.${SERVER}.env`, { name: "LLM_API_KEY" })).toBe("<unset>");
      await h.sup.stopAll();
      expect(h.tools.names()).toEqual([]);
    } finally {
      delete process.env.LLM_API_KEY;
      delete process.env.MADE_URL;
    }
  });

  it("the owner tunes one by its name; a disabled extension brings none", async () => {
    const h = await start(
      { servers: { [SERVER]: { tools_allow: ["echo", "env"], risk: "low" } } },
      catalog(),
    );
    await eventually(() => h.module.status()?.server(SERVER)?.connected === true);
    expect(h.tools.names().sort()).toEqual([`mcp_${SERVER}_echo`, `mcp_${SERVER}_env`]);
    expect(h.actuators.get(`mcp.${SERVER}.echo`)?.risk).toBe("low");
    await h.sup.stopAll();

    const off = await start({}, catalog(false));
    await sleep(200);
    expect(off.module.status()?.server(SERVER)).toBeUndefined();
    expect(off.tools.names()).toEqual([]);
  });

  it("a manifest's risk applies unless the owner set one", async () => {
    const h = await start({}, catalog(true, 'risk = "high"'));
    await eventually(() => h.module.status()?.server(SERVER)?.connected === true);
    expect(h.actuators.get(`mcp.${SERVER}.echo`)?.risk).toBe("high");
  });

  it("the launch spec drops the protocol variables and keeps Core's credentials out", () => {
    const [server] = catalog().mcpServers();
    if (!server) throw new Error("no bundled server");
    const spec = bundledLaunchSpec(server, {
      PATH: "/bin",
      MADE_URL: "u",
      MADE_TOKEN: "t",
      LLM_API_KEY: "sk",
    });
    expect(spec.env).toEqual({ PATH: "/bin", MADE_URL: "u", FIXTURE_VAR: "from-manifest" });
    expect(spec.runtime).toBe("binary");
  });
});
