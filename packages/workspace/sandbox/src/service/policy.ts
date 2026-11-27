// What this machine's owner lets the sandbox service do: `[sandbox]` of `host.toml` with its
// defaults (docs/design/v6-sandbox.md §12.1), read again every 60 seconds. Core cannot change any
// of it. The TOML itself is parsed by the caller (`miyoria sandbox serve` hands hostd's
// `parseHostConfig` in), so this package needs no TOML parser and the rules are hostd's own.

import { readFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import type { HostConfig, HostSandboxConfig } from "@miyoria/contracts/host";
import { MIB } from "./util.js";

/** Parses the text of `host.toml` (hostd's `parseHostConfig`); throws with every problem. */
export type HostConfigParser = (
  file: string,
  text: string,
) => Pick<HostConfig, "sandbox" | "services">;

/** `[sandbox]` with every default filled in, and the owner's `[services.sandbox] concurrency`. */
export interface SandboxPolicy {
  members: boolean;
  plugins: boolean;
  cpus: number;
  memory_mb: number;
  disk_mb: number;
  max_job_cpus: number;
  max_job_memory_mb: number;
  runtime: string | null;
  /** Jobs at once: the descriptor's 4, lowered by `[services.sandbox] concurrency`. */
  concurrency: number;
}

/** `[routing] concurrency` of `workers/sandbox/routing.toml`. */
export const DESCRIPTOR_CONCURRENCY = 4;

export interface Machine {
  cpus: number;
  memoryMb: number;
}

export function thisMachine(): Machine {
  return { cpus: availableParallelism(), memoryMb: Math.floor(totalmem() / MIB) };
}

/** The defaults of §12.1 on `machine`, under what `table` says. */
export function policyOf(
  table: HostSandboxConfig | undefined,
  ownerConcurrency: number | undefined,
  machine: Machine,
): SandboxPolicy {
  const t = table ?? {};
  const cpus = t.cpus ?? Math.max(1, Math.floor(machine.cpus / 2));
  const memory = t.memory_mb ?? Math.max(512, Math.min(16_384, Math.floor(machine.memoryMb / 2)));
  return {
    members: t.members ?? false,
    plugins: t.plugins ?? false,
    cpus,
    memory_mb: memory,
    disk_mb: t.disk_mb ?? 20_480,
    max_job_cpus: Math.min(t.max_job_cpus ?? cpus, cpus),
    max_job_memory_mb: Math.min(t.max_job_memory_mb ?? memory, memory),
    runtime: t.runtime ?? null,
    concurrency: Math.max(
      1,
      Math.min(DESCRIPTOR_CONCURRENCY, ownerConcurrency ?? DESCRIPTOR_CONCURRENCY),
    ),
  };
}

export interface PolicyReading {
  policy: SandboxPolicy;
  /** Why `host.toml` could not be read (the last good rules, or the defaults, stay). */
  error: string | null;
}

/** Reads `host.toml` and keeps the last good reading when a new one fails. */
export class PolicyFile {
  #last: SandboxPolicy | null = null;

  constructor(
    readonly file: string,
    readonly parse: HostConfigParser | null,
    readonly machine: Machine = thisMachine(),
  ) {}

  async read(): Promise<PolicyReading> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      // No host.toml (a service started by hand): the defaults, which take no member's work.
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.#keep(undefined, undefined);
      return this.#fail(error);
    }
    if (this.parse === null) return this.#keep(undefined, undefined);
    try {
      const config = this.parse(this.file, text);
      return this.#keep(config.sandbox, config.services?.sandbox?.concurrency);
    } catch (error) {
      return this.#fail(error);
    }
  }

  #keep(table: HostSandboxConfig | undefined, concurrency: number | undefined): PolicyReading {
    this.#last = policyOf(table, concurrency, this.machine);
    return { policy: this.#last, error: null };
  }

  #fail(error: unknown): PolicyReading {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    return { policy: this.#last ?? policyOf(undefined, undefined, this.machine), error: message };
  }
}

/** Whether `policy` takes a job for `forWho`. */
export function accepts(policy: SandboxPolicy, forWho: string): boolean {
  if (forWho === "member") return policy.members;
  if (forWho === "plugin") return policy.plugins;
  return true;
}
