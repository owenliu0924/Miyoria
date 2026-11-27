// A sandbox service in the test process (docs/design/v6-sandbox.md §3), behind a fake
// `EndpointSource`: the jobs' `/workspace` are real folders, uploads and syncs real tars (through
// `tar-io`, as the service does), and a "program" is a function the test gives. It also lies
// when asked to: a hostile computer that sends back links, `..` and other people's paths.

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecResult,
  JobCreate,
  JobView,
  SandboxEvent,
  SandboxInfo,
} from "@miyoria/contracts/workers";
import type { Endpoint, EndpointSource, EndpointUnit } from "@miyoria/runtime/kernel";
import { extractTar, packTree } from "../../src/tar-io.js";

export interface FakeExec {
  job: FakeJob;
  language: string;
  code: string;
  stdin: string | undefined;
  /** The job's `/workspace` folder. */
  workspace: string;
  /** Adds CPU to the job's total (and an event). */
  cpu(ms: number): void;
  /** Resolves when the exec is stopped (`DELETE`), with the reason. */
  stopped: Promise<string>;
}

export type Program = (
  exec: FakeExec,
) => Promise<{ stdout?: string; exit?: number; cpu_ms?: number }>;

export interface FakeJob {
  id: string;
  create: JobCreate;
  dir: string;
  view: JobView;
  /** What `/workspace` held at the last upload or sync: path → sha256. */
  baseline: Map<string, string>;
  execs: Map<string, { result: ExecResult | null; stop: (reason: string) => void }>;
  cpu: number;
  uploads: Map<string, Buffer[]>;
  syncs: Map<string, Buffer | null>;
  deletes: string[][];
}

