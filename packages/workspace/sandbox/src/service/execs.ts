// One exec in a job (docs/design/v6-sandbox.md §3.6): what `DockerSandbox#execInSession` does,
// on a job's container. The program file goes to /code, input files to /work, then
// `docker exec -i` as the program's uid. Its output goes to the result (the first `keep_bytes`),
// to the events (the first `stream_bytes`) and to the log (up to `kill_bytes`, where it is
// stopped). Whatever ends it (exit, timeout, abort, quota, output, disk), every process of the
// program's uid is killed after, so nothing it started outlives it and nothing changes /work while
// the host reads it.

import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult, ExecStart, ExecView } from "@miyoria/contracts/workers";
import { execWithArgs, killAllArgs, removeArgs } from "../args.js";
import type { SandboxCaps } from "../config.js";
import { SandboxError } from "../types.js";
import { collectOutputs, signatures, walkWork, writeInputs } from "../workspace.js";
import { containerState, type ExecRecord, type Job, jobDirs } from "./jobs.js";
import { accepts } from "./policy.js";
import { decode, log, requestHash, ServiceError, succeeded } from "./util.js";
import { checkExecStart, EXEC_BOUNDS } from "./validate.js";

type KilledReason = NonNullable<ExecResult["killed_reason"]>;

const CPU_EVERY_MS = 10_000;
const DISK_EVERY_MS = 5_000;
/** Entries of /work an output walk looks at. */
const MAX_WORK_ENTRIES = 10_000;
/** A `docker exec` failure of the CLI or the daemon (not of the program). */
const DAEMON_ERROR =
  /^(Error response from daemon|error during connect|Cannot connect to the Docker daemon)/m;

const EXTENSION = { python: "py", node: "mjs", shell: "sh" } as const;

/**
 * The command of a program file. Python without `-I`: packages she installed with `pip` (under
 * /home/sandbox/.local) must be importable; the environment is the job's own anyway.
 */
function programCommand(language: keyof typeof EXTENSION, file: string): string[] {
  if (language === "python") return ["python3", "-B", "-u", file];
  if (language === "node") return ["node", file];
  return ["bash", file];
}

function caps(start: ExecStart): SandboxCaps {
  return {
    max_code_bytes: EXEC_BOUNDS.codeBytes,
    max_stdin_bytes: EXEC_BOUNDS.stdinBytes,
    max_files_in: EXEC_BOUNDS.files,
    max_files_in_bytes: EXEC_BOUNDS.filesBytes,
    max_output_bytes: start.output.keep_bytes,
    kill_output_bytes: start.output.kill_bytes,
    max_files_out: start.collect?.max_files ?? 0,
    max_files_out_bytes: start.collect?.max_bytes ?? 0,
  };
}

/** `GET .../execs/{exec}`. */
export function execView(job: Job, id: string): ExecView {
  const record = job.execs.get(id);
  if (record !== undefined) {
    return { id, state: record.state, started_at: record.started_at, result: record.result };
  }
  if (job.lostExec === id) return { id, state: "lost", started_at: job.createdAt, result: null };
  throw new ServiceError("not_found", "no such exec");
}

/**
 * `PUT .../execs/{exec}`: starts it and answers at once (202). The same id with the same body is
 * the same exec; with another body 409, as is a second exec while one runs.
 */
