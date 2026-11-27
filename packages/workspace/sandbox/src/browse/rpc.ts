// JSON-RPC 2.0 to the browser driver in the job (`workers/sandbox/image/browser/driver.mjs`), in
// `Content-Length` frames over the proc's stdin and stdout, the framing extensions use too.
//
// The SDK's `RpcPeer` / `StreamTransport` are not a dependency of this package, and the driver's
// answers need a larger frame than an extension's (a screenshot is up to 2 MiB, base64), so the
// few lines are here. Everything that comes back is someone else's computer's word: a frame over
// `MAX_FRAME_BYTES` or a header that is not a length ends the connection, an answer to an id that
// was never asked is dropped, and the driver's error messages are text from a web page as much as
// from the driver.

import type { Readable, Writable } from "node:stream";

/** Largest frame either way (a 2 MiB screenshot is about 2.7 MiB of base64, plus the JSON). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Longest header block before the body. */
const MAX_HEADER_BYTES = 1024;
const SEPARATOR = Buffer.from("\r\n\r\n");

export class FramingError extends Error {
  override readonly name = "FramingError";
}

/** One message as a frame. */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Splits a byte stream into frame bodies. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #need: number | null = null;
  readonly #max: number;

  constructor(maxBytes = MAX_FRAME_BYTES) {
    this.#max = maxBytes;
  }

  /** The whole bodies `chunk` completes; throws `FramingError` on a frame it will not read. */
  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      if (this.#need === null) {
        const end = this.#buffer.indexOf(SEPARATOR);
        if (end < 0) {
          if (this.#buffer.length > MAX_HEADER_BYTES) throw new FramingError("header too long");
          return out;
        }
        if (end > MAX_HEADER_BYTES) throw new FramingError("header too long");
        const header = this.#buffer.subarray(0, end).toString("ascii");
        let length: number | null = null;
        for (const line of header.split("\r\n")) {
          const m = /^content-length:\s*(\d{1,10})\s*$/i.exec(line);
          if (m) length = Number(m[1]);
        }
        if (length === null) throw new FramingError("frame without a Content-Length");
        if (length > this.#max) throw new FramingError(`frame of ${length} bytes is too large`);
        this.#need = length;
        this.#buffer = this.#buffer.subarray(end + SEPARATOR.length);
      }
      if (this.#buffer.length < this.#need) return out;
      out.push(Buffer.from(this.#buffer.subarray(0, this.#need)));
      this.#buffer = this.#buffer.subarray(this.#need);
      this.#need = null;
    }
  }
}

/** The driver answered with an error (`code` per JSON-RPC; 1 is "the page would not"). */
export class RpcError extends Error {
  override readonly name = "RpcError";

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The connection is gone (the proc exited, the job ended, a bad frame) or the call took too long. */
export class RpcClosedError extends Error {
  override readonly name = "RpcClosedError";

  constructor(
    message: string,
    readonly timeout = false,
  ) {
    super(message);
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A JSON-RPC client over a proc's streams: one connection, calls answered by id. */
export class RpcClient {
  readonly #output: Writable;
  readonly #pending = new Map<number, Pending>();
  readonly #decoder = new FrameDecoder();
  #next = 1;
  #closed: string | null = null;
  readonly #stop: () => void;

  constructor(output: Writable, input: Readable) {
    this.#output = output;
    const onData = (chunk: Buffer | string) => {
      let bodies: Buffer[];
      try {
        bodies = this.#decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch (error) {
        this.close(`the browser sent a bad frame: ${(error as Error).message}`);
        return;
      }
      for (const body of bodies) this.#message(body);
    };
    const onEnd = () => this.close("the browser's program ended");
    const onError = (error: Error) => this.close(`the browser's output broke: ${error.message}`);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onError);
    output.on("error", onError);
    this.#stop = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      output.off("error", onError);
    };
  }

  /** Why the connection is gone, or `null` while it is up. */
  get closed(): string | null {
    return this.#closed;
  }

  #message(body: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      this.close("the browser sent something that is not JSON");
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const m = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof m.id !== "number") return;
    const pending = this.#pending.get(m.id);
    if (pending === undefined) return;
    this.#pending.delete(m.id);
    clearTimeout(pending.timer);
    if (m.error !== undefined && m.error !== null) {
      const e = m.error as { code?: unknown; message?: unknown };
      pending.reject(
        new RpcError(
          typeof e.code === "number" ? e.code : -32603,
          typeof e.message === "string" ? e.message : "the browser failed",
        ),
      );
      return;
    }
    pending.resolve(m.result ?? null);
  }

  /** Calls `method`; rejects with `RpcError` (the driver said no) or `RpcClosedError`. */
  call(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(new RpcClosedError(this.#closed));
    if (options.signal?.aborted) return Promise.reject(new RpcClosedError("aborted"));
    const id = this.#next++;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        reject(new RpcClosedError("aborted"));
      };
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        options.signal?.removeEventListener("abort", onAbort);
        reject(new RpcClosedError(`the browser did not answer ${method} in time`, true));
      }, options.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          options.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#output.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Ends the connection; every call still waiting fails with `reason`. */
  close(reason: string): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    this.#stop();
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new RpcClosedError(reason));
    }
  }
}
