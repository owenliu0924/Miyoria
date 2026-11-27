// Core's side against the real sandbox service on real Docker (docs/design/v6-sandbox.md §14):
// a session runs a shell, the folder goes in and the program's file comes back, the CPU is
// charged, the job closes.
//
// What it needs, and skips without:
// - Docker answering (`docker version`), as `docker.integration.test.ts`; CI's Linux has it.
// - The service of `packages/workspace/sandbox/src/service/` (work package P2) exporting
//   `startSandboxService`. Until it is there this file skips.
// - The sandbox image built on this machine (`miyoria sandbox build`), and
//   `MIYORIA_SANDBOX_IMAGE_TESTS=1`: the service refuses jobs while its image is missing.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Endpoint, EndpointSource } from "@miyoria/runtime/kernel";
import type { WorkCap, WorkPayer, WorkQuota } from "@miyoria/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "../../src/config.js";
import { HttpSandboxClient } from "../../src/remote/client.js";
import { MemorySandboxJobs } from "../../src/remote/jobs-store.js";
import { RemoteSandbox } from "../../src/remote/remote-sandbox.js";
import { ToolsWorkspace } from "../../src/workspace.js";
import { CountedWorkspace } from "../../src/workspace-totals.js";

function dockerAvailable(): boolean {
  if (process.env.MIYORIA_SKIP_DOCKER_TESTS === "1") return false;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

type Start = (options: Record<string, unknown>) => Promise<{ url: string; close(): Promise<void> }>;

/** P2's service, once it exists. */
const service = (await import("../../src/service/index.js")) as unknown as {
  startSandboxService?: Start;
};
const start = service.startSandboxService;
const enabled =
  typeof start === "function" &&
  process.env.MIYORIA_SANDBOX_IMAGE_TESTS === "1" &&
  dockerAvailable();

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

class CountingQuota implements WorkQuota {
  seconds = 0;
  payerOf(): WorkPayer | null {
    return null;
  }
  capped(): WorkCap | null {
    return null;
  }
  charge(_payer: WorkPayer | null, _now: number, s: number): void {
    this.seconds += s;
  }
  claimNotice(): boolean {
    return true;
  }
  used() {
    return { hour: this.seconds, day: this.seconds };
  }
  rules() {
    return { cpuSecondsPerHour: 0, cpuSecondsPerDay: 0 };
  }
}

describe.skipIf(!enabled)("the sandbox service on real Docker (needs P2's service)", () => {
  let root: string;
  let running: { url: string; close(): Promise<void> };
  let sandbox: RemoteSandbox;
  const quota = new CountingQuota();

  beforeAll(async () => {
    root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-sbx-e2e-"));
    const hostToml = join(root, "host.toml");
    writeFileSync(hostToml, "[sandbox]\nmembers = true\n");
    const token = "e2e-token";
    running = await (start as Start)({
      host: "127.0.0.1",
      port: 0,
      hostToml,
      state: join(root, "state"),
      imageDir: resolve(import.meta.dirname, "../../../../../workers/sandbox/image"),
      token,
      hostToken: null,
    });
    const config = SandboxConfigSchema.parse({});
    const client = new HttpSandboxClient({
      endpoints: loopback(running.url, token),
      config,
      jobs: new MemorySandboxJobs(),
      quota: () => quota,
    });
    sandbox = new RemoteSandbox(config, {
      client,
      workspace: new CountedWorkspace(join(root, "workspace"), {
        maxBytes: 256 * 1024 * 1024,
        maxFiles: 2000,
        maxFileBytes: 64 * 1024 * 1024,
      }),
      tools: new ToolsWorkspace(join(root, "tools"), { maxScripts: 5, maxScriptBytes: 65536 }),
      quota: () => quota,
    });
  }, 120_000);

  afterAll(async () => {
    await sandbox?.closeSession("main").catch(() => undefined);
    await sandbox?.close();
    await running?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs_a_shell_session_with_the_folder_both_ways", async () => {
    expect((await sandbox.health({ refresh: true })).available).toBe(true);
    await sandbox.workspace?.write("in.txt", "hello from core\n");
    const first = await sandbox.run({
      language: "shell",
      code: "cat in.txt && python3 -c 'print(sum(range(10**6)))' > out.txt && uname -s",
      session: "main",
      payer: { person: "person-e2e" },
    });
    expect(first.exit_code).toBe(0);
    expect(first.stdout).toContain("hello from core");
    expect(first.stdout).toContain("Linux");
    expect((await sandbox.workspace?.read("out.txt"))?.text.trim()).toBe("499999500000");
    const second = await sandbox.run({
      language: "shell",
      code: "ls /workspace",
      session: "main",
      payer: { person: "person-e2e" },
    });
    expect(second.session?.created).toBe(false);
    expect(second.stdout).toContain("out.txt");
    expect(quota.seconds).toBeGreaterThan(0);
  }, 300_000);
});
