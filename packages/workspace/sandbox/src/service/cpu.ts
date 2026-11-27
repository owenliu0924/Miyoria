// CPU a job used (docs/design/v6-sandbox.md §7): its own cgroup's running total, read inside the
// container (`--cgroupns private` makes `/sys/fs/cgroup` the container's own; `/sys` is read-only
// there, so the program cannot change it). Read as the keeper's uid, not the program's. When
// neither cgroup file can be read, `docker stats` is sampled and summed (`sampled`, less exact).

import { type DockerControl, decode, succeeded } from "./util.js";

/** `usage_usec` of cgroup v2's `cpu.stat`, in ms; `null` when it is not there. */
export function parseCpuStat(text: string): number | null {
  const match = /^usage_usec\s+(\d+)\s*$/m.exec(text);
  if (match === null) return null;
  return Math.floor(Number(match[1]) / 1000);
}

/** cgroup v1's `cpuacct.usage` (nanoseconds), in ms. */
export function parseCpuacctUsage(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Math.floor(Number(trimmed) / 1_000_000);
}

/** `docker stats`' `CPUPerc` (`"12.34%"`) as a fraction of one CPU. */
export function parseCpuPercent(text: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)%\s*$/.exec(text);
  return match === null ? null : Number(match[1]) / 100;
}

const CGROUP_V2 = ["cat", "/sys/fs/cgroup/cpu.stat"];
const CGROUP_V1 = ["cat", "/sys/fs/cgroup/cpuacct/cpuacct.usage"];

/** One job's CPU total, which only ever grows. */
export class CpuMeter {
  #total = 0;
  #source: "cgroup" | "sampled" = "cgroup";
  #sampledAt: number | null = null;
  #which: "v2" | "v1" | null = null;
  /** When the cgroup was last read. */
  #readAt: number | null = null;

  constructor(
    readonly docker: DockerControl,
    readonly container: string,
    readonly keeper: string,
    readonly now: () => number,
  ) {}

  get totalMs(): number {
    return this.#total;
  }

  get source(): "cgroup" | "sampled" {
    return this.#source;
  }

  /**
   * The total at the end of an exec whose processes could not be cleared (a fork bomb that used
   * every pid, so not even `cat` of the cgroup can start in the container). Without a fresh
   * reading, the time since the last one is counted at the job's full `cpus`: such a container
   * spins at its ceiling, and the payer must not get those seconds free.
   */
  async final(cpus: number): Promise<number> {
    const before = this.#readAt;
    await this.read();
    if (this.#readAt === before && before !== null) {
      const now = this.now();
      this.#total += Math.round(Math.max(0, cpus) * Math.max(0, now - before));
      this.#readAt = now;
      this.#source = "sampled";
    }
    return this.#total;
  }

  /** Reads the total now. A reading that fails leaves the last total; it is a running total. */
  async read(): Promise<number> {
    for (const which of this.#which === null ? (["v2", "v1"] as const) : [this.#which]) {
      const command = which === "v2" ? CGROUP_V2 : CGROUP_V1;
      const result = await this.docker.run([
        "exec",
        "--user",
        this.keeper,
        this.container,
        ...command,
      ]);
      if (!succeeded(result)) continue;
      const text = decode(result.stdout);
      const ms = which === "v2" ? parseCpuStat(text) : parseCpuacctUsage(text);
      if (ms === null) continue;
      this.#which = which;
      // After a sampled stretch the true total takes over again once it is the larger one.
      this.#total = Math.max(this.#total, ms);
      this.#sampledAt = null;
      this.#readAt = this.now();
      return this.#total;
    }
    await this.#sample();
    return this.#total;
  }

  /** `docker stats --no-stream`: the share of a CPU now, times the time since the last sample. */
  async #sample(): Promise<void> {
    const now = this.now();
    const out = await this.docker.text([
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}",
      this.container,
    ]);
    const share = out === null ? null : parseCpuPercent(out.split("\n")[0] ?? "");
    if (share !== null) {
      this.#source = "sampled";
      if (this.#sampledAt !== null) this.#total += Math.round(share * (now - this.#sampledAt));
    }
    this.#sampledAt = now;
  }

  /** The cgroup version found, once a reading worked. */
  get cgroup(): "v2" | "v1" | null {
    return this.#which;
  }
}
