// A bundled MCP server is part of its extension: when the owner disables the extension from the
// panel while Core runs, the server's program ends and its tools go; enabled again, it comes
// back. A server of an extension disabled before the MCP module started waits for it.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  EventBus,
  type Module,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import { AuthorizerKey, BaseAuthorizer } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChildLike,
  ExtensionCatalog,
  ExtensionCatalogKey,
  type ExtensionLauncher,
  ExtensionLauncherKey,
  ExtensionManifest,
  localLauncher,
} from "../../ext-host/src/index.js";
import { bundledServerName } from "../src/bundled.js";
import { McpModule, parseMcpConfig } from "../src/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fixture-server.mjs");
const DIR = dirname(FIXTURE);
const SERVER = bundledServerName("made.up", "fx");
const OWNER = "ext.made.up";

class AllowAll extends BaseAuthorizer {
  allowsSubject(): boolean {
    return true;
  }
}

function catalog(): ExtensionCatalog {
  const manifest = ExtensionManifest.parse(
    [
      'id = "made.up"',
      'version = "1"',
      'runtime = "node"',
      'entry = "index.mjs"',
      "[[mcp_servers]]",
      'name = "fx"',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(FIXTURE)}]`,
    ].join("\n"),
  );
  return new ExtensionCatalog([
    {
      enabled: true,
      spec: {
        manifest,
        dir: DIR,
        granted: { events: [], tools: true, commands: false, network: [], input: [] },
        runIn: "host",
      },
    },
  ]);
}

/** Stands in for the extension's own module, which the owner turns off and on. */
function extensionModule(): Module {
  return { manifest: defineManifest(OWNER, "Made up"), async start() {} };
}

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const sup of sups.splice(0)) await sup.stopAll();
});

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("condition not met within 20s");
}

async function start(extensionEnabled: boolean) {
  const services = new ServiceRegistry();
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", AuthorizerKey, new AllowAll());
  services.provide("app", ExtensionCatalogKey, catalog());
  const children: ChildLike[] = [];
  const local = localLauncher();
  const launcher: ExtensionLauncher = {
    launch: (spec, signal) => local.launch(spec, signal),
    launchInSame: async (_extension, spec, signal) => {
      const child = await local.launch(spec, signal);
      children.push(child);
      return child;
    },
  };
  services.provide("app", ExtensionLauncherKey, launcher);
  const actuators = new ActuatorRegistry({ services, tools, builtins: false });
  services.provide("app", ActuatorRegistryKey, actuators);
  const sup = new Supervisor({ bus: new EventBus({ capacity: 64 }), services });
  sups.push(sup);
  services.provide("app", SupervisorKey, sup);
  await sup.register(extensionModule(), null, extensionEnabled);
  const module = new McpModule(parseMcpConfig({ reconnect_initial_ms: 50 }));
  await sup.register(module, null, true);
  await sup.startAll();
  return { sup, tools, module, children };
}

describe("a bundled MCP server follows its extension", { timeout: 40_000 }, () => {
  it("stops when the extension is disabled at runtime and comes back with it", async () => {
    const h = await start(true);
    const connected = () => h.module.status()?.server(SERVER)?.connected === true;
    await eventually(connected);
    expect(h.tools.names()).toContain(`mcp_${SERVER}_echo`);
    const first = h.children[0];
    if (!first) throw new Error("the server was not launched");

    await h.sup.disable(OWNER);
    await first.exited;
    await eventually(() => h.module.status()?.server(SERVER)?.state === "disabled");
    expect(h.tools.names()).toEqual([]);
    await sleep(200);
    expect(h.children).toHaveLength(1);

    await h.sup.enable(OWNER);
    await eventually(connected);
    expect(h.children).toHaveLength(2);
    expect(h.tools.names()).toContain(`mcp_${SERVER}_echo`);
  });

  it("waits while its extension was disabled before the module started", async () => {
    const h = await start(false);
    await sleep(300);
    expect(h.module.status()?.server(SERVER)?.state).toBe("disabled");
    expect(h.children).toHaveLength(0);
    await h.sup.enable(OWNER);
    await eventually(() => h.module.status()?.server(SERVER)?.connected === true);
  });
});
