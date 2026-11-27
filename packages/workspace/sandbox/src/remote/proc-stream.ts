// A background process in a job (docs/design/v6-sandbox.md §3.7) as Node streams, so the code
// that talks to it (an extension's JSON-RPC, the browser driver, an MCP server) does not know it
// runs on another computer. Its output comes in the computer's one event long-poll as
// `proc_out` (with the byte offset of each piece); a gap (events dropped, a reset) is filled with
// `GET .../stdout?after=`. What is written to stdin goes in `PUT .../stdin?offset=`, which the
// service takes once per offset, so sending it again after a failed route is harmless.

import { PassThrough, Writable } from "node:stream";
import type { SandboxProc } from "@miyoria/types";
import { readBody } from "./wire.js";

/** Most a stdin write carries at once (the service takes 1 MiB a request). */
const STDIN_CHUNK = 512 * 1024;
/** Most one refill reads. */
const REFILL_BYTES = 4 * 1024 * 1024;

/** What a proc needs of its job. */
export interface ProcLink {
  /** `PUT .../stdin?offset=` with these bytes. */
  writeStdin(proc: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** `GET .../stdout?after=`: the bytes after `after`, and whether it exited. */
  readStdout(
    proc: string,
    after: number,
  ): Promise<{ response: Response; next: number; exited: boolean; code: number | null }>;
  kill(proc: string): Promise<void>;
}

export class ProcChannel implements SandboxProc {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly #id: string;
  readonly #link: ProcLink;
  #written = 0;
  readonly #read = { stdout: 0, stderr: 0 };
  #done = false;
  #refilling: Promise<void> | null = null;
  #resolveExit: (value: { code: number | null; signal: string | null }) => void = () => {};

  constructor(id: string, link: ProcLink) {
    this.#id = id;
    this.#link = link;
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#send(chunk).then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
  }

  get id(): string {
    return this.#id;
  }

  async #send(chunk: Buffer): Promise<void> {
    for (let at = 0; at < chunk.length; at += STDIN_CHUNK) {
      const part = chunk.subarray(at, at + STDIN_CHUNK);
      await this.#link.writeStdin(this.#id, this.#written, part);
      this.#written += part.length;
    }
  }

  /** One `proc_out` event. */
  feed(stream: "stdout" | "stderr", offset: number, data: Buffer): void {
    if (this.#done) return;
    const have = this.#read[stream];
    if (offset > have) {
      // Something before it was lost: the service keeps the last 4 MiB of stdout to refill from.
      if (stream === "stdout") void this.refill();
      return;
    }
    const fresh = data.subarray(Math.min(data.length, have - offset));
    if (fresh.length === 0) return;
    this.#read[stream] += fresh.length;
    (stream === "stdout" ? this.stdout : this.stderr).write(fresh);
  }

  /** Reads what stdout has past what was seen (after a reset or a gap). */
  refill(): Promise<void> {
    this.#refilling ??= (async () => {
      try {
        const got = await this.#link.readStdout(this.#id, this.#read.stdout);
        const bytes = await readBody(got.response, REFILL_BYTES);
        if (bytes.length > 0) {
          this.#read.stdout += bytes.length;
          this.stdout.write(bytes);
        }
        if (got.exited) this.exit(got.code, null);
      } catch {
        // Gone (410) or the computer is away: the reader sees the stream end.
        this.exit(null, "lost");
      } finally {
        this.#refilling = null;
      }
    })();
    return this.#refilling;
  }

  /** The process ended (its `proc_exit`, or its job ended). */
  exit(code: number | null, signal: string | null): void {
    if (this.#done) return;
    this.#done = true;
    this.stdout.end();
    this.stderr.end();
    this.#resolveExit({ code, signal });
  }

  async kill(): Promise<void> {
    if (this.#done) return;
    await this.#link.kill(this.#id).catch(() => undefined);
  }
}
