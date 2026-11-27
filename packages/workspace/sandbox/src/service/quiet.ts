// The host reads and writes a job's /work and /workspace (uploads, syncs), and those folders are
// the program's: a process still running in the container could swap a directory for a link
// between the host's check and its open, and steer the host into its own files (reading a key
// out, or writing over one). So nothing of the program runs while the host is in there: in a run
// or session job every process of the program's uid is killed (between execs none should be
// left), and a browser or plugin job, whose procs must live on, is frozen with `docker pause`.

import { killAllArgs, pauseArgs } from "../args.js";
import type { Job } from "./jobs.js";
import { ServiceError, succeeded, why } from "./util.js";

export async function whileQuiet<T>(job: Job, task: () => Promise<T>): Promise<T> {
  if (job.current !== null) throw new ServiceError("conflict", "an exec is running in this job");
  const { docker, user } = job.ctx;
  const procs = [...job.procs.values()].some((p) => p.running);
  if (!procs) {
    const cleared = await docker.run(killAllArgs(job.container, user));
    if (!succeeded(cleared)) {
      throw new ServiceError("docker_failed", `cannot stop the job's programs: ${why(cleared)}`);
    }
    return await task();
  }
  const paused = await docker.run(pauseArgs(job.container, true));
  if (!succeeded(paused)) {
    throw new ServiceError(
      "conflict",
      `cannot pause the job while its files are read: ${why(paused)}`,
    );
  }
  job.paused = true;
  try {
    return await task();
  } finally {
    await docker.run(pauseArgs(job.container, false));
    job.paused = false;
  }
}
