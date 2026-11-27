import type { Readable, Writable } from "node:stream";
import { serviceKey } from "./service-key.js";
import type { WorkPayer } from "./work-quota.js";

// What the rest of the system sees of the computers that run sandbox jobs
// (docs/design/v6-sandbox.md, docs/design/v6-agent-split.md §3.3). `RemoteSandbox` and
// `HttpSandboxClient` in `@miyoria/workspace/sandbox` implement it; the browser and the extension
// launcher are written against it.

/** Whom a job is for; a computer's owner decides which of these it takes. */
export type SandboxFor = "self" | "owner" | "member" | "plugin";
export type SandboxJobKind = "run" | "session" | "browser" | "plugin";

export interface SandboxJobSpec {
  kind: SandboxJobKind;
  image: "default" | "browser";
  for: SandboxFor;
  payer: WorkPayer | null;
  /** A session's name, a plugin's id; for people to read. */
  label?: string | null;
  /** What is not given follows the `[modules.sandbox]` defaults. */
  limits?: Partial<{
    cpus: number;
    memory_mb: number;
    pids: number;
    tmp_mb: number;
    file_mb: number;
    disk_mb: number;
    nofile: number;
  }>;
  network?: { mode: "open" | "allowlist" | "none"; allow?: string[] };
  lifetime_s?: number;
  idle_s?: number;
  mounts?: { tools?: boolean; ext?: boolean };
  env?: Record<string, string>;
  /** Only these computers (a plugin with secrets); not given: any. */
  hosts?: readonly string[];
}

export interface SandboxExecStart {
  program?: { language: "python" | "node" | "shell"; code: string };
  argv?: string[];
  stdin?: string;
  files?: { path: string; content: string; encoding?: "utf8" | "base64" }[];
  cwd?: "/work" | "/workspace";
  timeout_ms: number;
  env?: Record<string, string>;
  collectFiles?: boolean;
}

export interface SandboxExecResult {
  exit_code: number | null;
  killed_reason:
    | "timeout"
    | "aborted"
    | "output_limit"
    | "memory"
    | "quota"
    | "disk"
    | "lost"
    | null;
  duration_ms: number;
  cpu_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  files_out: { path: string; size: number; encoding: "utf8" | "base64"; content: string }[];
  files_out_truncated: boolean;
  /** The whole output (useful when it is longer than stdout and stderr). */
  log(): Promise<string>;
}

export interface SandboxProc {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): Promise<void>;
}

export interface SandboxJob {
  readonly id: string;
  /** Which computer. */
  readonly host: string;
  readonly kind: SandboxJobKind;
  /** Sends a folder from Core into the job (tar, in parts). */
  upload(
    target: "workspace" | "tools" | "ext" | "work",
    source: { dir: string; skip?: (relativePath: string) => boolean },
    options?: { replace?: boolean; signal?: AbortSignal },
  ): Promise<{ files: number; bytes: number; skipped: { path: string; why: string }[] }>;
  /** One run; only one at a time in a job, the others wait in Core. */
  exec(
    start: SandboxExecStart,
    options?: {
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", text: string) => void;
    },
  ): Promise<SandboxExecResult>;
  /** A background process (only in `browser` and `plugin` jobs). */
  proc(
    id: string,
    start: {
      argv: string[];
      cwd?: "/work" | "/workspace" | "/ext";
      env?: Record<string, string>;
    },
  ): Promise<SandboxProc>;
  usage(): Promise<{ cpu_ms: number; wall_ms: number; disk_bytes: number }>;
  close(): Promise<void>;
  /** Resolves when the job is over, also when it was closed or lost. */
  readonly ended: Promise<{ reason: string }>;
}

export interface SandboxClient {
  /** Whether a computer takes a job for `forWho` now; if not, which kind of no, and a sentence she can pass on. */
  available(
    forWho: SandboxFor,
  ): { ok: true } | { ok: false; code: "no_machine" | "not_accepting" | "busy"; reason: string };
  open(spec: SandboxJobSpec, options?: { signal?: AbortSignal }): Promise<SandboxJob>;
  /** The computers that can be used changed. */
  watch(onChange: () => void): () => void;
}

export const SandboxClientKey = serviceKey<SandboxClient>("SandboxClient");
