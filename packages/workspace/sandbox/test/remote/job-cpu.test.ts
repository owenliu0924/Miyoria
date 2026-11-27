// What a `RemoteJob` charges its payer from the CPU totals its computer reports. The computer is
// someone else's: a total that is no number, or one far past what the job's CPUs could have used
// since the last charge, must not lock the person out of their CPU seconds.

import type { JobView, SandboxEvent } from "@miyoria/contracts/workers";
import type { Endpoint, EndpointSource } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { type JobLink, RemoteJob } from "../../src/remote/job.js";

const ENDPOINT: Endpoint = {
  capability: "sandbox",
  host: "pc",
  service: "sandbox",
  url: "http://pc.test:1",
  via: "direct",
  headers: {},
  healthy: true,
  version: "test",
};

const NOWHERE: EndpointSource = {
  pick: () => ENDPOINT,
  candidates: () => [ENDPOINT],
  failed: () => undefined,
  watch: () => () => undefined,
  request: async () => {
    throw new Error("no requests in this test");
  },
};

const JOB_ID = "01jcputestjob0000000000000";

function view(cpus: number): JobView {
  return {
    id: JOB_ID,
    kind: "run",
    state: "ready",
    ended: null,
    image_tag: "miyoria/sandbox:1-test",
    limits: {
      cpus,
      memory_mb: 512,
      pids: 128,
      tmp_mb: 64,
      file_mb: 16,
      nofile: 256,
      disk_mb: 1024,
    },
    created_at: 0,
    last_used_at: 0,
    expires_at: 0,
    usage: {
      cpu_ms: 0,
      cpu_source: "cgroup",
      wall_ms: 0,
      disk_bytes: 0,
      egress: {
        bytes_in: 0,
        bytes_out: 0,
        connections: 0,
        refused: { address: 0, port: 0, cap: 0 },
      },
    },
    exec: null,
    procs: [],
  };
}

function jobWith(o: { told: number; asked?: number }) {
  let now = 1_000_000;
  const charges: number[] = [];
  const link: JobLink = {
    source: NOWHERE,
    endpoint: () => ENDPOINT,
    clock: { now: () => now },
    partBytes: 1024,
    maxTransferBytes: 1024,
    output: { keep_bytes: 1024, kill_bytes: 4096, stream_bytes: 1024 },
    collect: { max_files: 1, max_bytes: 1024 },
    charge: (_job, deltaMs) => charges.push(deltaMs),
    ended: () => undefined,
  };
  const job = new RemoteJob(view(o.told), {
    host: "pc",
    service: "sandbox",
    payer: { person: "person-amy" },
    link,
    ...(o.asked === undefined ? {} : { cpus: o.asked }),
  });
  const cpu = (cpu_ms: number) =>
    job.handle({ seq: 1, job: JOB_ID, kind: "cpu", cpu_ms } as SandboxEvent);
  const total = () => charges.reduce((n, c) => n + c, 0);
  return {
    job,
    cpu,
    total,
    charges,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CPU charges", () => {
  it("charge what the job's CPUs could use in the wall time since the last charge, no more", () => {
    const j = jobWith({ told: 2 });
    j.advance(1000);
    j.cpu(1e12);
    expect(j.total()).toBe(2000);
  });

  it("carry the rest of an honest late report over to the next charges", () => {
    const j = jobWith({ told: 2 });
    j.advance(1000);
    j.cpu(2000);
    j.advance(500);
    j.cpu(5000);
    expect(j.total()).toBe(3000);
    j.advance(1500);
    j.cpu(5000);
    expect(j.total()).toBe(5000);
    expect(j.job.charged).toBe(5000);
  });

  it("take nothing from a total that is no finite non-negative number", () => {
    const j = jobWith({ told: 2 });
    j.advance(1000);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) j.cpu(bad);
    expect(j.charges).toEqual([]);
    j.cpu(300);
    expect(j.total()).toBe(300);
  });

  it("use the CPUs Core asked for when the computer claims more", () => {
    const j = jobWith({ told: 1e9, asked: 2 });
    j.advance(1000);
    j.cpu(1e12);
    expect(j.total()).toBe(2000);
  });

  it("hold the end of a job to the same bound", () => {
    const j = jobWith({ told: 2 });
    j.advance(100);
    j.job.handle({
      seq: 2,
      job: JOB_ID,
      kind: "ended",
      reason: "closed",
      usage: { ...view(2).usage, cpu_ms: 1e15 },
    } as SandboxEvent);
    expect(j.total()).toBe(200);
  });
});
