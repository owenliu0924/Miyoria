// How the sandbox talks to Docker: one CLI invocation per call, as an argument array. Tests
// inject a fake `DockerRunner`; the real one spawns the CLI without a shell.

import { spawn } from "node:child_process";
import { errorMessage } from "@miyoria/runtime/kernel";
import { dockerCliEnv } from "./args.js";

export interface ExecOptions {
  /** Written to the process's stdin, which is then closed. */
  stdin?: string | null;
  /**
   * Instead of `stdin`: written once it resolves (a pooled container waits for it), then stdin
   * is closed; `null` just closes it.
   */
  stdinLater?: Promise<string | null>;
  /** Sees each chunk of output as it arrives (before the caps). */
  onData?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  /** Kills the CLI process (not the container: the sandbox does that by name). */
  signal?: AbortSignal;
  /** Bytes of stdout and of stderr kept; the rest is counted and dropped. */
  maxOutputBytes: number;
  /** Called once when stdout + stderr pass this many bytes. */
  outputLimit?: { bytes: number; onExceeded: () => void };
}

export interface ExecResult {
  /** `null` when the process did not exit normally (killed, or never started). */
  exit_code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Total bytes seen, including the dropped ones. */
  stdout_bytes: number;
  stderr_bytes: number;
  /** Spawn failure (e.g. the executable is missing), else `null`. */
  error: string | null;
}

/** Runs the Docker CLI. */
export interface DockerRunner {
  exec(args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

/** Room kept for the line that marks what was left out between the head and the tail. */
const GAP_MARK_BYTES = 64;

/**
 * Keeps at most `limit` bytes of a stream and counts the rest: all of it when it fits, else its
 * head and its tail with a marked gap between them. The tail is where a build or a test says what
 * failed, so cutting only the end would drop the part that was wanted.
 */
export class Capped {
  readonly #head: Buffer[] = [];
  #headBytes = 0;
  readonly #tail: Buffer[] = [];
  #tailBytes = 0;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  total = 0;

  constructor(readonly limit: number) {
    // Too small for a mark and two useful halves: the head only, as before.
    const room = limit - GAP_MARK_BYTES;
    this.#headLimit = room < 64 ? limit : Math.floor(room / 2);
    this.#tailLimit = room < 64 ? 0 : room - this.#headLimit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    const room = this.#headLimit - this.#headBytes;
    if (room > 0) {
      const part = rest.length <= room ? rest : rest.subarray(0, room);
      this.#head.push(part);
      this.#headBytes += part.length;
      rest = rest.subarray(part.length);
    }
    if (rest.length === 0 || this.#tailLimit === 0) return;
    this.#tail.push(rest);
    this.#tailBytes += rest.length;
    // Whole pieces fall off the front while what is left still covers all a stream that fits
    // would keep (the mark's room included), so nothing is lost before it is known not to fit.
    const keep = this.limit - this.#headLimit;
    while (this.#tail.length > 1 && this.#tailBytes - (this.#tail[0]?.length ?? 0) >= keep) {
      this.#tailBytes -= this.#tail.shift()?.length ?? 0;
    }
  }

  get buffer(): Buffer {
    let head = Buffer.concat(this.#head);
    if (this.total <= this.limit) return Buffer.concat([head, ...this.#tail]);
    let tail = Buffer.concat(this.#tail);
    tail = tail.subarray(Math.max(0, tail.length - this.#tailLimit));
    if (tail.length === 0) return head;
    // Neither half cut inside a UTF-8 character: the pieces of one go with the gap.
    let lead = head.length - 1;
    while (lead >= 0 && head.length - lead < 4 && ((head[lead] as number) & 0xc0) === 0x80) lead--;
    if (lead >= 0) {
      const byte = head[lead] as number;
      const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (head.length - lead < size) head = head.subarray(0, lead);
    }
    let start = 0;
    while (start < tail.length && start < 3 && ((tail[start] as number) & 0xc0) === 0x80) start++;
    tail = tail.subarray(start);
    const skipped = this.total - head.length - tail.length;
    const mark = Buffer.from(`\n[… ${skipped} bytes left out …]\n`, "utf8");
    return Buffer.concat([head, mark, tail]);
  }
}

/** The real runner: `spawn(docker, args)` with `shell: false` and a filtered environment. */
export class ProcessDockerRunner implements DockerRunner {
  constructor(
    readonly executable: string,
    readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const stdout = new Capped(options.maxOutputBytes);
      const stderr = new Capped(options.maxOutputBytes);
      let limitHit = false;
      let spawnError: string | null = null;
      const child = spawn(this.executable, [...args], {
        shell: false,
        windowsHide: true,
        env: dockerCliEnv(this.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const onAbort = () => child.kill("SIGKILL");
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      const checkLimit = () => {
        const limit = options.outputLimit;
        if (!limit || limitHit || stdout.total + stderr.total <= limit.bytes) return;
        limitHit = true;
        limit.onExceeded();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onData?.("stdout", chunk);
        checkLimit();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onData?.("stderr", chunk);
        checkLimit();
      });
      // The program may exit without reading stdin (EPIPE); that is not an error of the run.
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        spawnError = errorMessage(error);
      });
      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          // A failed spawn closes with a negative errno, not an exit code.
          exit_code: spawnError === null ? code : null,
          stdout: stdout.buffer,
          stderr: stderr.buffer,
          stdout_bytes: stdout.total,
          stderr_bytes: stderr.total,
          error: spawnError,
        });
      });
      if (options.stdinLater !== undefined) {
        void options.stdinLater.then((text) => {
          if (!child.stdin.writable) return;
          if (text) child.stdin.end(text);
          else child.stdin.end();
        });
      } else if (options.stdin) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}
