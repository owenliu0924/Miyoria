// A fake `SandboxClient` whose `browser` jobs run a fake driver in the test process: it speaks
// the driver's JSON-RPC over the proc's streams and browses a few scripted pages.

import { PassThrough } from "node:stream";
import type {
  SandboxClient,
  SandboxExecResult,
  SandboxFor,
  SandboxJob,
  SandboxJobKind,
  SandboxJobSpec,
  SandboxProc,
} from "@miyoria/types";
import { encodeFrame, FrameDecoder } from "../../src/browse/rpc.js";
import type { MachineState } from "../../src/remote/client.js";

/** One scripted page. */
export interface FakePage {
  title: string;
  text: string;
  /** ref -> where clicking it goes (another page's url), or a download. */
  links?: Record<string, string | { download: string; bytes: number }>;
  status?: number;
}

/** A 1x1 PNG. */
export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export class FakeDriver {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  url = "about:blank";
  history: string[] = [];
  /** The next call of this method fails with this JSON-RPC error. */
  failNext: { method: string; code: number; message: string } | null = null;
  /** The next call of this method never answers. */
  hangNext: string | null = null;
  /** Sends something that is not a frame. */
  garbage = false;

  constructor(readonly pages: Record<string, FakePage>) {}

  #page(): FakePage {
    return this.pages[this.url] ?? { title: "", text: "" };
  }

  answer(method: string, params: Record<string, unknown>): unknown {
    this.calls.push({ method, params });
    if (this.failNext?.method === method) {
      const e = this.failNext;
      this.failNext = null;
      throw Object.assign(new Error(e.message), { code: e.code });
    }
    switch (method) {
      case "browse.ping":
        return { playwright: "1.65.1", browser: "140.0" };
      case "browse.open": {
        const url = String(params.url);
        if (this.url !== "about:blank") this.history.push(this.url);
        this.url = url;
        const page = this.#page();
        return { url, title: page.title, status: page.status ?? 200 };
      }
      case "browse.read": {
        const page = this.#page();
        const mode = params.mode;
        const whole =
          mode === "outline"
            ? `# ${page.title}\n${Object.keys(page.links ?? {})
                .map((r) => `[${r}] 連結 ${r}`)
                .join("\n")}`
            : mode === "links"
              ? Object.entries(page.links ?? {})
                  .map(([r, to]) => `[${r}] → ${typeof to === "string" ? to : to.download}`)
                  .join("\n")
              : page.text;
        const all = [...whole];
        const offset = Number(params.offset ?? 0);
        const max = Number(params.max_chars ?? 8000);
        return {
          url: this.url,
          title: page.title,
          text: all.slice(offset, offset + max).join(""),
          total_chars: all.length,
          offset,
          truncated: offset + max < all.length,
        };
      }
      case "browse.act": {
        const before = this.url;
        const page = this.#page();
        const downloads: { path: string; bytes: number }[] = [];
        if (params.action === "click") {
          const to = page.links?.[String(params.ref)];
          if (to === undefined) {
            throw Object.assign(new Error(`no element ${String(params.ref)} on ${page.title}`), {
              code: 1,
            });
          }
          if (typeof to === "string") {
            this.history.push(this.url);
            this.url = to;
          } else downloads.push({ path: `downloads/${to.download}`, bytes: to.bytes });
        } else if (params.action === "back") {
          this.url = this.history.pop() ?? this.url;
        }
        const now = this.#page();
        return {
          url: this.url,
          title: now.title,
          navigated: this.url !== before,
          new_tab: false,
          downloads,
          note: null,
        };
      }
      case "browse.shot":
        return {
          mime: "image/png",
          data: PNG_1X1,
          width: 1280,
          height: params.full_page === true ? 2400 : 800,
          clipped: false,
          url: this.url,
          title: this.#page().title,
        };
      default:
        throw Object.assign(new Error("no such method"), { code: -32601 });
    }
  }
}

class FakeProc implements SandboxProc {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  #exit: (v: { code: number | null; signal: string | null }) => void = () => {};
  killed = false;

