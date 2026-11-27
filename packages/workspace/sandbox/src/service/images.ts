// The images jobs run in (docs/design/v6-sandbox.md §6): their tags come from the image folder's
// contents, so a changed Dockerfile is a new tag. The service never builds (that downloads about
// 2 GB and is the machine owner's call, `miyoria sandbox build`); it finds the tag it wants, or
// the newest older one of the same contract (`stale`), or says the image is not there.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxImage } from "@miyoria/contracts/workers";
import type { DockerRunner, ExecResult } from "../runner.js";
import { DockerControl, decode, succeeded, why } from "./util.js";

/** The image contract: what the service needs of an image (Dockerfile's `miyoria.sandbox.contract`). */
export const IMAGE_CONTRACT = "1";
export const IMAGE_ROLES: readonly SandboxImage[] = ["default", "browser"];
const REPOSITORY: Record<SandboxImage, string> = {
  default: "miyoria/sandbox",
  browser: "miyoria/sandbox-browser",
};
const TAG = /^miyoria\/sandbox(-browser)?:[0-9]+-[0-9a-f]{12}$/;
/** Longest `docker build`. */
export const BUILD_TIMEOUT_MS = 30 * 60_000;

/** Where an image role is built from: the default image's folder leaves the browser's out. */
export function imageSource(imageDir: string, role: SandboxImage): { dir: string; skip: string[] } {
  return role === "default"
    ? { dir: imageDir, skip: ["browser"] }
    : { dir: join(imageDir, "browser"), skip: [] };
}

/**
 * The first 12 hex characters of SHA-256 over every regular file of `dir` (relative paths sorted,
 * each path and its content), top-level names in `skip` left out. `null` without a Dockerfile.
 */
export async function imageHash(dir: string, skip: readonly string[] = []): Promise<string | null> {
  if (!existsSync(join(dir, "Dockerfile"))) return null;
  const files: string[] = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    const names = (await readdir(folder)).sort();
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (prefix === "" && skip.includes(name)) continue;
      const info = await lstat(join(folder, name));
      if (info.isDirectory()) await walk(join(folder, name), path);
      else if (info.isFile()) files.push(path);
    }
  };
  await walk(dir, "");
  files.sort();
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path).update("\0");
    // Line endings as in the repository (`.gitattributes` keeps them LF), so every machine agrees.
    hash.update(await readFile(join(dir, ...path.split("/")))).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

export function imageTag(role: SandboxImage, hash: string): string {
  return `${REPOSITORY[role]}:${IMAGE_CONTRACT}-${hash}`;
}

export interface ImageStatus {
  tag: string;
  present: boolean;
  building: boolean;
  stale: boolean;
  /** The tag jobs get now: the wanted one, or the stale one; `null` when there is none. */
  usable: string | null;
}

/** `<state>/build-<role>.lock`, held by `miyoria sandbox build` while it builds. */
export function buildLockFile(state: string, role: SandboxImage): string {
  return join(state, `build-${role}.lock`);
}

async function lockHeld(file: string): Promise<boolean> {
  try {
    const { pid } = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is another user's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Tags of `role` of this contract that Docker has, newest first. */
async function localTags(docker: DockerControl, role: SandboxImage): Promise<string[]> {
  const out = await docker.text([
    "image",
    "ls",
    "--filter",
    `label=miyoria.sandbox.image=${role}`,
    "--filter",
    `label=miyoria.sandbox.contract=${IMAGE_CONTRACT}`,
    "--format",
    "{{.Repository}}:{{.Tag}}",
  ]);
  if (out === null) return [];
  const prefix = `${REPOSITORY[role]}:${IMAGE_CONTRACT}-`;
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((tag) => TAG.test(tag) && tag.startsWith(prefix));
}

/** What there is of `role` on this machine. `null` when the image folder has no such image. */
export async function imageStatus(
  docker: DockerControl,
  imageDir: string,
  state: string,
  role: SandboxImage,
): Promise<ImageStatus | null> {
  const source = imageSource(imageDir, role);
  const hash = await imageHash(source.dir, source.skip).catch(() => null);
  if (hash === null) return null;
  const tag = imageTag(role, hash);
  const building = await lockHeld(buildLockFile(state, role));
  const present = succeeded(await docker.run(["image", "inspect", "--format", "{{.Id}}", tag]));
  if (present) return { tag, present, building, stale: false, usable: tag };
  const older = (await localTags(docker, role)).find((t) => t !== tag) ?? null;
  return { tag, present: false, building, stale: older !== null, usable: older };
}

/** `images.json`: what was built here, newest last. */
interface BuiltRecord {
  role: SandboxImage;
  tag: string;
  hash: string;
  at: number;
}

async function recordBuilt(state: string, record: BuiltRecord): Promise<void> {
  const file = join(state, "images.json");
  let built: BuiltRecord[] = [];
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as { built?: BuiltRecord[] };
    if (Array.isArray(raw.built)) built = raw.built;
  } catch {
    // First build.
  }
  built.push(record);
  await writeFile(file, `${JSON.stringify({ built: built.slice(-20) }, null, 2)}\n`);
}

export interface BuildOutcome {
  role: SandboxImage;
  tag: string;
  ok: boolean;
  /** Why it failed. */
  error: string | null;
  /** Older tags of the same contract removed (all but the newest previous one). */
  removed: string[];
}

/**
 * `docker build --pull --tag <tag>` of `role`, through the runner (no shell, filtered
 * environment), at most `BUILD_TIMEOUT_MS`. Holds the build lock so the service says "building".
 * On success the older tags of the same contract go, except the newest previous one.
 */
export async function buildImage(options: {
  runner: DockerRunner;
  imageDir: string;
  state: string;
  role: SandboxImage;
  onOutput?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<BuildOutcome> {
  const { runner, imageDir, state, role } = options;
  const source = imageSource(imageDir, role);
  const hash = await imageHash(source.dir, source.skip);
  if (hash === null) {
    return { role, tag: "", ok: false, error: `no Dockerfile in ${source.dir}`, removed: [] };
  }
  const tag = imageTag(role, hash);
  await mkdir(state, { recursive: true });
  const lock = buildLockFile(state, role);
  await writeFile(lock, JSON.stringify({ pid: process.pid, started: Date.now() }));
  let result: ExecResult;
  try {
    const timeout = AbortSignal.timeout(BUILD_TIMEOUT_MS);
    result = await runner.exec(
      ["build", "--pull", "--tag", tag, "--label", `miyoria.sandbox.hash=${hash}`, source.dir],
      {
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        maxOutputBytes: 64 * 1024,
        onData: (_stream, chunk) => options.onOutput?.(decode(chunk)),
      },
    );
  } finally {
    await rm(lock, { force: true });
  }
  if (!succeeded(result)) return { role, tag, ok: false, error: why(result), removed: [] };
  await recordBuilt(state, { role, tag, hash, at: Date.now() });
  const docker = new DockerControl(runner);
  const removed: string[] = [];
  const older = (await localTags(docker, role)).filter((t) => t !== tag);
  for (const old of older.slice(1)) {
    // Not forced: an image a container still uses stays.
    if (succeeded(await docker.run(["image", "rm", old]))) removed.push(old);
  }
  return { role, tag, ok: true, error: null, removed };
}
