// `SandboxModule` with the cluster backend: the code tools are withdrawn while no computer is
// ready, with the reason in the status, and offered (with `shell_run`) as soon as one is;
// `backend = "auto"` falls back to Docker on Core's machine when no computer offers the service.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { ToolRegistry } from "@miyoria/llm/tools";
import { Supervisor } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { SandboxClientKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxModule } from "../../src/module.js";
import { SandboxKey } from "../../src/types.js";
import { FakeRunner } from "../fake-runner.js";
import { FakeEndpoints, FakeMachine } from "./fake-service.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-sbx-cluster-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function app() {
  const sup = new Supervisor();
  const tools = new ToolRegistry();
  const registry = new ActuatorRegistry({ services: sup.services, tools, builtins: false });
  sup.services.provide("app", ActuatorRegistryKey, registry);
  sup.services.provide("app", SettingsStoreKey, new MemorySettingsStore());
  return { sup, registry, tools };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SandboxModule on the cluster", () => {
  it("withdraws_the_code_tools_while_no_computer_is_ready_and_says_why", async () => {
    const pc = new FakeMachine({
      host: "friend-pc",
      root: join(base, "machines"),
      ready: false,
      reason: "沙箱映像檔還沒建好:在這台執行 miyoria sandbox build",
    });
    const endpoints = new FakeEndpoints([pc]);
    const { sup, registry, tools } = app();
    await sup.register(
      new SandboxModule("p", {
        baseDir: base,
        runner: () => new FakeRunner(),
        endpoints: () => endpoints,
      }),
      { backend: "cluster" },
      true,
    );
    await sup.startAll();
    expect(sup.services.get(SandboxClientKey)).toBeDefined();
    await waitFor(async () =>
      (await registry.statusLines()).join("\n").includes("friend-pc:沙箱映像檔還沒建好"),
    );
    expect(tools.get("code_run")).toBeUndefined();
    expect(tools.get("shell_run")).toBeUndefined();
    // The workspace's own tools need no computer.
    expect(tools.get("workspace_write")).toBeDefined();

    pc.ready = true;
    endpoints.changed();
    await waitFor(() => tools.get("shell_run") !== undefined);
    expect(tools.get("code_run")).toBeDefined();
    expect(registry.get("shell.run")?.risk).toBe("medium");
    expect((await registry.statusLines()).join("\n")).toContain("沙箱電腦 friend-pc:準備好了");
    await sup.stopAll();
    expect(tools.get("shell_run")).toBeUndefined();
  });

  it("auto_uses_this_machine_s_docker_when_no_computer_offers_the_service", async () => {
    const endpoints = new FakeEndpoints([]);
    const runner = new FakeRunner();
    const { sup, tools } = app();
    await sup.register(
      new SandboxModule("p", { baseDir: base, runner: () => runner, endpoints: () => endpoints }),
      {},
      true,
    );
    await sup.startAll();
    await waitFor(() => tools.get("code_run") !== undefined);
    expect(tools.get("shell_run")).toBeUndefined();
    expect(sup.services.get(SandboxKey)?.features?.where).toBe("local");
    await sup.stopAll();
  });
});
