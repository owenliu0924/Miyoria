// How long Core keeps a computer's `/v1/info`: a minute when it was ready, a few seconds when it
// was not (a service asked while it still looked at Docker is ready moments later).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "../../src/config.js";
import { HttpSandboxClient, NOT_READY_TTL_MS } from "../../src/remote/client.js";
import { FakeEndpoints, FakeMachine } from "./fake-service.js";

const roots: string[] = [];
const clients: HttpSandboxClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(ready: boolean) {
  const root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "sbx-ttl-"));
  roots.push(root);
  const machine = new FakeMachine({ host: "friend-pc", root, ready });
  const now = { t: 1_800_000_000_000 };
  const client = new HttpSandboxClient({
    endpoints: new FakeEndpoints([machine]),
    config: SandboxConfigSchema.parse({}),
    clock: { now: () => now.t },
  });
  clients.push(client);
  return { machine, client, now };
}

describe("the copy of a computer's info", () => {
  it("is asked again a few seconds after a not-ready answer", async () => {
    const { machine, client, now } = setup(false);
    await client.refresh();
    expect(client.available("self").ok).toBe(false);
    machine.ready = true;
    now.t += NOT_READY_TTL_MS - 1;
    await client.refresh();
    expect(client.available("self").ok).toBe(false);
    now.t += 2;
    await client.refresh();
    expect(client.available("self")).toEqual({ ok: true });
  });

  it("keeps a ready answer for the minute", async () => {
    const { machine, client, now } = setup(true);
    await client.refresh();
    machine.ready = false;
    now.t += 30_000;
    await client.refresh();
    expect(client.available("self")).toEqual({ ok: true });
  });
});
