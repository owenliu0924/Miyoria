// Core's client (`remote/`) against the real sandbox service (`service/`) in this process, over
// HTTP on loopback, with the scripted Docker of the service's tests: the protocol both sides wrote
// from the design is exercised end to end without a Docker daemon. What the "container" does is
// the test's: it reads and writes the job's real /workspace folder on the service's disk.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Endpoint, EndpointSource } from "@miyoria/runtime/kernel";
import type { WorkCap, WorkPayer, WorkQuota } from "@miyoria/types";
import { newId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "../../src/config.js";
import { HttpSandboxClient } from "../../src/remote/client.js";
import { MemorySandboxJobs } from "../../src/remote/jobs-store.js";
import { RemoteSandbox } from "../../src/remote/remote-sandbox.js";
import { ToolsWorkspace } from "../../src/workspace.js";
import { CountedWorkspace } from "../../src/workspace-totals.js";
import { result } from "../service/fake-docker.js";
import { type Harness, harness, TOKEN, tempDir, until } from "../service/helpers.js";

const MIB = 1024 * 1024;

/** Core's registry with one computer: the service on loopback. */
function loopback(url: string): EndpointSource {
  const endpoint: Endpoint = {
    capability: "sandbox",
    host: "friend-pc",
    service: "sandbox",
    url,
    via: "direct",
    headers: { authorization: `Bearer ${TOKEN}` },
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
  readonly charged: { person: string; seconds: number }[] = [];
  payerOf(): WorkPayer | null {
    return null;
  }
  capped(): WorkCap | null {
    return null;
  }
  charge(payer: WorkPayer | null, _now: number, seconds: number): void {
    if (payer !== null) this.charged.push({ person: payer.person, seconds });
  }
  claimNotice(): boolean {
    return true;
  }
  used() {
    return { hour: 0, day: 0 };
  }
  rules() {
    return { cpuSecondsPerHour: 0, cpuSecondsPerDay: 0 };
  }
}

let h: Harness | null = null;
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.reverse()) await close().catch(() => undefined);
  closers = [];
  await h?.close();
  h = null;
});

async function setup(hostToml: string) {
  h = await harness({ hostToml });
  const root = tempDir("sbx-wire-");
  const quota = new CountingQuota();
  const config = SandboxConfigSchema.parse({});
  const client = new HttpSandboxClient({
    endpoints: loopback(h.service.url),
    config,
    jobs: new MemorySandboxJobs(),
    quota: () => quota,
    pollWaitMs: 50,
  });
  const workspace = new CountedWorkspace(join(root, "workspace"), {
    maxBytes: 64 * MIB,
    maxFiles: 500,
    maxFileBytes: 8 * MIB,
  });
  const sandbox = new RemoteSandbox(config, {
    client,
    workspace,
    tools: new ToolsWorkspace(join(root, "tools"), { maxScripts: 5, maxScriptBytes: 4096 }),
    quota: () => quota,
  });
  closers.push(() => sandbox.close());
  return { sandbox, client, workspace, quota, harness: h };
}

/** The service's folder for the job a container belongs to. */
function jobFolder(hh: Harness, container: string, sub: string): string {
  const job = hh.docker.containers.get(container)?.labels["miyoria.sandbox.job"];
  if (job === undefined) throw new Error(`no job behind ${container}`);
  return join(hh.root, "state", "jobs", job, sub);
}

describe("Core's client and the sandbox service, in one process", () => {
  it("runs_a_shell_session_with_the_folder_both_ways_and_charges_the_payer", async () => {
    const { sandbox, workspace, quota, harness: hh } = await setup("members = true\n");
    await workspace.write("in.txt", "hello from core\n");
    hh.docker.onProgram = async (call, options) => {
      const ws = jobFolder(hh, call.container, "workspace");
      const seen = await readFile(join(ws, "in.txt"), "utf8");
      await mkdir(join(ws, "out"), { recursive: true });
      await writeFile(join(ws, "out", "result.txt"), "made in the job\n");
      // An edit in place, same size, in the second the file arrived: it must come back too.
      if (seen.startsWith("changed")) await writeFile(join(ws, "in.txt"), "edited by a job\n");
      hh.docker.cpuUsec += 1_500_000;
      options.onData?.("stdout", Buffer.from(seen));
      return result({ stdout: Buffer.from(`${seen}Linux\n`) });
    };
    expect((await sandbox.health({ refresh: true })).available).toBe(true);
    const first = await sandbox.run({
      language: "shell",
      code: "cat in.txt && mkdir -p out && echo made > out/result.txt && uname -s",
      session: "main",
      payer: { person: "person-amy" },
    });
    expect(first.exit_code).toBe(0);
    expect(first.stdout).toContain("hello from core");
    expect(first.session?.created).toBe(true);
    expect(first.host).toBe("friend-pc");
    // The program's file came back into Core's workspace.
    expect((await workspace.read("out/result.txt")).text).toBe("made in the job\n");
    // Core changes a file, same size, in the same second: the next run in the session sees it
    // (pushed, not sent whole).
    await workspace.write("in.txt", "changed in core\n");
    const second = await sandbox.run({
      language: "shell",
      code: "cat in.txt",
      session: "main",
      payer: { person: "person-amy" },
    });
    expect(second.session?.created).toBe(false);
    expect(second.stdout).toContain("changed in core");
    expect((await workspace.read("in.txt")).text).toBe("edited by a job\n");
    expect(hh.docker.programs[0]?.workdir).toBe("/workspace");
    await until(() => quota.charged.some((c) => c.person === "person-amy" && c.seconds > 0));
    await sandbox.closeSession("main");
    await until(async () => (await hh.call("GET", "/v1/info")).json.load.jobs === 0);
  });

  it("a_member_s_folder_does_not_go_to_a_computer_that_does_not_take_members", async () => {
    const { sandbox, workspace, harness: hh } = await setup("members = false\n");
    await workspace.write("people/amy/a.txt", "amy's");
    await sandbox.health({ refresh: true });
    await expect(
      sandbox.run({
        language: "python",
        code: "print(1)",
        mount_workspace: true,
        workspace_folder: "amy",
        payer: { person: "person-amy" },
      }),
    ).rejects.toThrow();
    expect(hh.docker.programs).toEqual([]);
    expect(hh.docker.jobRun()).toBeUndefined();
  });

  it("a_plugin_job_s_proc_carries_stdin_and_stdout_and_its_exit", async () => {
    const { client, harness: hh } = await setup("plugins = true\n");
    await until(() => client.available("plugin").ok);
    const job = await client.open({
      kind: "plugin",
      image: "default",
      for: "plugin",
      payer: null,
      network: { mode: "none" },
      lifetime_s: 0,
    });
    closers.push(() => job.close());
    const proc = await job.proc(newId().toLowerCase(), {
      argv: ["node", "/ext/index.mjs"],
      cwd: "/ext",
    });
    const spawned = hh.spawner.procs.at(-1);
    if (spawned === undefined) throw new Error("no proc spawned");
    const out: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    proc.stdin.write("ping\n");
    await until(() => Buffer.concat(spawned.received).toString("utf8") === "ping\n");
    spawned.stdout.write("pong\n");
    await until(() => Buffer.concat(out).toString("utf8") === "pong\n");
    spawned.exit(0);
    await expect(proc.exited).resolves.toMatchObject({ code: 0 });
  });
});
