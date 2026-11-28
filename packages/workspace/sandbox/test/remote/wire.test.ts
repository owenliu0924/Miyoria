// `wire.ts` against a computer that answers badly on purpose: a reply too large to hold, one that
// starts in time and then drips, an error body without end. Each must end in an error within the
// call's own limits, never take all of Core's memory or hang the caller.

import type { Endpoint, EndpointSource } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  callBytes,
  callJson,
  callStream,
  JSON_MAX_BYTES,
  SandboxHttpError,
} from "../../src/remote/wire.js";

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

/** A source whose every request answers `reply()`, and which keeps what it was sent. */
function sourceOf(reply: () => Response): EndpointSource & { inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  return {
    inits,
    pick: () => ENDPOINT,
    candidates: () => [ENDPOINT],
    failed: () => undefined,
    watch: () => () => undefined,
    request: async (_endpoint: Endpoint, _path: string, init: RequestInit = {}) => {
      inits.push(init);
      return reply();
    },
  };
}

/** A body that sends `first`, then nothing more and never ends. */
function dripping(first: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}

/** A body of 64 KiB pieces without end. */
function endless(status = 200): Response {
  const piece = new Uint8Array(64 * 1024).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(piece);
    },
  });
  return new Response(stream, { status });
}

const Any = z.unknown();

describe("a reply's size", () => {
  it("refuses a JSON reply past the default cap without reading all of it", async () => {
    const source = sourceOf(() => endless());
    const error = await callJson(source, ENDPOINT, "/v1/info", Any, {
      method: "GET",
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxHttpError);
    expect((error as SandboxHttpError).code).toBe("bad_reply");
  });

  it("takes a reply over the default cap when the call allows more", async () => {
    const big = JSON.stringify({ text: "x".repeat(JSON_MAX_BYTES + 1000) });
    const source = sourceOf(() => new Response(big, { status: 200 }));
    const got = await callJson(source, ENDPOINT, "/v1/events", Any, {
      method: "GET",
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
    });
    expect((got as { text: string }).text.length).toBe(JSON_MAX_BYTES + 1000);
  });

  it("refuses at once a reply whose length says it is too large", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const source = sourceOf(
      () => new Response(stream, { status: 200, headers: { "content-length": String(1 << 30) } }),
    );
    const error = await callJson(source, ENDPOINT, "/v1/info", Any, {
      method: "GET",
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect((error as SandboxHttpError).code).toBe("bad_reply");
    expect((error as SandboxHttpError).message).toContain("over");
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it("reads only the start of an error body without end", async () => {
    const source = sourceOf(() => endless(500));
    const error = await callJson(source, ENDPOINT, "/v1/info", Any, {
      method: "GET",
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxHttpError);
    expect((error as SandboxHttpError).status).toBe(500);
    expect((error as SandboxHttpError).code).toBe("bad_reply");
  });

  it("caps a byte reply at what the call allows", async () => {
    const source = sourceOf(() => endless());
    const error = await callBytes(source, ENDPOINT, "/log", 100_000, {
      method: "GET",
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect((error as SandboxHttpError).code).toBe("bad_reply");
  });
});

describe("a redirect", () => {
  it("is not followed: the request asks fetch to fail on one", async () => {
    const source = sourceOf(() => new Response("{}", { status: 200 }));
    await callJson(source, ENDPOINT, "/v1/info", Any, { method: "GET", timeoutMs: 5_000 });
    expect(source.inits[0]?.redirect).toBe("error");
  });
});

describe("a reply's time", () => {
  it("stops a JSON reply that started in time and then drips", async () => {
    const source = sourceOf(() => dripping('{"cursor":'));
    const started = Date.now();
    const error = await callJson(source, ENDPOINT, "/v1/events", Any, {
      method: "GET",
      timeoutMs: 100,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops an error body that drips", async () => {
    const source = sourceOf(() => dripping('{"error":', 503));
    const error = await callJson(source, ENDPOINT, "/v1/info", Any, {
      method: "GET",
      timeoutMs: 100,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
  });

  it("gives a byte reply its own longer time for the body", async () => {
    let send: (bytes: Uint8Array) => void = () => {};
    let finish: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (bytes) => controller.enqueue(bytes);
        finish = () => controller.close();
      },
    });
    const source = sourceOf(() => new Response(stream, { status: 200 }));
    const read = callBytes(source, ENDPOINT, "/log", 1024, {
      method: "GET",
      timeoutMs: 50,
      bodyTimeoutMs: 2_000,
    });
    send(new Uint8Array([1, 2]));
    await new Promise((r) => setTimeout(r, 150));
    send(new Uint8Array([3]));
    finish();
    const got = await read;
    expect([...got.bytes]).toEqual([1, 2, 3]);
  });

  it("stops a streamed tar that drips past its body time and cancels its reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = sourceOf(() => new Response(stream, { status: 200 }));
    const started = Date.now();
    const body = await callStream(source, ENDPOINT, "/tar", 1024, {
      method: "GET",
      timeoutMs: 50,
      bodyTimeoutMs: 150,
    });
    const error = await (async () => {
      for await (const _ of body) {
        // Read on: the first piece comes, the rest never does.
      }
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancelled).toBe(true);
  });

  it("stops a streamed tar as soon as it is over its bytes and cancels its reader", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = sourceOf(() => new Response(stream, { status: 200 }));
    const body = await callStream(source, ENDPOINT, "/tar", 4096, {
      method: "GET",
      timeoutMs: 5_000,
      bodyTimeoutMs: 5_000,
    });
    let got = 0;
    const error = await (async () => {
      for await (const chunk of body) got += chunk.byteLength;
    })().catch((e: unknown) => e);
    expect((error as SandboxHttpError).code).toBe("bad_reply");
    expect(got).toBe(4096);
    expect(pulled).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("cancels a streamed tar's reader when the caller stops reading", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const source = sourceOf(() => new Response(stream, { status: 200 }));
    const body = await callStream(source, ENDPOINT, "/tar", 1 << 20, {
      method: "GET",
      timeoutMs: 5_000,
      bodyTimeoutMs: 5_000,
    });
    for await (const _ of body) break;
    expect(cancelled).toBe(true);
  });

  it("stops a byte reply that drips past its body time", async () => {
    const source = sourceOf(() => dripping("a"));
    const error = await callBytes(source, ENDPOINT, "/log", 1024, {
      method: "GET",
      timeoutMs: 50,
      bodyTimeoutMs: 150,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
  });
});
