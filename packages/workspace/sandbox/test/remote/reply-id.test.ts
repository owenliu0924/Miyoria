// A computer that answers for another job than the one Core asked about: its reply is not taken
// (Core would otherwise poll, charge and close a job id the computer chose).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "../../src/config.js";
import { HttpSandboxClient } from "../../src/remote/client.js";
import { FakeEndpoints, FakeMachine } from "./fake-service.js";

const OTHER_ID = "01otherjob0000000000000000";

/** Answers a job's `PUT` or `GET` with the view of a job of another id. */
class LyingMachine extends FakeMachine {
  lie = true;

  override async handle(
    method: string,
    url: URL,
    body: Buffer,
    headers: Headers,
  ): Promise<Response> {
    const response = await super.handle(method, url, body, headers);
    if (!this.lie || !/^\/v1\/jobs\/[0-9a-z]{26}$/.test(url.pathname) || method === "DELETE") {
      return response;
    }
    const view = (await response.json()) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ ...view, id: OTHER_ID, ended: { reason: "lost", at: 1 } }),
      { status: response.status, headers: { "content-type": "application/json" } },
    );
  }
}

let root: string;
let client: HttpSandboxClient | null = null;

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-replyid-"));
});

afterEach(() => {
  client?.close();
  client = null;
  rmSync(root, { recursive: true, force: true });
});

function clientOn(machines: FakeMachine[]): HttpSandboxClient {
  client = new HttpSandboxClient({
    endpoints: new FakeEndpoints(machines),
    config: SandboxConfigSchema.parse({}),
    pollWaitMs: 50,
  });
  return client;
}

describe("a reply for another job", () => {
  it("is refused when a job opens: the next computer takes it and the first is told to drop it", async () => {
    const liar = new LyingMachine({ host: "liar-pc", root });
    const good = new FakeMachine({ host: "good-pc", root });
    const c = clientOn([liar, good]);
    const job = await c.open({ kind: "run", image: "default", for: "self", payer: null });
    expect(job.host).toBe("good-pc");
    expect(job.id).not.toBe(OTHER_ID);
    const created = [...liar.jobs.keys()];
    expect(created).toHaveLength(1);
    expect(liar.calls).toContain(`DELETE /v1/jobs/${created[0]}`);
    await job.close();
  });

  it("is not taken when an open job is read again", async () => {
    const pc = new LyingMachine({ host: "pc", root });
    pc.lie = false;
    const c = clientOn([pc]);
    const job = await c.open({ kind: "session", image: "default", for: "self", payer: null });
    pc.lie = true;
    await job.refresh();
    // The other job's `ended` is not this one's.
    expect(job.endedReason).toBeNull();
    expect(job.view.id).toBe(job.id);
    pc.lie = false;
    await job.close();
  });
});
