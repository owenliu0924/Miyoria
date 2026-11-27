// Where an extension's processes run. The host itself only needs a child with three pipes and
// an exit; the launcher decides whether that is a process on this machine (`localLauncher`) or
// a program in a sandbox job on some machine of the cluster (the sandbox launcher). The app
// provides one as `ExtensionLauncherKey`; without one every extension runs here, as before.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { serviceKey } from "@miyoria/types";

/** A running extension program (or a server it brought), wherever it runs. */
export interface ChildLike {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves once, when the program is gone (also after `kill`). */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
  readonly where: { kind: "host" } | { kind: "sandbox"; host: string; job: string };
}

/** What to start. */
export interface LaunchSpec {
  /** Extension id. */
  extension: string;
  /** The extension's folder on the Core machine. */
  dir: string;
  runtime: "node" | "deno" | "bun" | "binary";
  program: string;
  args: string[];
  cwd: string;
  /** The filtered environment (`extensionEnv`); never the Core's whole one. */
  env: Record<string, string>;
  /** Hosts its manifest declared and the owner granted. */
  network: readonly string[];
  /** Variables the owner named in `[extensions."<id>"] secrets`, with their values. */
  secrets: Readonly<Record<string, string>>;
  runIn: "host" | "sandbox";
}

export interface ExtensionLauncher {
  launch(spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike>;
  /** Another program of the same extension (a server it bundles), run where the extension runs. */
  launchInSame?(extension: string, spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike>;
}

export const ExtensionLauncherKey = serviceKey<ExtensionLauncher>("ExtensionLauncher");

/** The launcher failed to start the program. */
export class LaunchError extends Error {
  override readonly name = "LaunchError";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * On Windows a bare `npx` is `npx.cmd` somewhere on `PATH`: find it the way a shell would
 * (`PATHEXT`), so a bundled server's `command = "npx"` starts. Elsewhere, and for anything with
 * a directory or an extension, the program as given.
 */
export function resolveProgram(
  program: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || /[\\/]/u.test(program) || extname(program) !== "") return program;
  const get = (name: string) =>
    Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] ?? undefined;
  const exts = (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "");
  for (const dir of (get("PATH") ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, program + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return program;
}

/** `cmd` / `bat` shims (`npx.cmd`) only start through the command interpreter on Windows. */
function needsShell(program: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/iu.test(program);
}

/** One argument for `cmd.exe`, quoted so spaces and its own metacharacters stay literal. */
function cmdQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-+=.,:/\\]+$/u.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

function childOf(child: ChildProcessWithoutNullStreams): ChildLike {
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
    where: { kind: "host" },
  };
}

/**
 * Today's way: a process on this machine, without a shell, with exactly `env` plus the granted
 * secrets. `runIn` is not looked at: there is nowhere else to run here.
 */
export function localLauncher(platform: NodeJS.Platform = process.platform): ExtensionLauncher {
  const start = async (spec: LaunchSpec, signal: AbortSignal): Promise<ChildLike> => {
    if (signal.aborted) throw new LaunchError(`starting \`${spec.extension}\`: aborted`);
    const program = resolveProgram(spec.program, spec.env, platform);
    const shell = needsShell(program, platform);
    const child = spawn(
      shell ? [program, ...spec.args].map(cmdQuote).join(" ") : program,
      shell ? [] : spec.args,
      {
        cwd: spec.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...spec.env, ...spec.secrets },
        windowsHide: true,
        shell,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      throw new LaunchError(
        `starting \`${program}\` for \`${spec.extension}\`: ${(error as Error).message}`,
        { cause: error },
      );
    }
    // Errors after the start (a broken pipe) show up as the exit; nothing else listens here.
    child.on("error", () => undefined);
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    const like = childOf(child);
    void like.exited.then(() => signal.removeEventListener("abort", onAbort));
    return like;
  };
  return {
    launch: start,
    launchInSame: (_extension, spec, signal) => start(spec, signal),
  };
}
