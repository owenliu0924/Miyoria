// A person over their CPU seconds: not only the run being charged stops. A browser page or a
// plugin has no run to stop and would go on using a friend's computer until its idle close, so
// their jobs close; their runs elsewhere stop; other people's jobs go on.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkCap, WorkPayer, WorkQuota } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "../../src/config.js";
import { HttpSandboxClient } from "../../src/remote/client.js";
import { FakeEndpoints, FakeMachine, type Program } from "./fake-service.js";

class LimitQuota implements WorkQuota {
  readonly charged = new Map<string, number>();
  constructor(readonly limitSeconds: number) {}
  payerOf(): WorkPayer | null {
    return null;
  }
  used(person: string) {
    const hour = this.charged.get(person) ?? 0;
    return { hour, day: hour };
  }
  capped(payer: WorkPayer | null, now: number): WorkCap | null {
    if (payer === null) return null;
    const used = this.used(payer.person);
    if (used.hour < this.limitSeconds) return null;
    return { which: "hour", until: now + 60_000, first: true, limit: this.limitSeconds, used };
  }
  charge(payer: WorkPayer | null, _now: number, cpuSeconds: number): void {
    if (payer === null) return;
    this.charged.set(payer.person, (this.charged.get(payer.person) ?? 0) + cpuSeconds);
  }
  claimNotice(): boolean {
    return true;
  }
  rules() {
    return { cpuSecondsPerHour: this.limitSeconds, cpuSecondsPerDay: this.limitSeconds };
  }
}

const AMY: WorkPayer = { person: "person-amy" };
const BOB: WorkPayer = { person: "person-bob" };

let root: string;
let client: HttpSandboxClient | null = null;

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-cpucap-"));
});

afterEach(() => {
  client?.close();
  client = null;
  rmSync(root, { recursive: true, force: true });
});

describe("a person over their CPU seconds", () => {
  it("has their browser and plugin jobs closed and their runs stopped, and nobody else's", async () => {
    // Every run waits until Core stops it, and says why.
    const program: Program = async (exec) => ({ stdout: await exec.stopped });
    const pc = new FakeMachine({ host: "pc", root, program });
    let skew = 0;
    const quota = new LimitQuota(1);
    client = new HttpSandboxClient({
      endpoints: new FakeEndpoints([pc]),
      config: SandboxConfigSchema.parse({}),
      clock: { now: () => Date.now() + skew },
      quota: () => quota,
      pollWaitMs: 50,
    });
    const open = (kind: "run" | "browser" | "plugin", payer: WorkPayer) =>
      (client as HttpSandboxClient).open({ kind, image: "default", for: "member", payer });
    const amyBrowser = await open("browser", AMY);
    const amyPlugin = await open("plugin", AMY);
    const amyRun = await open("run", AMY);
    const bobBrowser = await open("browser", BOB);
    const bobRun = await open("run", BOB);

    const amyExec = amyRun.exec({ program: { language: "shell", code: "x" }, timeout_ms: 30_000 });
    const bobExec = bobRun.exec({ program: { language: "shell", code: "x" }, timeout_ms: 30_000 });
    await waitFor(() => amyRun.busy && bobRun.busy && pc.jobs.get(amyRun.id)?.execs.size === 1);

    // Ten seconds later her browser page has used five CPU seconds (on its 2 CPUs).
    skew += 10_000;
    pc.emit({ job: amyBrowser.id, kind: "cpu", cpu_ms: 5000 });

    expect(await amyBrowser.ended).toEqual({ reason: "quota" });
    expect(await amyPlugin.ended).toEqual({ reason: "quota" });
    expect((await amyExec).killed_reason).toBe("quota");
    // The computer was told to close them, not left to its idle time.
    await waitFor(() => pc.jobs.get(amyPlugin.id)?.view.ended !== null);
    expect(pc.jobs.get(amyBrowser.id)?.view.ended?.reason).toBe("closed");

    expect(bobBrowser.endedReason).toBeNull();
    expect(amyRun.endedReason).toBeNull();
    expect(bobRun.busy).toBe(true);
    await bobRun.close();
    expect((await bobExec).killed_reason).toBe("lost");
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