export async function startExec(
  job: Job,
  id: string,
  start: ExecStart,
): Promise<{ status: 200 | 202; view: ExecView }> {
  const hash = requestHash(start);
  return await job.lock.run(async () => {
    const known = job.execs.get(id);
    if (known !== undefined) {
      if (known.hash !== hash)
        throw new ServiceError("conflict", "this exec id was used for another exec");
      return { status: 200, view: execView(job, id) };
    }
    job.assertLive();
    if (job.request.kind !== "run" && job.request.kind !== "session") {
      throw new ServiceError("conflict", "a browser or plugin job runs procs, not execs");
    }
    if (job.current !== null) throw new ServiceError("conflict", "an exec is running in this job");
    if (!accepts(job.ctx.policy(), job.request.for)) {
      void job.end("host_policy");
      throw new ServiceError("gone", "this machine no longer takes this kind of job", {
        ended: { reason: "host_policy", at: job.ctx.clock.now() },
      });
    }
    checkExecStart(start);
    const dirs = job.dirs;
    let command: string[];
    let codeFile: string | null = null;
    if (start.program !== undefined) {
      const name = `${id}.${EXTENSION[start.program.language]}`;
      codeFile = join(dirs.code, name);
      await writeFile(codeFile, start.program.code, { flag: "wx", mode: 0o644 });
      command = programCommand(start.program.language, `/code/${name}`);
    } else command = [...(start.argv as string[])];
    let inputs: Map<string, string>;
    let before: Map<string, string> | undefined;
    try {
      inputs = await writeInputs(dirs.work, start.files ?? [], caps(start), { replace: true });
      if (start.collect !== null) {
        before = signatures(await walkWork(dirs.work, MAX_WORK_ENTRIES));
      }
    } catch (error) {
      if (codeFile !== null) await rm(codeFile, { force: true });
      if (error instanceof SandboxError) throw new ServiceError("bad_request", error.message);
      throw error;
    }
    const cpuAtStart = await job.cpu.read();
    const record = run(job, id, hash, start, command, codeFile, inputs, before, cpuAtStart);
    // The answer says it started, however fast it ends.
    const view: ExecView = { id, state: "running", started_at: record.started_at, result: null };
    job.execs.set(id, record);
    job.current = record;
    job.used();
    job.setState("busy");
    await job.persist();
    return { status: 202, view };
  });
}

