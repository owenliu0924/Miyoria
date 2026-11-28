// The bounds the wire shapes do not carry (`@miyoria/contracts/workers` checks types, this checks
// sizes). Everything here comes from Core, which is trusted, but a bound that is not checked here
// would be a way to use up a friend's machine if Core were ever wrong.

import type { ExecStart, JobCreate, ProcStart, SandboxLimits } from "@miyoria/contracts/workers";
import { ALLOWED_HOST } from "../config.js";
import type { SandboxPolicy } from "./policy.js";
import { MIB, ServiceError } from "./util.js";

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ENV = 32;
const MAX_ENV_VALUE = 4096;
/** Names the job's own setup sets: a request cannot move HOME or the proxy away. */
const RESERVED_ENV = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "PIP_USER",
  "NPM_CONFIG_PREFIX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
const PAYER = /^[0-9a-f]{16}$/;

function bad(message: string): ServiceError {
  return new ServiceError("bad_request", message);
}

function inRange(name: string, value: number, min: number, max: number, integer = true): void {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw bad(`${name} must be ${integer ? "an integer " : ""}from ${min} to ${max}`);
  }
}

export function checkEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const entries = Object.entries(env ?? {});
  if (entries.length > MAX_ENV) throw bad(`at most ${MAX_ENV} environment variables`);
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name))
      throw bad(`environment variable \`${name.slice(0, 64)}\` is not a valid name`);
    if (RESERVED_ENV.has(name)) throw bad(`environment variable \`${name}\` is set by the sandbox`);
    if (value.length > MAX_ENV_VALUE || value.includes("\0")) {
      throw bad(`environment variable \`${name}\` is too long or holds NUL`);
    }
  }
  return Object.fromEntries(entries);
}

/** The applied limits of a new job: checked, then lowered to what this machine allows one job. */
export function applyLimits(limits: SandboxLimits, policy: SandboxPolicy): SandboxLimits {
  inRange("limits.cpus", limits.cpus, 0.01, 256, false);
  inRange("limits.memory_mb", limits.memory_mb, 64, 1_048_576);
  inRange("limits.pids", limits.pids, 16, 65_536);
  inRange("limits.tmp_mb", limits.tmp_mb, 1, 65_536);
  inRange("limits.file_mb", limits.file_mb, 1, 1_048_576);
  inRange("limits.nofile", limits.nofile, 64, 1_048_576);
  inRange("limits.disk_mb", limits.disk_mb, 16, 4_194_304);
  const disk_mb = Math.min(limits.disk_mb, policy.disk_mb);
  return {
    ...limits,
    cpus: Math.min(limits.cpus, policy.max_job_cpus),
    memory_mb: Math.min(limits.memory_mb, policy.max_job_memory_mb),
    // /tmp is memory: never more than the job's memory.
    tmp_mb: Math.min(limits.tmp_mb, limits.memory_mb, policy.max_job_memory_mb),
    disk_mb,
    // The disk is measured every few seconds, the file size held by the kernel at every write:
    // one file is never let grow past what the whole job may hold between two measurements.
    file_mb: Math.min(limits.file_mb, disk_mb),
  };
}

/** Checks a `JobCreate` beyond its types. */
export function checkJobCreate(body: JobCreate): void {
  if (body.payer !== null && !PAYER.test(body.payer)) throw bad("payer must be 16 hex characters");
  inRange("lifetime_s", body.lifetime_s, 0, 30 * 86_400);
  inRange("idle_s", body.idle_s, 0, 30 * 86_400);
  inRange("lease_s", body.lease_s, 10, 7 * 86_400);
  if (body.label !== null && body.label.length > 200) throw bad("label is at most 200 characters");
  const net = body.network;
  if (net.allow.length > 64) throw bad("network.allow has at most 64 hosts");
  for (const host of net.allow) {
    if (!ALLOWED_HOST.test(host))
      throw bad(`network.allow: \`${host.slice(0, 80)}\` is not a host name`);
  }
  if (net.mode === "allowlist" && net.allow.length === 0) throw bad("allowlist without hosts");
  if (net.deny_ports.length > 64) throw bad("network.deny_ports has at most 64 ports");
  for (const port of net.deny_ports) inRange("network.deny_ports", port, 1, 65_535);
  inRange("network.max_connections", net.max_connections, 1, 4096);
  inRange("network.max_mb", net.max_mb, 0, 16 * 1024 * 1024);
  if (body.mounts.ext && body.kind !== "plugin") throw bad("only a plugin job mounts /ext");
  checkEnv(body.env);
}

/** Most of what one exec may carry in its body. */
export const EXEC_BOUNDS = {
  codeBytes: 1 * MIB,
  stdinBytes: 1 * MIB,
  filesBytes: 4 * MIB,
  files: 64,
  keepBytes: 1 * MIB,
  killBytes: 256 * MIB,
  streamBytes: 4 * MIB,
  collectFiles: 256,
  collectBytes: 64 * MIB,
  timeoutMs: 6 * 3_600_000,
  argv: 256,
  argBytes: 128 * 1024,
};

export function checkArgv(argv: readonly string[]): void {
  if (argv.length === 0) throw bad("argv is empty");
  if (argv.length > EXEC_BOUNDS.argv) throw bad(`argv has at most ${EXEC_BOUNDS.argv} entries`);
  for (const arg of argv) {
    if (arg.includes("\0")) throw bad("argv holds NUL");
    if (Buffer.byteLength(arg) > EXEC_BOUNDS.argBytes) throw bad("an argument is too long");
  }
}

export function checkExecStart(body: ExecStart): void {
  if ((body.program === undefined) === (body.argv === undefined)) {
    throw bad("one of program and argv");
  }
  if (body.program !== undefined) {
    if (Buffer.byteLength(body.program.code) > EXEC_BOUNDS.codeBytes) throw bad("code is too long");
  }
  if (body.argv !== undefined) checkArgv(body.argv);
  if (body.stdin !== undefined && Buffer.byteLength(body.stdin) > EXEC_BOUNDS.stdinBytes) {
    throw bad("stdin is too long");
  }
  if ((body.files?.length ?? 0) > EXEC_BOUNDS.files)
    throw bad(`at most ${EXEC_BOUNDS.files} files`);
  inRange("timeout_ms", body.timeout_ms, 100, EXEC_BOUNDS.timeoutMs);
  inRange("output.keep_bytes", body.output.keep_bytes, 256, EXEC_BOUNDS.keepBytes);
  inRange("output.kill_bytes", body.output.kill_bytes, 256, EXEC_BOUNDS.killBytes);
  inRange("output.stream_bytes", body.output.stream_bytes, 0, EXEC_BOUNDS.streamBytes);
  if (body.collect !== null) {
    inRange("collect.max_files", body.collect.max_files, 0, EXEC_BOUNDS.collectFiles);
    inRange("collect.max_bytes", body.collect.max_bytes, 0, EXEC_BOUNDS.collectBytes);
  }
  checkEnv(body.env);
}

export function checkProcStart(body: ProcStart): void {
  checkArgv(body.argv);
  checkEnv(body.env);
}
