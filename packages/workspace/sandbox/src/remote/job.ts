// One job on a computer of the cluster (docs/design/v6-sandbox.md §2, §3): `SandboxJob` over
// the service's HTTP calls. Its events arrive through the client's one long-poll per computer
// (`handle`); everything that changes something is a `PUT` under an id Core chose, so a request
// sent again over another route does the same thing once.

import { createHash } from "node:crypto";
import {
  type ExecResult,
  type ExecStartIn,
  ExecViewSchema,
  type JobView,
  JobViewSchema,
  type ProcView,
  ProcViewSchema,
  type SandboxEvent,
  SyncResultSchema,
  UploadPartResultSchema,
  UploadResultSchema,
} from "@miyoria/contracts/workers";
import {
  type Endpoint,
  type EndpointSource,
  errorMessage,
  getLogger,
} from "@miyoria/runtime/kernel";
import {
  type Clock,
  newId,
  type SandboxExecResult,
  type SandboxExecStart,
  type SandboxJobKind,
  type SandboxProc,
  type WorkPayer,
} from "@miyoria/types";
import { Semaphore } from "../semaphore.js";
import { packTree } from "../tar-io.js";
import { ProcChannel } from "./proc-stream.js";
import type { Manifest, TransferJob } from "./transfer.js";
import { bodyChunks, call, callBytes, callJson, SandboxHttpError } from "./wire.js";

const log = getLogger("sandbox.job");

/** Request timeouts of §3.2 (to the reply's head). */
export const TIMEOUTS = {
  info: 5_000,
  create: 120_000,
  view: 10_000,
  lease: 10_000,
  close: 60_000,
  part: 60_000,
  commit: 120_000,
  execStart: 15_000,
  execView: 10_000,
  execStop: 15_000,
  log: 60_000,
  sync: 120_000,
  syncTar: 60_000,
  syncDrop: 10_000,
  procStart: 30_000,
  stdin: 15_000,
  stdout: 10_000,
  procStop: 15_000,
} as const;

/** How long after its own time limit an exec's `exit` may be late before Core stops waiting. */
export const EXEC_GRACE_MS = 60_000;
/** How often a running exec is asked about directly, in case its events went missing. */
export const EXEC_POLL_MS = 15_000;
/** Most of an exec's log fetched for `log()`. */
const LOG_MAX_BYTES = 16 * 1024 * 1024;
/** How long all of a log may take to arrive (16 MiB over a slow relay). */
const LOG_BODY_MS = 5 * 60_000;
/** How long a refill of a proc's stdout (4 MiB at most) may take to arrive in full. */
const STDOUT_BODY_MS = 60_000;
/**
 * Most of a sync's or an upload's answer: it lists files (a manifest, what was skipped), up to
 * the transfer's 200 000, so it is far larger than other replies; still bounded, since a reply of
 * gigabytes from someone else's computer would take Core's memory.
 */
export const LIST_REPLY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Most an exec's answer (and its `exit` event) can rightly hold: stdout and stderr at their kept
 * size and the collected files, each byte at worst a six-character JSON escape, plus their paths.
 */
export function execReplyBytes(
  output: { keep_bytes: number },
  collect: { max_files: number; max_bytes: number },
): number {
  return 64 * 1024 + 6 * (2 * output.keep_bytes + collect.max_bytes) + collect.max_files * 8192;
}

/** What the client gives each of its jobs. */
export interface JobLink {
  source: EndpointSource;
  /** The endpoint now (its route may have changed since the job opened). */
  endpoint(): Endpoint;
  clock: Clock;
  partBytes: number;
  maxTransferBytes: number;
  output: { keep_bytes: number; kill_bytes: number; stream_bytes: number };
  collect: { max_files: number; max_bytes: number };
  /** The job's CPU went up by `deltaMs` (charged to its payer). */
  charge(job: RemoteJob, deltaMs: number): void;
  /** The job ended (the client forgets it). */
  ended(job: RemoteJob, reason: string): void;
}