  constructor(readonly driver: FakeDriver) {
    this.exited = new Promise((resolve) => {
      this.#exit = resolve;
    });
    const decoder = new FrameDecoder();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const body of decoder.push(chunk)) {
        const m = JSON.parse(body.toString("utf8")) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        if (driver.hangNext === m.method) {
          driver.hangNext = null;
          continue;
        }
        if (driver.garbage) {
          this.stdout.write("Content-Length: nope\r\n\r\n{}");
          continue;
        }
        let reply: unknown;
        try {
          reply = { jsonrpc: "2.0", id: m.id, result: driver.answer(m.method, m.params) };
        } catch (error) {
          const e = error as Error & { code?: number };
          reply = {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: e.code ?? -32603, message: e.message },
          };
        }
        // Answers in pieces, as the long-poll delivers them.
        const frame = encodeFrame(reply);
        const half = Math.floor(frame.length / 2);
        setImmediate(() => {
          this.stdout.write(frame.subarray(0, half));
          setImmediate(() => this.stdout.write(frame.subarray(half)));
        });
      }
    });
  }

  exit(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.#exit({ code, signal: null });
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.exit(null);
  }
}

let jobs = 0;

export class FakeJob implements SandboxJob {
  readonly id = `job${String(++jobs).padStart(23, "0")}`;
  readonly kind: SandboxJobKind;
  readonly ended: Promise<{ reason: string }>;
  #end: (v: { reason: string }) => void = () => {};
  closed = false;
  readonly procs: FakeProc[] = [];
  readonly starts: { argv: string[]; env?: Record<string, string> }[] = [];
  syncs = 0;

  constructor(
    readonly spec: SandboxJobSpec,
    readonly host: string,
    readonly driver: FakeDriver,
  ) {
    this.kind = spec.kind;
    this.ended = new Promise((resolve) => {
      this.#end = resolve;
    });
  }

  /** The computer ended it on its own. */
  end(reason: string): void {
    for (const p of this.procs) p.exit(null);
    this.#end({ reason });
  }

  async upload(): Promise<{ files: number; bytes: number; skipped: [] }> {
    return { files: 0, bytes: 0, skipped: [] };
  }
  async exec(): Promise<SandboxExecResult> {
    throw new Error("a browser job runs procs, not execs");
  }
  async proc(
    id: string,
    start: { argv: string[]; env?: Record<string, string> },
  ): Promise<SandboxProc> {
    if (!/^[0-9a-z]{26}$/.test(id)) throw new Error(`bad proc id ${id}`);
    if (start.argv[0] !== "node") throw new Error("not the driver");
    this.starts.push(start);
    const proc = new FakeProc(this.driver);
    this.procs.push(proc);
    return proc;
  }
  async usage() {
    return { cpu_ms: 0, wall_ms: 0, disk_bytes: 0 };
  }
  /** Only so the sessions see a job that can hand `/workspace` back; tests swap `receive`. */
  async sync(): Promise<never> {
    this.syncs++;
    throw new Error("unused: receive is faked");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.end("closed");
  }
}

export class FakeClient implements SandboxClient {
  readonly jobs: FakeJob[] = [];
  readonly drivers: FakeDriver[] = [];
  availableAnswer: ReturnType<SandboxClient["available"]> = { ok: true };
  /** Thrown by the next `open`. */
  nextError: Error | null = null;
  machinesAnswer: MachineState[] = [];
  /** The next drivers fail to start Chromium. */
  failStart = false;

  constructor(readonly pages: Record<string, FakePage>) {}

  available(_forWho: SandboxFor): ReturnType<SandboxClient["available"]> {
    return this.availableAnswer;
  }

  async open(spec: SandboxJobSpec): Promise<SandboxJob> {
    const error = this.nextError;
    this.nextError = null;
    if (error) throw error;
    const driver = new FakeDriver(this.pages);
    if (this.failStart) {
      driver.failNext = { method: "browse.ping", code: -32603, message: "chromium crashed" };
    }
    this.drivers.push(driver);
    const job = new FakeJob(spec, "friend-pc", driver);
    this.jobs.push(job);
    return job;
  }

  watch(): () => void {
    return () => {};
  }

  machines(): MachineState[] {
    return this.machinesAnswer;
  }
}

/** A computer Core has read, with or without the browser image. */
export function machine(browser: boolean, members = true): MachineState {
  const image = (present: boolean) => ({ tag: "t", present, building: false, stale: false });
  return {
    host: "friend-pc",
    service: "sandbox",
    ready: true,
    reason: null,
    jobs: 0,
    info: {
      api: 1,
      service_version: "1",
      boot: "b",
      platform: "linux",
      arch: "x64",
      docker: { available: true, server_version: "29", error: null, cgroup: "v2", runtime: null },
      images: { default: image(true), browser: image(browser) },
      ready: true,
      policy: {
        members,
        plugins: false,
        cpus: 4,
        memory_mb: 8192,
        disk_mb: 20480,
        max_job_cpus: 2,
        max_job_memory_mb: 4096,
      },
      load: { jobs: 0, running: 0, queued: 0, cpus: 0, memory_mb: 0, disk_mb: 0 },
    },
  };
}
