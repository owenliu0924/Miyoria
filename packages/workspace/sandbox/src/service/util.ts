// Small pieces every part of the sandbox service uses: the error that becomes an HTTP answer, ids,
// the hash that tells a resent request from a different one, and the Docker CLI calls that are
// not a program's run.

import { createHash } from "node:crypto";
import type { SandboxEndReason, SandboxErrorCode } from "@miyoria/contracts/workers";
import { getLogger } from "@miyoria/runtime/kernel";
import type { DockerRunner, ExecResult } from "../runner.js";

export const log = getLogger("sandbox.service");

export const MIB = 1024 * 1024;

/** Ids are Core's ULIDs, lower case (docs/design/v6-sandbox.md §3.1). */
export const ID = /^[0-9a-z]{26}$/;

/** A refusal with its wire code; the server turns it into `SandboxErrorBody`. */
export class ServiceError extends Error {
  override readonly name = "ServiceError";
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
    readonly extra: {
      retry_after_ms?: number;
      ended?: { reason: SandboxEndReason; at: number };
      reason?: string;
    } = {},
  ) {
    super(message);
  }
}

/** JSON with sorted keys: the same request sent twice hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function decode(data: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

/** First line of a failed Docker call. */
export function why(result: ExecResult): string {
  return (
    result.error ??
    (decode(result.stderr).trim().split("\n")[0] || `docker exited ${result.exit_code}`)
  ).slice(0, 300);
}

export function succeeded(result: ExecResult): boolean {
  return result.error === null && result.exit_code === 0;
}

/** Timeout of small Docker CLI calls (version, inspect, rm, network, pause). */
export const CONTROL_TIMEOUT_MS = 15_000;
/** Timeout of `docker run -d`. */
export const START_TIMEOUT_MS = 60_000;
const CONTROL_OUTPUT_BYTES = 64 * 1024;

/** The Docker CLI calls that are not a program: bounded in time and output. */
export class DockerControl {
  constructor(readonly runner: DockerRunner) {}

  run(
    args: readonly string[],
    options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number } = {},
  ): Promise<ExecResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? CONTROL_TIMEOUT_MS);
    return this.runner
      .exec(args, {
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        maxOutputBytes: options.maxOutputBytes ?? CONTROL_OUTPUT_BYTES,
      })
      .catch(
        (error: unknown): ExecResult => ({
          exit_code: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdout_bytes: 0,
          stderr_bytes: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /** `run`, and its stdout when it worked; `null` otherwise. */
  async text(args: readonly string[], options?: { timeoutMs?: number }): Promise<string | null> {
    const result = await this.run(args, options);
    return succeeded(result) ? decode(result.stdout) : null;
  }
}
