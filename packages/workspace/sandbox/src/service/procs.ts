// Background programs of browser and plugin jobs (docs/design/v6-sandbox.md §3.7): a
// `docker exec -i` whose stdin, stdout and stderr are a byte channel. Writes carry the offset
// Core counted, so a resent write is never written twice; output goes out as `proc_out` events,
// and the last 4 MiB of each stream stay to be fetched again when Core missed some.

import type { ProcStart, ProcView } from "@miyoria/contracts/workers";
import { execWithArgs } from "../args.js";
import type { Job, ProcHandle } from "./jobs.js";
import { accepts } from "./policy.js";
import { log, MIB, requestHash, ServiceError } from "./util.js";
import { checkProcStart } from "./validate.js";

/** Output kept per stream for `GET .../stdout?after=`. */
export const KEEP_PROC_OUTPUT = 4 * MIB;
/** Largest single stdin write. */
export const MAX_STDIN_WRITE = 1 * MIB;
const CPU_EVERY_MS = 10_000;
const DISK_EVERY_MS = 5_000;

/** The last bytes of one stream and where they are in it. */
export class Retained {
  #chunks: Buffer[] = [];
  #kept = 0;
  /** Bytes seen since the start. */
  total = 0;

  constructor(readonly limit: number = KEEP_PROC_OUTPUT) {}

  /** Offset of the first byte still kept. */
  get start(): number {
    return this.total - this.#kept;
  }

  push(chunk: Buffer): number {
    const offset = this.total;
    this.#chunks.push(chunk);
    this.#kept += chunk.length;
    this.total += chunk.length;
    while (this.#kept > this.limit && this.#chunks.length > 0) {
      const first = this.#chunks[0] as Buffer;
      const over = this.#kept - this.limit;
      if (first.length <= over) {
        this.#chunks.shift();
        this.#kept -= first.length;
      } else {
        this.#chunks[0] = first.subarray(over);
        this.#kept -= over;
      }
    }
    return offset;
  }

  /** The bytes from `after` on; `null` when some of them are no longer kept. */
  from(after: number): Buffer | null {
    if (after < this.start) return null;
    if (after >= this.total) return Buffer.alloc(0);
    return Buffer.concat(this.#chunks).subarray(after - this.start);
  }
}

/** The wire shape (`@miyoria/contracts/workers`). */
export type { ProcView };

class Proc implements ProcHandle {
  running = true;
  code: number | null = null;
  signal: string | null = null;
  written = 0;
  readonly out = { stdout: new Retained(), stderr: new Retained() };
  #writing: Promise<void> = Promise.resolve();

  constructor(
    readonly job: Job,
    readonly id: string,
    readonly hash: string,
    readonly child: ReturnType<Job["ctx"]["spawner"]["spawn"]>,
  ) {}

  view(): ProcView {
    return {
      id: this.id,
      state: this.running ? "running" : "exited",
      code: this.code,
      signal: this.signal,
      stdin_offset: this.written,
      stdout_offset: this.out.stdout.total,
      stderr_offset: this.out.stderr.total,
    };
  }

  /**
   * Writes `data` that Core says starts at `offset`: at the written end it is written; what was
   * written already is not written again; a gap is a conflict.
   */
  write(offset: number, data: Buffer): Promise<void> {
    const task = this.#writing.then(async () => {
      if (!this.running) throw new ServiceError("gone", "the proc has exited");
      if (offset > this.written) {
        throw new ServiceError("conflict", `stdin is at ${this.written}, not ${offset}`);
      }
      const fresh = data.subarray(Math.min(data.length, this.written - offset));
      if (fresh.length === 0) return;
      this.written += fresh.length;
      this.job.used();
      if (!this.child.stdin.write(fresh)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            this.child.stdin.off("drain", done);
            this.child.stdin.off("close", done);
            resolve();
          };
          this.child.stdin.once("drain", done);
          this.child.stdin.once("close", done);
        });
      }
    });
    this.#writing = task.catch(() => undefined);
    return task;
  }

  /** Kills the program (its process group, then the CLI). */
  async stop(): Promise<void> {
    if (!this.running) return;
    const { ctx } = this.job;
    await ctx.docker.run([
      "exec",
      "--user",
      ctx.user,
      this.job.container,
      "sh",
      "-c",
      `p=$(cat ${pidFile(this.id)} 2>/dev/null) && { kill -KILL -- -"$p" 2>/dev/null; kill -KILL "$p"; }; exit 0`,
    ]);
    this.child.kill();
    await Promise.race([this.child.exited, new Promise((r) => setTimeout(r, 5_000))]);
  }
}

function pidFile(id: string): string {
  return `/tmp/.miyoria-proc-${id}`;
}