/** Why a job's end means its files are gone, for her (`lease` and `host_policy` read as `lost`). */
export function closeReason(
  reason: string,
): "closed" | "idle" | "lifetime" | "disk" | "lost" | "shutdown" {
  switch (reason) {
    case "closed":
    case "idle":
    case "lifetime":
    case "disk":
    case "shutdown":
      return reason;
    default:
      return "lost";
  }
}

/** The result of an exec whose answer never came (the computer went away). */
function lostResult(started: number, now: number): ExecResult {
  return {
    exit_code: null,
    killed_reason: "lost",
    duration_ms: Math.max(0, now - started),
    cpu_ms: 0,
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    stdout_bytes: 0,
    stderr_bytes: 0,
    files_out: [],
    files_out_truncated: false,
    log_bytes: 0,
  };
}

interface Pending {
  started: number;
  /** CPU charged when it started. */
  base: number;
  resolve: (result: ExecResult) => void;
  onOutput: ((stream: "stdout" | "stderr", text: string) => void) | undefined;
}

/** Header values are bytes: paths with other characters go as JSON `\u` escapes. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export class RemoteJob implements TransferJob {
  readonly id: string;
  readonly host: string;
  readonly service: string;
  readonly kind: SandboxJobKind;
  readonly payer: WorkPayer | null;
  readonly ended: Promise<{ reason: string }>;
  readonly #link: JobLink;
  readonly #queue = new Semaphore(1, 64);
  readonly #execs = new Map<string, Pending>();
  readonly #procs = new Map<string, ProcChannel>();
  #view: JobView;
  #endedReason: string | null = null;
  #resolveEnded: (value: { reason: string }) => void = () => {};
  /** CPU charged to the payer so far (the job's cgroup total as last seen), ms. */
  #charged: number;
  /** Time its execs ran, for the cluster's estimates. */
  runMs = 0;
  /** Set by the sandbox: the workspace this job holds and its manifest. */
  manifest: Manifest | null = null;

  constructor(
    view: JobView,
    o: {
      host: string;
      service: string;
      payer: WorkPayer | null;
      link: JobLink;
      charged?: number;
    },
  ) {
    this.id = view.id;
    this.kind = view.kind;
    this.host = o.host;
    this.service = o.service;
    this.payer = o.payer;
    this.#link = o.link;
    this.#view = view;
    this.#charged = o.charged ?? 0;
    this.ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });
  }

  get maxTransferBytes(): number {
    return this.#link.maxTransferBytes;
  }

  get view(): JobView {
    return this.#view;
  }

  /** The reason it ended, or `null` while it is open. */
  get endedReason(): string | null {
    return this.#endedReason;
  }

  get charged(): number {
    return this.#charged;
  }

  /** Whether an exec runs or waits. */
  get busy(): boolean {
    return this.#execs.size > 0 || this.#queue.waiting > 0;
  }

  #path(rest = ""): string {
    return `/v1/jobs/${this.id}${rest}`;
  }

  /** Most of an exec's answer, from what Core asked it to keep. */
  get #execReplyBytes(): number {
    return execReplyBytes(this.#link.output, this.#link.collect);
  }

  #json<T>(
    path: string,
    schema: Parameters<typeof callJson>[3],
    o: Parameters<typeof callJson>[4],
  ): Promise<T> {
    return callJson(this.#link.source, this.#link.endpoint(), path, schema, o) as Promise<T>;
  }

  #call(path: string, o: Parameters<typeof call>[3]): Promise<Response> {
    return call(this.#link.source, this.#link.endpoint(), path, o);
  }

  /** Counts the job's CPU up to `total` ms (its cgroup's running total). */
  #chargeTo(total: number): void {
    const delta = total - this.#charged;
    if (!(delta > 0)) return;
    this.#charged = total;
    this.#link.charge(this, delta);
  }

  /** One event of the computer's long-poll for this job. */
  handle(event: SandboxEvent): void {
    switch (event.kind) {
      case "state":
        this.#view = { ...this.#view, state: event.state };
        return;
      case "cpu":
        this.#chargeTo(event.cpu_ms);
        return;
      case "stdout":
      case "stderr":
        this.#execs.get(event.exec)?.onOutput?.(event.kind, event.text);
        return;
      case "exit":
        this.#finish(event.exec, event.result);
        return;
      case "proc_out":
        this.#procs
          .get(event.proc)
          ?.feed(event.stream, event.offset, Buffer.from(event.data_b64, "base64"));
        return;
      case "proc_exit":
        this.#procs.get(event.proc)?.exit(event.code, event.signal);
        return;
      case "ended":
        this.#chargeTo(event.usage.cpu_ms);
        this.end(event.reason);
        return;
    }
  }

  #finish(exec: string, result: ExecResult): void {
    const pending = this.#execs.get(exec);
    if (!pending) return;
    this.#execs.delete(exec);
    this.#chargeTo(pending.base + result.cpu_ms);
    this.runMs += result.duration_ms;
    pending.resolve(result);
  }

  /** The job is over: waiting execs get a `lost` result, procs end. Once. */
  end(reason: string): void {
    if (this.#endedReason !== null) return;
    this.#endedReason = reason;
    const now = this.#link.clock.now();
    for (const [id, pending] of [...this.#execs]) {
      this.#execs.delete(id);
      pending.resolve(lostResult(pending.started, now));
    }
    for (const proc of this.#procs.values()) proc.exit(null, "lost");
    this.#procs.clear();
    this.#view = { ...this.#view, state: "ended" };
    this.#resolveEnded({ reason });
    this.#link.ended(this, reason);
  }

  /** Re-reads the job (after a reset of the events, or a restart of Core). */
  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.#endedReason !== null) return;
    let view: JobView;
    try {
      view = await this.#json<JobView>(this.#path(), JobViewSchema, {
        method: "GET",
        timeoutMs: TIMEOUTS.view,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (
        error instanceof SandboxHttpError &&
        (error.code === "not_found" || error.code === "gone")
      ) {
        this.end(error.extra.ended?.reason ?? "lost");
      }
      return;
    }
    this.#view = view;
    this.#chargeTo(view.usage.cpu_ms);
    if (view.ended !== null) {
      this.end(view.ended.reason);
      return;
    }
    for (const id of [...this.#execs.keys()]) await this.#askExec(id);
    for (const proc of this.#procs.values()) await proc.refill();
  }

  /** `PUT .../lease`. A job the computer no longer has is over. */
  async lease(): Promise<void> {
    if (this.#endedReason !== null) return;
    try {
      await this.#call(this.#path("/lease"), { method: "PUT", timeoutMs: TIMEOUTS.lease });
    } catch (error) {
      if (
        error instanceof SandboxHttpError &&
        (error.code === "not_found" || error.code === "gone")
      ) {
        this.end(error.extra.ended?.reason ?? "lost");
      }
    }
  }

  async upload(
    target: "workspace" | "tools" | "ext" | "work",
    source: { dir: string; skip?: (relativePath: string) => boolean },
    options: { replace?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ files: number; bytes: number; skipped: { path: string; why: string }[] }> {
    const sent = await this.uploadTree(target, source.dir, {
      ...(source.skip === undefined ? {} : { skip: source.skip }),
      replace: options.replace ?? true,
      limits: {
        maxFiles: 200_000,
        maxBytes: this.#link.maxTransferBytes,
        maxFileBytes: this.#link.maxTransferBytes,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { files: sent.entries.length, bytes: sent.bytes, skipped: sent.skipped };
  }

  async uploadTree(
    target: "workspace" | "tools" | "ext" | "work",
    dir: string,
    options: {
      skip?: (relativePath: string) => boolean;
      only?: ReadonlySet<string>;
      replace: boolean;
      manifest?: Manifest;
      deleted?: readonly string[];
      limits: { maxFiles: number; maxBytes: number; maxFileBytes: number };
      signal?: AbortSignal;
    },
  ): Promise<{ entries: Manifest; skipped: { path: string; why: string }[]; bytes: number }> {
    this.#open();
    const only = options.only;
    const skip = options.skip;
    const packed = packTree(dir, {
      gzip: true,
      limits: options.limits,
      ...(skip === undefined && only === undefined
        ? {}
        : { skip: (p: string) => (skip?.(p) ?? false) || (only !== undefined && !only.has(p)) }),
    });
    const upload = newId().toLowerCase();
    const signal = options.signal;
    const partBytes = this.#link.partBytes;
    let parts = 0;
    let held: Buffer[] = [];
    let heldBytes = 0;
    const send = async (bytes: Buffer): Promise<void> => {
      const n = parts++;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const got = await this.#json<{ sha256: string; bytes: number }>(
        this.#path(`/uploads/${upload}/parts/${n}`),
        UploadPartResultSchema,
        {
          method: "PUT",
          bytes,
          headers: { "x-sha256": sha256 },
          timeoutMs: TIMEOUTS.part,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (got.sha256 !== sha256 || got.bytes !== bytes.length) {
        throw new SandboxHttpError(200, "bad_reply", "an upload part arrived damaged");
      }
    };
    for await (const chunk of packed.stream) {
      held.push(Buffer.from(chunk));
      heldBytes += chunk.byteLength;
      while (heldBytes >= partBytes) {
        const all = Buffer.concat(held);
        await send(all.subarray(0, partBytes));
        const rest = all.subarray(partBytes);
        held = rest.length > 0 ? [rest] : [];
        heldBytes = rest.length;
      }
    }
    if (heldBytes > 0 || parts === 0) await send(Buffer.concat(held));
    const done = await packed.done;
    const result = await this.#json<{ skipped: { path: string; why: string }[] }>(
      this.#path(`/uploads/${upload}`),
      UploadResultSchema,
      {
        method: "PUT",
        json: {
          parts,
          bytes: done.bytes,
          sha256: done.sha256,
          format: "tar.gz",
          target,
          replace: options.replace,
          manifest: options.manifest ?? done.entries,
        },
        ...(options.deleted && options.deleted.length > 0
          ? { headers: { "x-delete": asciiJson(options.deleted) } }
          : {}),
        timeoutMs: TIMEOUTS.commit,
        maxBytes: LIST_REPLY_MAX_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return {
      entries: done.entries,
      skipped: [...done.skipped, ...result.skipped],
      bytes: done.bytes,
    };
  }

  async sync(signal?: AbortSignal): Promise<{
    changed: Manifest;
    deleted: string[];
    tar: { bytes: number; sha256: string; body: () => Promise<AsyncIterable<Uint8Array>> } | null;
    done(): Promise<void>;
  }> {
    this.#open();
    const id = newId().toLowerCase();
    const base = this.#path(`/syncs/${id}`);
    const result = await this.#json<{
      changed: Manifest;
      deleted: string[];
      tar: { bytes: number; sha256: string } | null;
    }>(base, SyncResultSchema, {
      method: "PUT",
      json: { target: "workspace" },
      timeoutMs: TIMEOUTS.sync,
      maxBytes: LIST_REPLY_MAX_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    const tar = result.tar;
    return {
      changed: result.changed,
      deleted: result.deleted,
      tar:
        tar === null
          ? null
          : {
              bytes: tar.bytes,
              sha256: tar.sha256,
              body: async () =>
                bodyChunks(
                  await this.#call(`${base}/tar`, {
                    method: "GET",
                    timeoutMs: TIMEOUTS.syncTar,
                    ...(signal === undefined ? {} : { signal }),
                  }),
                ),
            },
      done: async () => {
        await this.#call(base, { method: "DELETE", timeoutMs: TIMEOUTS.syncDrop });
      },
    };
  }

  #open(): void {
    if (this.#endedReason !== null) {
      throw new JobEndedError(this.id, this.#endedReason);
    }
  }

  /** Stops a running exec (`aborted`, or `quota` when its payer ran out). */
  async stopExec(exec: string, reason: "aborted" | "quota"): Promise<void> {
    await this.#call(this.#path(`/execs/${exec}?reason=${reason}`), {
      method: "DELETE",
      timeoutMs: TIMEOUTS.execStop,
    }).catch((error: unknown) => {
      log.debug({ job: this.id, exec, err: errorMessage(error) }, "cannot stop an exec");
    });
  }

  /** Stops every running exec (its payer ran out of CPU seconds). */
  stopAll(reason: "aborted" | "quota"): void {
    for (const exec of this.#execs.keys()) void this.stopExec(exec, reason);
  }

  /** Asks the computer about an exec directly. */
  async #askExec(exec: string): Promise<void> {
    try {
      const view = await this.#json<{ state: string; result: ExecResult | null }>(
        this.#path(`/execs/${exec}`),
        ExecViewSchema,
        { method: "GET", timeoutMs: TIMEOUTS.execView, maxBytes: this.#execReplyBytes },
      );
      if (view.result !== null) this.#finish(exec, view.result);
      else if (view.state === "lost") {
        const pending = this.#execs.get(exec);
        if (pending) this.#finish(exec, lostResult(pending.started, this.#link.clock.now()));
      }
    } catch (error) {
      if (
        error instanceof SandboxHttpError &&
        (error.code === "not_found" || error.code === "gone")
      ) {
        const pending = this.#execs.get(exec);
        if (pending) this.#finish(exec, lostResult(pending.started, this.#link.clock.now()));
      }
    }
  }

  async exec(
    start: SandboxExecStart,
    options: {
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", text: string) => void;
    } = {},
  ): Promise<SandboxExecResult> {
    this.#open();
    const unlock = await this.#queue.acquire(options.signal);
    if (unlock === null) {
      throw new SandboxHttpError(429, "busy", "too many runs wait for this job");
    }
    try {
      this.#open();
      const result = await this.#exec(start, options);
      return { ...result.result, log: () => this.#log(result.id) };
    } finally {
      unlock();
    }
  }

  async #exec(
    start: SandboxExecStart,
    options: {
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", text: string) => void;
    },
  ): Promise<{ id: string; result: ExecResult }> {
    const id = newId().toLowerCase();
    const started = this.#link.clock.now();
    let resolve: (result: ExecResult) => void = () => {};
    const done = new Promise<ExecResult>((r) => {
      resolve = r;
    });
    this.#execs.set(id, { started, base: this.#charged, resolve, onOutput: options.onOutput });
    const body: ExecStartIn = {
      ...(start.program === undefined ? {} : { program: start.program }),
      ...(start.argv === undefined ? {} : { argv: start.argv }),
      ...(start.stdin === undefined ? {} : { stdin: start.stdin }),
      ...(start.files === undefined ? {} : { files: start.files }),
      ...(start.cwd === undefined ? {} : { cwd: start.cwd }),
      timeout_ms: start.timeout_ms,
      ...(start.env === undefined ? {} : { env: start.env }),
      output: this.#link.output,
      collect: start.collectFiles === false ? null : this.#link.collect,
    };
    try {
      const view = await this.#json<{ result: ExecResult | null }>(
        this.#path(`/execs/${id}`),
        ExecViewSchema,
        {
          method: "PUT",
          json: body,
          timeoutMs: TIMEOUTS.execStart,
          maxBytes: this.#execReplyBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (view.result !== null) this.#finish(id, view.result);
    } catch (error) {
      this.#execs.delete(id);
      throw error;
    }
    const signal = options.signal;
    const onAbort = () => void this.stopExec(id, "aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    // The events should bring the end; asking now and then covers lost events, and past its own
    // limit plus a grace the exec is stopped and taken as lost.
    const poll = setInterval(() => void this.#askExec(id), EXEC_POLL_MS);
    poll.unref?.();
    const deadline = setTimeout(() => {
      void (async () => {
        await this.stopExec(id, "aborted");
        await this.#askExec(id);
        const pending = this.#execs.get(id);
        if (pending) this.#finish(id, lostResult(pending.started, this.#link.clock.now()));
      })();
    }, start.timeout_ms + EXEC_GRACE_MS);
    deadline.unref?.();
    try {
      return { id, result: await done };
    } finally {
      clearInterval(poll);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #log(exec: string): Promise<string> {
    const { bytes } = await callBytes(
      this.#link.source,
      this.#link.endpoint(),
      this.#path(`/execs/${exec}/log`),
      LOG_MAX_BYTES,
      { method: "GET", timeoutMs: TIMEOUTS.log, bodyTimeoutMs: LOG_BODY_MS },
    );
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  async proc(
    id: string,
    start: { argv: string[]; cwd?: "/work" | "/workspace" | "/ext"; env?: Record<string, string> },
  ): Promise<SandboxProc> {
    this.#open();
    const channel = new ProcChannel(id, {
      writeStdin: async (proc, offset, bytes) => {
        await this.#call(this.#path(`/procs/${proc}/stdin?offset=${offset}`), {
          method: "PUT",
          bytes,
          timeoutMs: TIMEOUTS.stdin,
        });
      },
      readStdout: async (proc, after, maxBytes) => {
        const { response, bytes } = await callBytes(
          this.#link.source,
          this.#link.endpoint(),
          this.#path(`/procs/${proc}/stdout?after=${after}`),
          maxBytes,
          { method: "GET", timeoutMs: TIMEOUTS.stdout, bodyTimeoutMs: STDOUT_BODY_MS },
        );
        const exitCode = response.headers.get("x-exit-code");
        return {
          bytes,
          next: Number(response.headers.get("x-next-offset") ?? after),
          exited: response.headers.get("x-proc-state") === "exited",
          code: exitCode === null || exitCode === "" ? null : Number(exitCode),
        };
      },
      kill: async (proc) => {
        await this.#call(this.#path(`/procs/${proc}`), {
          method: "DELETE",
          timeoutMs: TIMEOUTS.procStop,
        });
      },
    });
    this.#procs.set(id, channel);
    void channel.exited.then(() => this.#procs.delete(id));
    try {
      // Read as the contract says, so a service that answers otherwise fails here, not later.
      await this.#json<ProcView>(this.#path(`/procs/${id}`), ProcViewSchema, {
        method: "PUT",
        json: start,
        timeoutMs: TIMEOUTS.procStart,
      });
    } catch (error) {
      this.#procs.delete(id);
      throw error;
    }
    return channel;
  }

  async usage(): Promise<{ cpu_ms: number; wall_ms: number; disk_bytes: number }> {
    await this.refresh();
    const u = this.#view.usage;
    return { cpu_ms: u.cpu_ms, wall_ms: u.wall_ms, disk_bytes: u.disk_bytes };
  }

  /** `DELETE` the job; it is over whether the computer answered or not. */
  async close(): Promise<void> {
    if (this.#endedReason !== null) return;
    try {
      const view = await this.#json<JobView>(this.#path(), JobViewSchema, {
        method: "DELETE",
        timeoutMs: TIMEOUTS.close,
      });
      this.#chargeTo(view.usage.cpu_ms);
    } catch (error) {
      log.debug({ job: this.id, err: errorMessage(error) }, "closing a job did not answer");
    }
    this.end("closed");
  }
}

/** The job is over; nothing more can be done in it. */
export class JobEndedError extends Error {
  override readonly name = "JobEndedError";

  constructor(
    readonly job: string,
    readonly reason: string,
  ) {
    super(`sandbox job ${job} ended (${reason})`);
  }
}
