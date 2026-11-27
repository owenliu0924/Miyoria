// An MCP stdio connection over a program someone else started: a server an extension bundles,
// launched by the extension launcher wherever the extension runs (this machine or a sandbox
// job), not spawned here. MCP's stdio framing is one JSON message per line; the SDK's own
// `ReadBuffer` / `serializeMessage` do the framing so it is the same as `StdioClientTransport`.

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ChildLike } from "../../ext-host/src/launch.js";

/** `child`'s stdin / stdout as an MCP transport; closing it kills the program. */
export class ChildTransport implements Transport {
  readonly #child: ChildLike;
  readonly #buffer = new ReadBuffer();
  #started = false;
  #closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(child: ChildLike) {
    this.#child = child;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("ChildTransport already started");
    this.#started = true;
    const out = this.#child.stdout;
    out.on("data", (chunk: Buffer | string) => {
      try {
        this.#buffer.append(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch (error) {
        // More than the SDK's limit without a line break: not a server worth reading.
        this.onerror?.(error as Error);
        void this.close();
        return;
      }
      this.#drain();
    });
    out.on("error", (error: Error) => this.onerror?.(error));
    this.#child.stdin.on("error", (error: Error) => this.onerror?.(error));
    void this.#child.exited.then(() => this.#finish());
  }

  #drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#buffer.readMessage();
      } catch (error) {
        // A line that is not a message: say so and keep reading the next ones.
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new Error("the MCP server's program has ended");
    const stdin = this.#child.stdin;
    await new Promise<void>((resolve, reject) => {
      const ok = stdin.write(serializeMessage(message), (error) =>
        error ? reject(error) : undefined,
      );
      if (ok) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#child.stdin.end();
    this.#child.kill();
    this.#finish();
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.clear();
    this.onclose?.();
  }
}