function procOf(job: Job, id: string): Proc {
  const proc = job.procs.get(id);
  if (!(proc instanceof Proc)) throw new ServiceError("not_found", "no such proc");
  return proc;
}

/** `PUT .../procs/{proc}`. */
export async function startProc(
  job: Job,
  id: string,
  start: ProcStart,
): Promise<{ status: 200 | 201; view: ProcView }> {
  const hash = requestHash(start);
  return await job.lock.run(async () => {
    const known = job.procs.get(id);
    if (known instanceof Proc) {
      if (known.hash !== hash)
        throw new ServiceError("conflict", "this proc id was used for another proc");
      return { status: 200, view: known.view() };
    }
    job.assertLive();
    if (job.request.kind !== "browser" && job.request.kind !== "plugin") {
      throw new ServiceError("conflict", "only a browser or plugin job runs procs");
    }
    if (!accepts(job.ctx.policy(), job.request.for)) {
      void job.end("host_policy");
      throw new ServiceError("gone", "this machine no longer takes this kind of job", {
        ended: { reason: "host_policy", at: job.ctx.clock.now() },
      });
    }
    checkProcStart(start);
    const { ctx } = job;
    // The wrapper notes its pid, so a stop kills this proc and not the job's other ones.
    const command = ["sh", "-c", `echo $$ > ${pidFile(id)}; exec "$@"`, "sh", ...start.argv];
    const child = ctx.spawner.spawn(
      execWithArgs(job.container, command, {
        user: ctx.user,
        workdir: start.cwd ?? "/workspace",
        env: start.env ?? {},
      }),
    );
    const proc = new Proc(job, id, hash, child);
    job.procs.set(id, proc);
    job.used();
    const forward = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const offset = proc.out[stream].push(chunk);
      job.used();
      job.emit({
        job: job.id,
        proc: id,
        kind: "proc_out",
        stream,
        offset,
        data_b64: chunk.toString("base64"),
      });
    };
    child.stdout.on("data", forward("stdout"));
    child.stderr.on("data", forward("stderr"));
    const tickers = watch(job);
    void child.exited.then(({ code, signal }) => {
      proc.running = false;
      proc.code = code;
      proc.signal = signal;
      tickers();
      job.emit({ job: job.id, proc: id, kind: "proc_exit", code, signal });
      log.info({ job: job.id, proc: id, code, signal }, "sandbox proc exited");
      void job.persist();
    });
    await job.persist();
    return { status: 201, view: proc.view() };
  });
}

/** CPU every 10 s and disk every 5 s while a proc runs; returns the stop. */
function watch(job: Job): () => void {
  let measuring = false;
  const cpu = setInterval(() => {
    if (job.paused) return;
    void job.cpu.read().then((cpu_ms) => job.emit({ job: job.id, kind: "cpu", cpu_ms }));
  }, CPU_EVERY_MS);
  const disk = setInterval(() => {
    if (measuring) return;
    measuring = true;
    void job
      .measureDisk()
      .then(({ over }) => {
        if (over) void job.end("disk");
      })
      .finally(() => {
        measuring = false;
      });
  }, DISK_EVERY_MS);
  return () => {
    clearInterval(cpu);
    clearInterval(disk);
  };
}

export function procView(job: Job, id: string): ProcView {
  return procOf(job, id).view();
}

/** `PUT .../procs/{proc}/stdin?offset=`. */
export async function writeStdin(
  job: Job,
  id: string,
  offset: number,
  data: Buffer,
): Promise<ProcView> {
  if (!Number.isInteger(offset) || offset < 0)
    throw new ServiceError("bad_request", "offset must be a whole number");
  if (data.length > MAX_STDIN_WRITE) throw new ServiceError("too_large", "at most 1 MiB per write");
  const proc = procOf(job, id);
  await proc.write(offset, data);
  return proc.view();
}

/** `GET .../procs/{proc}/stdout?after=`: the bytes, and where the stream is. */
export function readOutput(
  job: Job,
  id: string,
  stream: "stdout" | "stderr",
  after: number,
): { data: Buffer; next: number; view: ProcView } {
  if (!Number.isInteger(after) || after < 0)
    throw new ServiceError("bad_request", "after must be a whole number");
  const proc = procOf(job, id);
  const data = proc.out[stream].from(after);
  if (data === null) throw new ServiceError("gone", "that output is no longer kept");
  return { data, next: after + data.length, view: proc.view() };
}

/** `DELETE .../procs/{proc}`. */
export async function stopProc(job: Job, id: string): Promise<ProcView> {
  const proc = procOf(job, id);
  await proc.stop();
  return proc.view();
}
