// The sandbox service's bodies (docs/design/v6-sandbox.md §3.3): an example of each parses and
// survives a round trip, and the leniency an older peer relies on.

import { describe, expect, it } from "vitest";
import {
  EventsPageSchema,
  ExecResultSchema,
  ExecStartSchema,
  JobCreateSchema,
  JobViewSchema,
  SANDBOX_ERROR_STATUS,
  SandboxErrorBodySchema,
  SandboxErrorCodeSchema,
  SandboxEventSchema,
  SandboxInfoSchema,
  SyncResultSchema,
  UploadCommitSchema,
} from "../src/index.js";

const usage = {
  cpu_ms: 1200,
  cpu_source: "cgroup",
  wall_ms: 3000,
  disk_bytes: 4096,
  egress: {
    bytes_in: 10,
    bytes_out: 20,
    connections: 2,
    refused: { address: 0, port: 1, cap: 0 },
  },
};
const limits = {
  cpus: 2,
  memory_mb: 2048,
  pids: 512,
  tmp_mb: 512,
  file_mb: 256,
  nofile: 4096,
  disk_mb: 2048,
};
const result = {
  exit_code: 0,
  killed_reason: null,
  duration_ms: 40,
  cpu_ms: 30,
  stdout: "hi\n",
  stderr: "",
  stdout_truncated: false,
  stderr_truncated: false,
  stdout_bytes: 3,
  stderr_bytes: 0,
  files_out: [{ path: "out.txt", size: 2, encoding: "utf8", content: "ok" }],
  files_out_truncated: false,
  log_bytes: 3,
};

function roundTrips(schema: { parse(value: unknown): unknown }, example: unknown): void {
  const first = schema.parse(example);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
}

describe("sandbox bodies", () => {
  it("parse_an_example_of_each_and_round_trip", () => {
    roundTrips(SandboxInfoSchema, {
      api: 1,
      service_version: "0.1.0",
      boot: "b1",
      platform: "linux",
      arch: "x64",
      docker: { available: true, server_version: "27.0", error: null, cgroup: "v2", runtime: null },
      images: {
        default: { tag: "miyoria-sandbox:1", present: true, building: false, stale: false },
        browser: {
          tag: "miyoria-sandbox-browser:1",
          present: false,
          building: false,
          stale: false,
        },
      },
      ready: true,
      policy: {
        members: false,
        plugins: false,
        cpus: 4,
        memory_mb: 8192,
        disk_mb: 20480,
        max_job_cpus: 2,
        max_job_memory_mb: 4096,
      },
      load: { jobs: 1, running: 0, queued: 0, cpus: 2, memory_mb: 2048, disk_mb: 2048 },
    });
    roundTrips(JobCreateSchema, {
      kind: "session",
      image: "default",
      for: "owner",
      payer: "0123456789abcdef",
      limits,
      network: {
        mode: "open",
        allow: [],
        deny_ports: [25, 465, 587],
        max_connections: 64,
        max_mb: 4096,
      },
      lifetime_s: 7200,
      idle_s: 900,
      lease_s: 600,
      mounts: { tools: true, ext: false },
      env: { LANG: "C.UTF-8" },
      label: "analysis",
    });
    roundTrips(JobViewSchema, {
      id: "01hzzzzzzzzzzzzzzzzzzzzzzz",
      kind: "run",
      state: "ready",
      ended: null,
      image_tag: "miyoria-sandbox:1",
      limits,
      created_at: 1,
      last_used_at: 2,
      expires_at: 3,
      usage,
      exec: null,
      procs: [],
    });
    roundTrips(UploadCommitSchema, {
      parts: 1,
      bytes: 10,
      sha256: "ab",
      format: "tar.gz",
      target: "workspace",
      replace: true,
      manifest: [{ path: "a.txt", size: 1, sha256: "cd", mtime_ms: 1000 }],
    });
    roundTrips(ExecResultSchema, result);
    roundTrips(SyncResultSchema, { changed: [], deleted: ["x"], skipped: [], tar: null });
    roundTrips(SandboxErrorBodySchema, {
      error: { code: "busy", message: "full", retry_after_ms: 1000 },
    });
  });

  it("reads_every_kind_of_event_and_refuses_an_unknown_one", () => {
    const events = [
      { seq: 1, job: "j", kind: "state", state: "busy" },
      { seq: 2, job: "j", kind: "cpu", cpu_ms: 5 },
      { seq: 3, job: "j", exec: "e", kind: "stdout", text: "x" },
      { seq: 4, job: "j", exec: "e", kind: "exit", result },
      { seq: 5, job: "j", proc: "p", kind: "proc_out", stream: "stdout", offset: 0, data_b64: "" },
      { seq: 6, job: "j", proc: "p", kind: "proc_exit", code: null, signal: "SIGKILL" },
      { seq: 7, job: "j", kind: "ended", reason: "lease", usage },
    ];
    for (const event of events) expect(SandboxEventSchema.parse(event)).toEqual(event);
    expect(SandboxEventSchema.safeParse({ seq: 8, job: "j", kind: "nope" }).success).toBe(false);
    expect(EventsPageSchema.parse({ cursor: "b:7", events, reset: false }).events).toHaveLength(7);
  });

  it("gives_an_exec_with_no_collect_the_default_and_keeps_the_rest", () => {
    const start = ExecStartSchema.parse({
      program: { language: "shell", code: "ls" },
      timeout_ms: 1000,
      output: { keep_bytes: 1, kill_bytes: 2, stream_bytes: 3 },
    });
    expect(start.collect).toBeNull();
    expect(start.program?.language).toBe("shell");
  });

  it("has_a_status_for_every_error_code", () => {
    for (const code of SandboxErrorCodeSchema.options) {
      expect(SANDBOX_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
    expect(SANDBOX_ERROR_STATUS.busy).toBe(429);
    expect(SANDBOX_ERROR_STATUS.gone).toBe(410);
  });
});
