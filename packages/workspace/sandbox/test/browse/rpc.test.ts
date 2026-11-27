import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  FramingError,
  RpcClient,
  RpcClosedError,
  RpcError,
} from "../../src/browse/rpc.js";

describe("FrameDecoder", () => {
  it("splits frames however the bytes arrive", () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "二" })]);
    for (let cut = 1; cut < bytes.length; cut += 7) {
      const decoder = new FrameDecoder();
      const bodies = [
        ...decoder.push(bytes.subarray(0, cut)),
        ...decoder.push(bytes.subarray(cut)),
      ];
      expect(bodies.map((b) => JSON.parse(b.toString("utf8")))).toEqual([{ a: 1 }, { b: "二" }]);
    }
  });

  it("refuses a frame over the cap, a header without a length and an endless header", () => {
    expect(() => new FrameDecoder(10).push(encodeFrame({ long: "x".repeat(20) }))).toThrow(
      FramingError,
    );
    expect(() => new FrameDecoder().push(Buffer.from("X-Thing: 1\r\n\r\n{}"))).toThrow(
      "Content-Length",
    );
    expect(() => new FrameDecoder().push(Buffer.alloc(2000, 0x41))).toThrow("header too long");
  });
});

function pair() {
  const toDriver = new PassThrough();
  const fromDriver = new PassThrough();
  const client = new RpcClient(toDriver, fromDriver);
  const requests: { id: number; method: string }[] = [];
  const decoder = new FrameDecoder();
  toDriver.on("data", (chunk: Buffer) => {
    for (const body of decoder.push(chunk)) requests.push(JSON.parse(body.toString("utf8")));
  });
  return { client, fromDriver, requests };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("RpcClient", () => {
  it("matches answers to calls by id, in any order, and drops strangers", async () => {
    const { client, fromDriver, requests } = pair();
    const a = client.call("browse.read", {}, { timeoutMs: 5000 });
    const b = client.call("browse.shot", {}, { timeoutMs: 5000 });
    await tick();
    const [ra, rb] = requests;
    fromDriver.write(encodeFrame({ jsonrpc: "2.0", id: 999, result: "stranger" }));
    fromDriver.write(encodeFrame({ jsonrpc: "2.0", id: rb?.id, result: "b" }));
    fromDriver.write(
      encodeFrame({ jsonrpc: "2.0", id: ra?.id, error: { code: 1, message: "no element" } }),
    );
    await expect(b).resolves.toBe("b");
    await expect(a).rejects.toBeInstanceOf(RpcError);
    expect(client.closed).toBeNull();
  });

  it("fails every waiting call when the stream ends, and every later one", async () => {
    const { client, fromDriver } = pair();
    const waiting = client.call("browse.read", {}, { timeoutMs: 5000 });
    fromDriver.end();
    await expect(waiting).rejects.toBeInstanceOf(RpcClosedError);
    await expect(client.call("browse.read", {}, { timeoutMs: 5000 })).rejects.toThrow("ended");
  });

  it("gives up on a call at its time and says it was a timeout", async () => {
    const { client } = pair();
    const error = await client.call("browse.open", {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcClosedError);
    expect((error as RpcClosedError).timeout).toBe(true);
    expect(client.closed).toBeNull();
  });

  it("closes on a frame that is not JSON", async () => {
    const { client, fromDriver } = pair();
    const waiting = client.call("browse.read", {}, { timeoutMs: 5000 });
    fromDriver.write(Buffer.from("Content-Length: 3\r\n\r\n{x}"));
    await expect(waiting).rejects.toBeInstanceOf(RpcClosedError);
    expect(client.closed).toContain("not JSON");
  });
});

// One step's time as Core passes it, short so a hung page is given up on quickly.
process.env.MIYORIA_BROWSE_STEP_MS = "300";

/** The driver of the browser image, loaded without its browser (its pure parts). */
const driver = (await import(
  pathToFileURL(
    resolve(import.meta.dirname, "../../../../../workers/sandbox/image/browser/driver.mjs"),
  ).href
)) as {
  checkUrl(url: string): string;
  safeFileName(name: string): string;
  encodeFrame(message: unknown): Buffer;
  FrameDecoder: new () => { push(chunk: Buffer): Buffer[] };
  ParamsError: new (message: string) => Error;
  Driver: new (
    playwright: unknown,
  ) => { start(): Promise<void>; read(p: object): Promise<{ text: string }> };
  handle(
    d: unknown,
    message: unknown,
  ): Promise<{ id: unknown; result?: unknown; error?: { code: number } }>;
};

describe("the driver's own checks", () => {
  it("opens only the web, data: and about:blank", () => {
    expect(driver.checkUrl("https://example.test/")).toBe("https://example.test/");
    expect(driver.checkUrl("data:text/html,hi")).toBe("data:text/html,hi");
    expect(driver.checkUrl("about:blank")).toBe("about:blank");
    for (const bad of ["file:///etc/passwd", "chrome://version", "javascript:1", "", "not a url"]) {
      expect(() => driver.checkUrl(bad)).toThrow();
    }
  });

  it("names a download without a path, hidden name or control characters", () => {
    expect(driver.safeFileName("../../etc/passwd")).toBe("passwd");
    expect(driver.safeFileName("C:\\Users\\x\\a.txt")).toBe("a.txt");
    expect(driver.safeFileName(".bashrc")).toBe("bashrc");
    expect(driver.safeFileName("a\u0000b|c.pdf")).toBe("a_b_c.pdf");
    expect(driver.safeFileName("")).toBe("download");
    // What Chromium makes of `../../report.txt` before the driver sees it.
    expect(driver.safeFileName("_.._report.txt")).toBe("report.txt");
    expect(driver.safeFileName(".._.._report.txt")).toBe("report.txt");
    expect(driver.safeFileName("__init__.py")).toBe("__init__.py");
    expect(driver.safeFileName("a..b.txt")).toBe("a..b.txt");
    expect([...driver.safeFileName(`${"長".repeat(300)}.pdf`)]).toHaveLength(120);
  });

  it("speaks the same frames as Core, both ways", () => {
    const core = new FrameDecoder();
    expect(
      JSON.parse(core.push(driver.encodeFrame({ id: 1, result: "好" }))[0]?.toString() ?? ""),
    ).toEqual({
      id: 1,
      result: "好",
    });
    const theirs = new driver.FrameDecoder();
    expect(JSON.parse(theirs.push(encodeFrame({ id: 2 }))[0]?.toString() ?? "")).toEqual({ id: 2 });
  });

  it("answers unknown methods, bad params and page failures with their own codes", async () => {
    const stub = {
      open: async () => {
        throw new driver.ParamsError("file: addresses are not opened");
      },
      read: async () => {
        throw new Error("Execution context was destroyed\nstack");
      },
    };
    expect((await driver.handle(stub, { id: 1, method: "browse.eval" })).error?.code).toBe(-32601);
    expect(
      (await driver.handle(stub, { id: 2, method: "browse.open", params: {} })).error?.code,
    ).toBe(-32602);
    const failed = await driver.handle(stub, { id: 3, method: "browse.read", params: {} });
    expect(failed.error).toEqual({ code: -32603, message: "Execution context was destroyed" });
    expect((await driver.handle(stub, { id: 4, method: "constructor" })).error?.code).toBe(-32601);
  });

  it("listens to each page once, though the context also announces the pages it opens", async () => {
    const listeners: string[] = [];
    let announce: (page: unknown) => void = () => {};
    const page = {
      on: (event: string) => listeners.push(event),
      isClosed: () => false,
    };
    const context = {
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      on: (event: string, fn: (p: unknown) => void) => {
        if (event === "page") announce = fn;
      },
      // As Playwright does: the "page" event fires before newPage() resolves.
      newPage: async () => {
        announce(page);
        return page;
      },
    };
    const playwright = {
      chromium: {
        launch: async () => ({ newContext: async () => context, version: () => "1" }),
      },
    };
    await new driver.Driver(playwright).start();
    expect(listeners.filter((e) => e === "download")).toHaveLength(1);
  });

  it("closes a page whose scripts never let it answer, and goes on with a fresh one", async () => {
    let made = 0;
    const closed: number[] = [];
    const newPage = async () => {
      const n = ++made;
      const handlers: Record<string, () => void> = {};
      let isClosed = false;
      return {
        on: (event: string, fn: () => void) => {
          handlers[event] = fn;
        },
        url: () => `https://page-${n}.example.test/`,
        // The first page is stuck in its own scripts: nothing it is asked ever answers.
        title: () => (n === 1 ? new Promise<string>(() => {}) : Promise.resolve(`頁 ${n}`)),
        evaluate: () =>
          n === 1 ? new Promise(() => {}) : Promise.resolve({ text: "還在", next: 1 }),
        close: async () => {
          isClosed = true;
          closed.push(n);
          handlers.close?.();
        },
        isClosed: () => isClosed,
      };
    };
    const context = {
      setDefaultTimeout: () => {},
      setDefaultNavigationTimeout: () => {},
      on: () => {},
      newPage,
    };
    const playwright = {
      chromium: {
        launch: async () => ({
          newContext: async () => context,
          version: () => "1",
          close: async () => {},
        }),
      },
    };
    const d = new driver.Driver(playwright);
    await d.start();
    const stuck = await driver.handle(d, { id: 1, method: "browse.read", params: {} });
    expect(stuck.error?.code).toBe(1);
    expect(closed).toEqual([1]);
    const next = await driver.handle(d, { id: 2, method: "browse.read", params: {} });
    expect(next.result).toMatchObject({ text: "還在", url: "https://page-2.example.test/" });
  });
});
