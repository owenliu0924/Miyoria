// A scripted Docker for the sandbox service's tests: containers, networks, images, `docker exec`
// of programs (answered by `onProgram`), the kill-all, `pause`, the cgroup and egress counters.
// Every call is recorded; nothing touches a real daemon.

import { PassThrough } from "node:stream";
import type { DockerRunner, ExecOptions, ExecResult } from "../../src/runner.js";
import type { ProcSpawner, SpawnedProc } from "../../src/service/spawner.js";

export function result(over: Partial<ExecResult> = {}): ExecResult {
  const stdout = over.stdout ?? Buffer.alloc(0);
  const stderr = over.stderr ?? Buffer.alloc(0);
  return {
    exit_code: 0,
    stdout,
    stderr,
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    error: null,
    ...over,
  };
}

const gone = (name: string) =>
  result({
    exit_code: 1,
    stderr: Buffer.from(`Error response from daemon: No such container: ${name}\n`),
  });

export interface FakeContainer {
  name: string;
  args: string[];
  labels: Record<string, string>;
  running: boolean;
  paused: boolean;
}

/** A `docker exec` split into its parts. */
export interface ExecCall {
  user: string | null;
  workdir: string | null;
  env: Record<string, string>;
  container: string;
  command: string[];
}

export function parseExec(args: readonly string[]): ExecCall {
  const call: ExecCall = { user: null, workdir: null, env: {}, container: "", command: [] };
  let i = 1;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    const flag = args[i] as string;
    if (flag === "--user") call.user = args[++i] as string;
    else if (flag === "--workdir") call.workdir = args[++i] as string;
    else if (flag === "--env") {
      const [k, ...v] = (args[++i] as string).split("=");
      call.env[k as string] = v.join("=");
    }
    i++;
  }
  call.container = args[i] as string;
  call.command = args.slice(i + 1) as string[];
  return call;
}

export type ProgramHandler = (call: ExecCall, options: ExecOptions) => Promise<ExecResult>;

export class FakeDocker implements DockerRunner {
  readonly calls: string[][] = [];
  up = true;
  readonly images = new Set<string>();
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, Record<string, string>>();
  /** cgroup `usage_usec` of every container (grows as the test says). */
  cpuUsec = 0;
  /** The kill-all fails (pids used up, say). */
  killFails = false;
  pauseFails = false;
  /** What the proxy's `/tmp/egress.json` says. */
  egress = {
    bytes_in: 0,
    bytes_out: 0,
    open: 0,
    total: 0,
    refused: { address: 0, port: 0, cap: 0 },
    limited: false,
  };
  onProgram: ProgramHandler = async () => result({ stdout: Buffer.from("ok\n") });
  /** Programs that were run, in order. */
  readonly programs: ExecCall[] = [];
  /** Kill-alls, by container. */
  readonly killAlls: string[] = [];

  calledWith(first: string, second?: string): string[][] {
    return this.calls.filter((c) => c[0] === first && (second === undefined || c[1] === second));
  }

  /** The `docker run -d` of the job container (not the proxy). */
  jobRun(): string[] | undefined {
    return this.calledWith("run").find(
      (c) => !c.includes("EGRESS_PROGRAM") && !c.some((a) => a.startsWith("EGRESS_MODE=")),
    );
  }