function run(
  job: Job,
  id: string,
  hash: string,
  start: ExecStart,
  command: string[],
  codeFile: string | null,
  inputs: Map<string, string>,
  before: Map<string, string> | undefined,
  cpuAtStart: number,
): ExecRecord {
  const { ctx } = job;
  const logFile = join(job.dirs.execs, `${id}.log`);
  const startedAt = ctx.clock.now();
  const state: { killed: KilledReason | null; containerGone: boolean } = {
    killed: null,
    containerGone: false,
  };
  const cli = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const record: ExecRecord = {
    id,
    hash,
    state: "running",
    started_at: startedAt,
    result: null,
    logFile,
    done,
    kill: (reason) => {
      if (state.killed !== null || record.state !== "running") return;
      state.killed = reason;
      void (async () => {
        const killed = await ctx.docker.run(killAllArgs(job.container, ctx.user));
        if (!succeeded(killed)) {
          // No room for even a `kill` (its pids are used up, say): the container goes instead.
          state.containerGone = true;
          await ctx.docker.run(removeArgs([job.container]));
        }
        await new Promise((resolve) => setTimeout(resolve, ctx.killGraceMs));
        cli.abort();
      })();
    },
  };

  void (async () => {
    const out = start.output;
    const logHandle = await open(logFile, "w");
    let logBytes = 0;
    let writing: Promise<unknown> = Promise.resolve();
    let streamed = 0;
    const decoders = {
      stdout: new TextDecoder("utf-8", { fatal: false }),
      stderr: new TextDecoder("utf-8", { fatal: false }),
    };
    const onData = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (logBytes < out.kill_bytes) {
        const part = chunk.subarray(0, out.kill_bytes - logBytes);
        logBytes += part.length;
        writing = writing.then(() => logHandle.write(part)).catch(() => undefined);
      }
      if (streamed < out.stream_bytes) {
        const part = chunk.subarray(0, out.stream_bytes - streamed);
        streamed += part.length;
        const text = decoders[stream].decode(part, { stream: true });
        if (text !== "") job.emit({ job: job.id, exec: id, kind: stream, text });
      }
      job.used();
    };
    const timer = setTimeout(() => record.kill("timeout"), start.timeout_ms);
    const cpuTicker = setInterval(() => {
      void job.cpu.read().then((cpu_ms) => job.emit({ job: job.id, kind: "cpu", cpu_ms }));
    }, CPU_EVERY_MS);
    let measuring = false;
    const diskTicker = setInterval(() => {
      if (measuring) return;
      measuring = true;
      void job
        .measureDisk()
        .then(({ over }) => {
          if (over) {
            job.endAfterExec = "disk";
            record.kill("disk");
          }
        })
        .finally(() => {
          measuring = false;
        });
    }, DISK_EVERY_MS);

    let exitCode: number | null = null;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    try {
      const result = await ctx.runner.exec(
        execWithArgs(job.container, command, {
          user: ctx.user,
          workdir: start.cwd ?? "/workspace",
          env: start.env ?? {},
        }),
        {
          stdin: start.stdin ?? null,
          signal: cli.signal,
          maxOutputBytes: out.keep_bytes,
          outputLimit: { bytes: out.kill_bytes, onExceeded: () => record.kill("output_limit") },
          onData,
        },
      );
      exitCode = result.exit_code;
      stdout = result.stdout;
      stderr = result.stderr;
      stdoutBytes = result.stdout_bytes;
      stderrBytes = result.stderr_bytes;
      if (
        state.killed === null &&
        (result.error !== null ||
          (result.exit_code !== 0 && DAEMON_ERROR.test(decode(result.stderr))))
      ) {
        // The program can print the same words, so ask Docker whether the container is there.
        const where = await containerState(ctx.docker, job.container);
        if (where === "gone" || where === "stopped") {
          state.killed = "lost";
          state.containerGone = true;
        }
      }
    } finally {
      clearTimeout(timer);
      clearInterval(cpuTicker);
      clearInterval(diskTicker);
      cli.abort();
    }
    const duration = ctx.clock.now() - startedAt;

    // Nothing it started outlives it; a container where even that fails is not trusted again.
    const cleared =
      !state.containerGone && succeeded(await ctx.docker.run(killAllArgs(job.container, ctx.user)));
    if (!cleared) {
      state.containerGone = true;
      state.killed ??= "lost";
    }
    const cpuAtEnd = cleared ? await job.cpu.read() : job.cpu.totalMs;
    let files: { files: ExecResult["files_out"]; truncated: boolean } = {
      files: [],
      truncated: false,
    };
    if (cleared && start.collect !== null && state.killed !== "aborted") {
      files = await collectOutputs(job.dirs.work, inputs, caps(start), {
        before,
        walked: await walkWork(job.dirs.work, MAX_WORK_ENTRIES),
      }).catch(() => ({ files: [], truncated: true }));
    }
    await writing;
    await logHandle.close().catch(() => undefined);
    if (codeFile !== null) await rm(codeFile, { force: true }).catch(() => undefined);

    const killed: KilledReason | null = state.killed ?? (exitCode === 137 ? "memory" : null);
    const result: ExecResult = {
      exit_code: exitCode,
      killed_reason: killed,
      duration_ms: duration,
      cpu_ms: Math.max(0, cpuAtEnd - cpuAtStart),
      stdout: decode(stdout),
      stderr: decode(stderr),
      stdout_truncated: stdoutBytes > out.keep_bytes,
      stderr_truncated: stderrBytes > out.keep_bytes,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      files_out: files.files,
      files_out_truncated: files.truncated,
      log_bytes: logBytes,
    };
    record.result = result;
    record.state = "done";
    if (job.current === record) job.current = null;
    job.used();
    job.emit({ job: job.id, exec: id, kind: "exit", result });
    job.emit({ job: job.id, kind: "cpu", cpu_ms: job.cpu.totalMs });
    log.info(
      {
        job: job.id,
        exec: id,
        exit: exitCode,
        killed,
        duration_ms: duration,
        cpu_ms: result.cpu_ms,
      },
      "sandbox exec finished",
    );
    let endWith = job.endAfterExec;
    if (endWith === null && !state.containerGone) {
      const disk = await job.measureDisk().catch(() => ({ over: false }));
      if (disk.over) endWith = "disk";
    }
    if (state.containerGone) endWith = "lost";
    if (job.ending) return;
    if (endWith !== null) await job.end(endWith);
    else {
      job.setState("ready");
      await job.persist();
    }
  })()
    .catch((error: unknown) => {
      log.error({ job: job.id, exec: id, err: String(error) }, "sandbox exec failed");
      record.state = "lost";
      if (job.current === record) job.current = null;
      void job.end("lost");
    })
    .finally(() => finish());
  return record;
}

/** `DELETE .../execs/{exec}?reason=aborted|quota`. */
export function stopExec(job: Job, id: string, reason: string | null): ExecView {
  const record = job.execs.get(id);
  if (record === undefined) return execView(job, id);
  const why: KilledReason = reason === "quota" ? "quota" : "aborted";
  record.kill(why);
  return execView(job, id);
}

/** The folder of a job's exec logs, for the log route. */
export function execLogFile(job: Job, id: string): string {
  const record = job.execs.get(id);
  if (record === undefined) throw new ServiceError("not_found", "no such exec");
  return record.logFile ?? join(jobDirs(job.ctx.jobsDir, job.id).execs, `${id}.log`);
}
