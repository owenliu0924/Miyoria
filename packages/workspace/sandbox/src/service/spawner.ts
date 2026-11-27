// A Docker CLI process that stays open: a proc's `docker exec -i`, whose stdin and stdout are the
// channel (docs/design/v6-sandbox.md §3.7). `DockerRunner` runs a call to its end; this keeps it.
// Same rules: no shell, the filtered environment of `dockerCliEnv`.

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { dockerCliEnv } from "../args.js";

export interface SpawnedProc {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(): void;
}

export interface ProcSpawner {
  spawn(args: readonly string[]): SpawnedProc;
}

export class ProcessSpawner implements ProcSpawner {
  constructor(
    readonly executable: string,
    readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  spawn(args: readonly string[]): SpawnedProc {
    const child = spawn(this.executable, [...args], {
      shell: false,
      windowsHide: true,
      env: dockerCliEnv(this.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("error", () => resolve({ code: null, signal: "spawn" }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      kill: () => {
        child.kill("SIGKILL");
      },
    };
  }
}