  async exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    this.calls.push([...args]);
    const [command, sub] = args;
    if (!this.up) {
      return result({
        exit_code: 1,
        stderr: Buffer.from("error during connect: the daemon is down\n"),
      });
    }
    switch (command) {
      case "version":
        return result({ stdout: Buffer.from("27.1.0\n") });
      case "info":
        return result({ stdout: Buffer.from("2\n") });
      case "image": {
        if (sub === "inspect")
          return this.images.has(args.at(-1) as string)
            ? result({ stdout: Buffer.from("sha256:x\n") })
            : result({ exit_code: 1, stderr: Buffer.from("No such image\n") });
        return result();
      }
      case "network": {
        if (sub === "create") {
          const name = args.at(-1) as string;
          const labels: Record<string, string> = {};
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "--label") {
              const [k, v] = (args[i + 1] as string).split("=");
              labels[k as string] = v as string;
            }
          }
          this.networks.set(name, labels);
          return result();
        }
        if (sub === "rm") {
          const existed = this.networks.delete(args[2] as string);
          return existed
            ? result()
            : result({ exit_code: 1, stderr: Buffer.from("Error: No such network\n") });
        }
        if (sub === "ls") {
          const instance = /miyoria\.sandbox\.instance=(\S+)/.exec(args.join(" "))?.[1];
          const lines = [...this.networks.entries()]
            .filter(([, l]) => l["miyoria.sandbox.instance"] === instance)
            .map(([n, l]) => `${n} ${l["miyoria.sandbox.job"] ?? ""}`);
          return result({ stdout: Buffer.from(lines.join("\n")) });
        }
        if (sub === "inspect")
          return result({ stdout: Buffer.from("172.17.0.1 172.17.0.0/16 \n") });
        return result();
      }
      case "run": {
        const name = args[args.indexOf("--name") + 1] as string;
        const labels: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--label") {
            const [k, v] = (args[i + 1] as string).split("=");
            labels[k as string] = v as string;
          }
        }
        this.containers.set(name, { name, args: [...args], labels, running: true, paused: false });
        return result({ stdout: Buffer.from("f00d\n") });
      }
      case "container": {
        const c = this.containers.get(args.at(-1) as string);
        if (c === undefined) return gone(args.at(-1) as string);
        return result({ stdout: Buffer.from(c.running ? "true\n" : "false\n") });
      }
      case "rm": {
        this.resolveIds(args.slice(2));
        for (const name of args.slice(2)) this.containers.delete(name);
        return result();
      }
      case "pause":
      case "unpause": {
        const c = this.containers.get(sub as string);
        if (c === undefined) return gone(sub as string);
        if (this.pauseFails) return result({ exit_code: 1, stderr: Buffer.from("cannot pause\n") });
        c.paused = command === "pause";
        return result();
      }
      case "ps": {
        const instance = /miyoria\.sandbox\.instance=(\S+)/.exec(args.join(" "))?.[1];
        const lines = [...this.containers.values()]
          .filter((c) => c.labels["miyoria.sandbox.instance"] === instance)
          .map(
            (c, i) =>
              `${(0xabc000000000 + i).toString(16)} ${c.labels["miyoria.sandbox.job"] ?? ""}`,
          );
        // `rm` of those ids removes the containers they stand for.
        this.#ids = new Map(
          [...this.containers.values()]
            .filter((c) => c.labels["miyoria.sandbox.instance"] === instance)
            .map((c, i) => [(0xabc000000000 + i).toString(16), c.name]),
        );
        return result({ stdout: Buffer.from(lines.join("\n")) });
      }
      case "stats":
        return result({ stdout: Buffer.from("0.00%\n") });
      case "exec":
        return await this.#exec(args, options);
      default:
        return result();
    }
  }

  #ids = new Map<string, string>();

  /** `rm` with container ids from `ps`. */
  resolveIds(args: readonly string[]): void {
    for (const a of args) {
      const name = this.#ids.get(a);
      if (name !== undefined) this.containers.delete(name);
    }
  }

  async #exec(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    const call = parseExec(args);
    const c = this.containers.get(call.container);
    if (c === undefined || !c.running) return gone(call.container);
    if (c.paused)
      return result({
        exit_code: 1,
        stderr: Buffer.from("Error response from daemon: container is paused\n"),
      });
    const joined = call.command.join(" ");
    if (call.command[0] === "node" && call.command[1] === "-e") return result();
    if (joined === "cat /sys/fs/cgroup/cpu.stat") {
      return result({
        stdout: Buffer.from(`usage_usec ${this.cpuUsec}\nuser_usec 1\nsystem_usec 1\n`),
      });
    }
    if (joined === "cat /tmp/egress.json")
      return result({ stdout: Buffer.from(JSON.stringify(this.egress)) });
    if (call.command[0] === "sh" && joined.includes("kill -KILL -1")) {
      this.killAlls.push(call.container);
      return this.killFails
        ? result({ exit_code: 126, stderr: Buffer.from("fork: retry\n") })
        : result();
    }
    if (call.command[0] === "sh" && joined.includes(".miyoria-proc-")) return result();
    this.programs.push(call);
    return await this.onProgram(call, options);
  }
}

/** A proc's `docker exec -i`, driven by the test. */
export interface FakeProc extends SpawnedProc {
  args: readonly string[];
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /** What was written to its stdin. */
  received: Buffer[];
  exit(code: number | null, signal?: string | null): void;
}

export class FakeSpawner implements ProcSpawner {
  readonly procs: FakeProc[] = [];

  spawn(args: readonly string[]): SpawnedProc {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exit!: (value: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      exit = resolve;
    });
    const received: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => received.push(chunk));
    const proc: FakeProc = {
      args,
      stdin,
      stdout,
      stderr,
      exited,
      received,
      kill: () => exit({ code: null, signal: "SIGKILL" }),
      exit: (code, signal = null) => exit({ code, signal }),
    };
    this.procs.push(proc);
    return proc;
  }
}