/** An event before it has its place in the sequence. */
type Unsequenced<T> = T extends unknown ? Omit<T, "seq"> : never;

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashes(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (full: string, prefix: string) => {
    for (const name of await readdir(full).catch(() => [] as string[])) {
      const child = join(full, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const stat = await lstat(child);
      if (stat.isDirectory()) await walk(child, path);
      else if (stat.isFile()) out.set(path, sha(await readFile(child)));
    }
  };
  await walk(dir, "");
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string, extra: object = {}): Response {
  return json(status, { error: { code, message, ...extra } });
}

async function* once(bytes: Buffer): AsyncGenerator<Uint8Array> {
  yield bytes;
}

export interface MachineOptions {
  host: string;
  root: string;
  ready?: boolean;
  reason?: string;
  members?: boolean;
  /** The next `PUT /v1/jobs` answers this instead. */
  refuseCreate?: { status: number; code: string } | null;
  program?: Program;
}

/** One computer with the `sandbox` service. */
export class FakeMachine {
  readonly host: string;
  readonly root: string;
  readonly jobs = new Map<string, FakeJob>();
  readonly calls: string[] = [];
  ready: boolean;
  reason: string | undefined;
  members: boolean;
  refuseCreate: { status: number; code: string } | null;
  program: Program;
  /** The next sync answers with this hand-made tar and deletions. */
  hostileSync: { tar: Buffer; deleted: string[] } | null = null;
  readonly boot = "boot1";
  #seq = 0;
  readonly #events: SandboxEvent[] = [];
  #wake: (() => void)[] = [];

  constructor(o: MachineOptions) {
    this.host = o.host;
    this.root = o.root;
    this.ready = o.ready ?? true;
    this.reason = o.reason;
    this.members = o.members ?? true;
    this.refuseCreate = o.refuseCreate ?? null;
    this.program = o.program ?? (async () => ({ stdout: "ok\n" }));
  }

  emit(event: Unsequenced<SandboxEvent>): void {
    this.#events.push({ ...event, seq: ++this.#seq } as SandboxEvent);
    const wake = this.#wake;
    this.#wake = [];
    for (const w of wake) w();
  }

  info(): SandboxInfo {
    return {
      api: 1,
      service_version: "0.0.0-test",
      boot: this.boot,
      platform: "linux",
      arch: "x64",
      docker: { available: true, server_version: "27", error: null, cgroup: "v2", runtime: null },
      images: {
        default: { tag: "miyoria/sandbox:1-test", present: true, building: false, stale: false },
        browser: {
          tag: "miyoria/sandbox-browser:1-test",
          present: false,
          building: false,
          stale: false,
        },
      },
      ready: this.ready,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      policy: {
        members: this.members,
        plugins: false,
        cpus: 8,
        memory_mb: 16384,
        disk_mb: 20480,
        max_job_cpus: 8,
        max_job_memory_mb: 16384,
      },
      load: { jobs: this.jobs.size, running: 0, queued: 0, cpus: 0, memory_mb: 0, disk_mb: 0 },
    };
  }

  #view(job: FakeJob): JobView {
    return {
      ...job.view,
      usage: { ...job.view.usage, cpu_ms: job.cpu },
    };
  }

  /** Ends a job from the computer's side (idle, lost, ...). */
  end(id: string, reason: "idle" | "lost" | "lease" | "closed"): void {
    const job = this.jobs.get(id);
    if (!job || job.view.ended !== null) return;
    job.view = { ...job.view, state: "ended", ended: { reason, at: Date.now() } };
    this.emit({ job: id, kind: "ended", reason, usage: this.#view(job).usage });
  }

  async handle(method: string, url: URL, body: Buffer, headers: Headers): Promise<Response> {
    const path = url.pathname;
    this.calls.push(`${method} ${path}`);
    if (method === "GET" && path === "/v1/info") return json(200, this.info());
    if (method === "GET" && path === "/v1/events") return this.#events_(url);
    const m = /^\/v1\/jobs\/([0-9a-z]{26})(\/.*)?$/.exec(path);
    if (!m) return fail(404, "not_found", "no such path");
    const id = m[1] as string;
    const rest = m[2] ?? "";
    if (rest === "" && method === "PUT") return this.#create(id, body);
    const job = this.jobs.get(id);
    if (!job) return fail(404, "not_found", "no such job");
    if (rest === "" && method === "GET") return json(200, this.#view(job));
    if (rest === "" && method === "DELETE") {
      this.end(id, "closed");
      await rm(job.dir, { recursive: true, force: true });
      return json(200, this.#view(job));
    }
    if (job.view.ended !== null) {
      return fail(410, "gone", "the job ended", { ended: job.view.ended });
    }
    if (rest === "/lease" && method === "PUT") return json(200, {});
    let u = /^\/uploads\/([0-9a-z]{26})\/parts\/(\d+)$/.exec(rest);
    if (u && method === "PUT") {
      const parts = job.uploads.get(u[1] as string) ?? [];
      parts[Number(u[2])] = body;
      job.uploads.set(u[1] as string, parts);
      if (headers.get("x-sha256") !== sha(body)) return fail(400, "bad_request", "hash");
      return json(200, { n: Number(u[2]), bytes: body.length, sha256: sha(body) });
    }
    u = /^\/uploads\/([0-9a-z]{26})$/.exec(rest);
    if (u && method === "PUT") return this.#commit(job, u[1] as string, body, headers);
    u = /^\/execs\/([0-9a-z]{26})$/.exec(rest);
    if (u && method === "PUT") return this.#exec(job, u[1] as string, body);
    if (u && method === "GET") {
      const exec = job.execs.get(u[1] as string);
      if (!exec) return fail(404, "not_found", "no such exec");
      return json(200, {
        id: u[1],
        state: exec.result === null ? "running" : "done",
        started_at: 0,
        result: exec.result,
      });
    }
    if (u && method === "DELETE") {
      job.execs.get(u[1] as string)?.stop(url.searchParams.get("reason") ?? "aborted");
      return json(200, {});
    }
    u = /^\/syncs\/([0-9a-z]{26})(\/tar)?$/.exec(rest);
    if (u && method === "PUT" && u[2] === undefined) return this.#sync(job, u[1] as string);
    if (u && method === "GET" && u[2] === "/tar") {
      const tar = job.syncs.get(u[1] as string);
      if (!tar) return fail(404, "not_found", "no tar");
      return new Response(new Uint8Array(tar), { status: 200 });
    }
    if (u && method === "DELETE") {
      job.syncs.delete(u[1] as string);
      return json(200, {});
    }
    return fail(404, "not_found", `no ${method} ${rest}`);
  }

  async #events_(url: URL): Promise<Response> {
    const after = url.searchParams.get("after");
    const seq = after === null ? 0 : Number(after.split(":")[1] ?? 0);
    const reset = after !== null && !after.startsWith(`${this.boot}:`);
    const pending = () => this.#events.filter((e) => e.seq > (reset ? 0 : seq));
    if (pending().length === 0 && !reset) {
      const wait = Math.min(Number(url.searchParams.get("wait_ms") ?? 0), 200);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.#wake.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const events = pending();
    return json(200, { cursor: `${this.boot}:${this.#seq}`, events, reset });
  }

  async #create(id: string, body: Buffer): Promise<Response> {
    if (this.jobs.has(id)) return json(200, this.#view(this.jobs.get(id) as FakeJob));
    if (this.refuseCreate !== null) {
      const r = this.refuseCreate;
      return fail(
        r.status,
        r.code,
        `refused (${r.code})`,
        r.code === "busy" ? { retry_after_ms: 1000 } : {},
      );
    }
    const create = JSON.parse(body.toString("utf8")) as JobCreate;
    if (create.for === "member" && !this.members) return fail(403, "not_accepting", "no members");
    const dir = join(this.root, this.host, id);
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const job: FakeJob = {
      id,
      create,
      dir,
      baseline: new Map(),
      execs: new Map(),
      cpu: 0,
      uploads: new Map(),
      syncs: new Map(),
      deletes: [],
      view: {
        id,
        kind: create.kind,
        state: "ready",
        ended: null,
        image_tag: "miyoria/sandbox:1-test",
        limits: create.limits,
        created_at: now,
        last_used_at: now,
        expires_at: now + create.idle_s * 1000,
        usage: {
          cpu_ms: 0,
          cpu_source: "cgroup",
          wall_ms: 0,
          disk_bytes: 0,
          egress: {
            bytes_in: 0,
            bytes_out: 0,
            connections: 0,
            refused: { address: 0, port: 0, cap: 0 },
          },
        },
        exec: null,
        procs: [],
      },
    };
    this.jobs.set(id, job);
    return json(201, this.#view(job));
  }

  async #commit(job: FakeJob, upload: string, body: Buffer, headers: Headers): Promise<Response> {
    const commit = JSON.parse(body.toString("utf8")) as {
      parts: number;
      sha256: string;
      replace: boolean;
      target: string;
    };
    const parts = job.uploads.get(upload) ?? [];
    const all = Buffer.concat(parts);
    if (parts.length !== commit.parts || sha(all) !== commit.sha256) {
      return fail(400, "bad_request", "the parts do not add up");
    }
    if (commit.target !== "workspace") return json(200, { files: 0, bytes: 0, skipped: [] });
    if (commit.replace) {
      await rm(job.dir, { recursive: true, force: true });
      await mkdir(job.dir, { recursive: true });
    }
    const deleted = headers.get("x-delete");
    if (deleted !== null) {
      const list = JSON.parse(deleted) as string[];
      job.deletes.push(list);
      for (const p of list) await rm(join(job.dir, p), { force: true });
    }
    const out = await extractTar(once(all), job.dir, {
      gzip: true,
      limits: { maxFiles: 10_000, maxBytes: 1 << 30, maxFileBytes: 1 << 30, maxDepth: 8 },
    });
    job.baseline = await hashes(job.dir);
    return json(200, { files: out.written.length, bytes: all.length, skipped: out.skipped });
  }

  async #exec(job: FakeJob, execId: string, body: Buffer): Promise<Response> {
    const start = JSON.parse(body.toString("utf8")) as {
      program?: { language: string; code: string };
      stdin?: string;
      timeout_ms: number;
    };
    let stop: (reason: string) => void = () => {};
    const stopped = new Promise<string>((resolve) => {
      stop = resolve;
    });
    const entry = { result: null as ExecResult | null, stop };
    job.execs.set(execId, entry);
    const before = job.cpu;
    const exec: FakeExec = {
      job,
      language: start.program?.language ?? "argv",
      code: start.program?.code ?? "",
      stdin: start.stdin,
      workspace: job.dir,
      cpu: (ms) => {
        job.cpu += ms;
        this.emit({ job: job.id, kind: "cpu", cpu_ms: job.cpu });
      },
      stopped,
    };
    void (async () => {
      const raced = await Promise.race([
        this.program(exec).then((r) => ({ kind: "done" as const, r })),
        stopped.then((reason) => ({ kind: "stopped" as const, reason })),
      ]);
      if (raced.kind === "done" && raced.r.cpu_ms !== undefined) job.cpu += raced.r.cpu_ms;
      const stdout = raced.kind === "done" ? (raced.r.stdout ?? "") : "";
      const result: ExecResult = {
        exit_code: raced.kind === "done" ? (raced.r.exit ?? 0) : null,
        killed_reason:
          raced.kind === "stopped" ? (raced.reason as ExecResult["killed_reason"]) : null,
        duration_ms: 5,
        cpu_ms: job.cpu - before,
        stdout,
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: 0,
        files_out: [],
        files_out_truncated: false,
        log_bytes: Buffer.byteLength(stdout),
      };
      entry.result = result;
      this.emit({ job: job.id, exec: execId, kind: "exit", result });
    })();
    return json(202, { id: execId, state: "running", started_at: Date.now(), result: null });
  }

  async #sync(job: FakeJob, syncId: string): Promise<Response> {
    if (this.hostileSync !== null) {
      const { tar, deleted } = this.hostileSync;
      this.hostileSync = null;
      job.syncs.set(syncId, tar);
      return json(200, {
        changed: [],
        deleted,
        skipped: [],
        tar: { bytes: tar.length, sha256: sha(tar) },
      });
    }
    const now = await hashes(job.dir);
    const changed = [...now].filter(([p, h]) => job.baseline.get(p) !== h).map(([p]) => p);
    const deleted = [...job.baseline.keys()].filter((p) => !now.has(p));
    job.baseline = now;
    if (changed.length === 0) {
      return json(200, { changed: [], deleted, skipped: [], tar: null });
    }
    const only = new Set<string>();
    for (const p of changed) {
      const parts = p.split("/");
      for (let i = 1; i <= parts.length; i++) only.add(parts.slice(0, i).join("/"));
    }
    const packed = packTree(job.dir, {
      gzip: true,
      skip: (p) => !only.has(p),
      limits: { maxFiles: 10_000, maxBytes: 1 << 30, maxFileBytes: 1 << 30 },
    });
    const chunks: Buffer[] = [];
    for await (const c of packed.stream) chunks.push(Buffer.from(c));
    const done = await packed.done;
    const tar = Buffer.concat(chunks);
    job.syncs.set(syncId, tar);
    return json(200, {
      changed: done.entries,
      deleted,
      skipped: done.skipped,
      tar: { bytes: tar.length, sha256: sha(tar) },
    });
  }
}

/** A registry of fake machines, in the order they are tried. */
export class FakeEndpoints implements EndpointSource {
  readonly machines: FakeMachine[];
  readonly failedHosts: string[] = [];
  readonly reserved: { host: string; done: unknown[]; accepted: boolean }[] = [];
  #watchers: (() => void)[] = [];

  constructor(machines: FakeMachine[]) {
    this.machines = machines;
  }

  #endpoint(m: FakeMachine): Endpoint {
    return {
      capability: "sandbox",
      host: m.host,
      service: "sandbox",
      url: `http://${m.host}.test:1`,
      via: "direct",
      headers: { authorization: "Bearer test" },
      healthy: true,
      version: "test",
    };
  }

  pick(): Endpoint | null {
    return this.candidates()[0] ?? null;
  }

  candidates(): Endpoint[] {
    return this.machines.map((m) => this.#endpoint(m));
  }

  failed(endpoint: Endpoint): void {
    this.failedHosts.push(endpoint.host);
  }

  async request(endpoint: Endpoint, path: string, init: RequestInit = {}): Promise<Response> {
    const machine = this.machines.find((m) => m.host === endpoint.host);
    if (!machine) throw Object.assign(new Error("gone"), { code: "ECONNREFUSED" });
    init.signal?.throwIfAborted();
    const body =
      init.body === undefined || init.body === null
        ? Buffer.alloc(0)
        : Buffer.from(await new Response(init.body as never).arrayBuffer());
    return machine.handle(
      (init.method ?? "GET").toUpperCase(),
      new URL(path, endpoint.url),
      body,
      new Headers(init.headers),
    );
  }

  watch(_capability: string, onChange: () => void): () => void {
    this.#watchers.push(onChange);
    return () => {
      this.#watchers = this.#watchers.filter((w) => w !== onChange);
    };
  }

  changed(): void {
    for (const w of this.#watchers) w();
  }

  reserve(endpoint: Endpoint): EndpointUnit {
    const entry = { host: endpoint.host, done: [] as unknown[], accepted: false };
    this.reserved.push(entry);
    return {
      accepted: () => {
        entry.accepted = true;
      },
      done: (outcome) => {
        entry.done.push(outcome ?? {});
      },
    };
  }
}
