// An extension in a real sandbox job: the fixture extension's folder goes to the sandbox service
// on real Docker, its program runs there as a proc, it registers its tools over the proc's
// channel and one of them is called (docs/design/v6-agent-split.md §2 P8).
//
// What it needs, and skips without:
// - Docker answering (`docker version`), as `packages/workspace/sandbox/test/docker.integration.test.ts`;
//   CI's Linux has it.
// - The sandbox service of work package P2 (`packages/workspace/sandbox/src/service/`) exporting
//   `startSandboxService`, with `procs` and `plugin` jobs, and P3's `HttpSandboxClient`.
// - The sandbox image built on this machine (`miyoria sandbox build`), and
//   `MIYORIA_SANDBOX_IMAGE_TESTS=1`: the service refuses jobs while its image is missing.
//
// The service and the client are loaded by path at run time: `@miyoria/plugin-host` does not
// depend on `@miyoria/workspace`, and this keeps their sources out of this package's typecheck.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
  type Endpoint,
  type EndpointSource,
  EventBus,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import { AuthorizerKey, BaseAuthorizer, Principals, type SandboxClient } from "@miyoria/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, ExtensionLauncherKey } from "../src/index.js";
import { type SandboxLauncher, sandboxLauncher } from "../src/sandbox-launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SANDBOX = resolve(HERE, "../../../workspace/sandbox/src");
const EXT = "ext.test.fixture";

function dockerAvailable(): boolean {
  if (process.env.MIYORIA_SKIP_DOCKER_TESTS === "1") return false;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

/** A module of the sandbox package by its path, or `null` when it is not there. */
async function load(path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(pathToFileURL(join(SANDBOX, path)).href)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type Start = (options: Record<string, unknown>) => Promise<{ url: string; close(): Promise<void> }>;

const wanted = process.env.MIYORIA_SANDBOX_IMAGE_TESTS === "1" && dockerAvailable();
const service = wanted ? await load("service/index.ts") : null;
const remote = wanted ? await load("remote/client.ts") : null;
const config = wanted ? await load("config.ts") : null;
const jobsStore = wanted ? await load("remote/jobs-store.ts") : null;
const enabled =
  typeof service?.startSandboxService === "function" &&
  typeof remote?.HttpSandboxClient === "function" &&
  config?.SandboxConfigSchema !== undefined;

/** Core's registry with one computer: the service on loopback, called directly. */
function loopback(url: string, token: string): EndpointSource {
  const endpoint: Endpoint = {
    capability: "sandbox",
    host: "this-pc",
    service: "sandbox",
    url,
    via: "direct",
    headers: { authorization: `Bearer ${token}` },
    healthy: true,
    version: null,
  };
  return {
    pick: () => endpoint,
    candidates: () => [endpoint],
    failed: () => {},
    request: (e, path, init = {}) =>
      fetch(new URL(path, e.url), {
        ...init,
        headers: { ...e.headers, ...Object.fromEntries(new Headers(init.headers)) },
      }),
    watch: () => () => {},
  };
}

class AllowAll extends BaseAuthorizer {
  allowsSubject(): boolean {
    return true;
  }
}

async function eventually(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error("condition not met in time");
}

describe.skipIf(!enabled)("an extension in a sandbox on real Docker (needs P2's service)", () => {
  let root: string;
  let running: { url: string; close(): Promise<void> };
  let client: SandboxClient & { close?: () => unknown };
  let launcher: SandboxLauncher;
  let sup: Supervisor;
  let actuators: ActuatorRegistry;

  beforeAll(async () => {
    root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-ext-sbx-"));
    const hostToml = join(root, "host.toml");
    writeFileSync(hostToml, "[sandbox]\nplugins = true\n");
    const token = "e2e-token";
    const startService = service?.startSandboxService as Start;
    running = await startService({
      host: "127.0.0.1",
      port: 0,
      hostToml,
      state: join(root, "state"),
      imageDir: resolve(HERE, "../../../../workers/sandbox/image"),
      token,
      hostToken: null,
    });
    const Client = remote?.HttpSandboxClient as new (o: Record<string, unknown>) => SandboxClient;
    const Jobs = jobsStore?.MemorySandboxJobs as (new () => unknown) | undefined;
    const schema = config?.SandboxConfigSchema as { parse(v: unknown): unknown };
    client = new Client({
      endpoints: loopback(running.url, token),
      config: schema.parse({}),
      ...(Jobs ? { jobs: new Jobs() } : {}),
    });
    launcher = sandboxLauncher({ client, trustedHosts: [], coreHost: "this-pc", fallback: "fail" });

    const app = Config.fromToml(
      `[modules.extensions]\ndirs = [${JSON.stringify(join(FIXTURES, "test-ext"))}]\ninit_timeout_ms = 60000\ncall_timeout_ms = 30000\n`,
    );
    const services = new ServiceRegistry();
    const tools = new ToolRegistry();
    sup = new Supervisor({ bus: new EventBus(), services });
    services.provide("app", ToolRegistryKey, tools);
    services.provide("app", AuthorizerKey, new AllowAll());
    services.provide("app", SupervisorKey, sup);
    actuators = new ActuatorRegistry({ services, tools, builtins: false });
    services.provide("app", ActuatorRegistryKey, actuators);
    services.provide("app", ExtensionLauncherKey, launcher);
    for (const m of discover(app, FIXTURES).modules) {
      await sup.register(m.module, m.config, m.enabled);
    }
  }, 180_000);

  afterAll(async () => {
    await sup?.stopAll();
    launcher?.close();
    await client?.close?.();
    await running?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers its tools from the job and answers a call", async () => {
    await sup.startAll();
    await eventually(() => sup.list().find((m) => m.id === EXT)?.state === "running", 120_000);
    expect(launcher.placement("test.fixture")).toMatchObject({ kind: "sandbox", host: "this-pc" });
    const out = await actuators.invoke({
      principal: Principals.self(null),
      capability: "ext.test.fixture.echo.say",
      args: { text: "from a job" },
      why: null,
      turn: null,
    });
    expect(out.status === "done" && out.result.text).toContain("echo: from a job from self");
    await sup.disable(EXT);
    expect(launcher.placement("test.fixture")).toBeNull();
  }, 240_000);
});
