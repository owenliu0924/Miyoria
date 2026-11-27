// `miyoria sandbox serve | build` (docs/design/v6-sandbox.md §1.2, §6.3): the sandbox service
// hostd runs on a machine that takes jobs, and the image it runs them in. `serve` reads what hostd
// gives it in the environment; `build` downloads about 2 GB and so only runs once this machine's
// owner said yes (`--yes`, or the question in a terminal). Also the checks `miyoria doctor` runs
// for it, and what `miyoria add sandbox` does after adding it.
//
// The messages are kept here in both languages (picked by the active one) until they move into
// the CLI's catalogue.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SandboxImage } from "@miyoria/contracts/workers";
import { loadHostConfig, parseHostConfig } from "@miyoria/hostd";
import { ProcessDockerRunner } from "@miyoria/workspace/sandbox";
import {
  buildImage,
  imageHash,
  imageSource,
  imageTag,
  startSandboxService,
} from "@miyoria/workspace/sandbox-service";
import { cliVersion } from "../assets.js";
import { withSandboxHint } from "../host-toml.js";
import { lang } from "../i18n/index.js";
import { ClackPrompter, isInteractive } from "../prompt.js";
import type { Finding } from "../stack/checks.js";
import { bold, dim, fail, note, ok, println, warn } from "../ui.js";
import { catalogRoot } from "./host.js";

const TEXT = {
  en: {
    listening: (url: string) => `sandbox service on ${url}`,
    noDockerfile: (dir: string) => `no sandbox image folder at ${dir}`,
    dockerDown: (why: string) => `Docker does not answer on this machine (${why})`,
    dockerFix: "start Docker Desktop (or the Docker service), then run this again",
    upToDate: (tag: string) => `the sandbox image is built and current: ${tag}`,
    plan: (tags: string[]) =>
      `This builds ${tags.join(" and ")} with Docker: it downloads about 2 GB the first time and takes a few minutes to half an hour.`,
    question: "Build it now?",
    noTerminal: (command: string) => `Not built: no terminal to ask. To build, run: ${command}`,
    declined: (command: string) => `Not built. Later: ${command}`,
    built: (tag: string) => `built ${tag}`,
    removed: (tags: string[]) => `removed older images: ${tags.join(", ")}`,
    failed: (role: string, why: string) => `the ${role} image did not build: ${why}`,
    doctorDocker: "sandbox: Docker",
    doctorImage: "sandbox: image",
    imageMissing: "not built yet",
    imageStale: (tag: string) => `an older build is in use; the current one is ${tag}`,
    buildFix: "miyoria sandbox build",
    hintAdded: (file: string) => `added the commented [sandbox] table to ${file}`,
  },
  "zh-TW": {
    listening: (url: string) => `沙箱服務在 ${url}`,
    noDockerfile: (dir: string) => `${dir} 沒有沙箱映像檔的資料夾`,
    dockerDown: (why: string) => `這台的 Docker 沒有回應(${why})`,
    dockerFix: "開啟 Docker Desktop(或 Docker 服務)後再執行一次",
    upToDate: (tag: string) => `沙箱映像檔已經建好,是最新的:${tag}`,
    plan: (tags: string[]) =>
      `要用 Docker 建 ${tags.join("、")}:第一次約下載 2 GB,要幾分鐘到半小時。`,
    question: "現在建嗎?",
    noTerminal: (command: string) => `沒有建:沒有終端機可以問。要建的話執行:${command}`,
    declined: (command: string) => `沒有建。之後可以執行:${command}`,
    built: (tag: string) => `建好了 ${tag}`,
    removed: (tags: string[]) => `刪掉了較舊的映像檔:${tags.join("、")}`,
    failed: (role: string, why: string) => `${role} 映像檔沒有建成:${why}`,
    doctorDocker: "沙箱:Docker",
    doctorImage: "沙箱:映像檔",
    imageMissing: "還沒建",
    imageStale: (tag: string) => `用的是之前建的;最新的是 ${tag}`,
    buildFix: "miyoria sandbox build",
    hintAdded: (file: string) => `在 ${file} 加上了註解掉的 [sandbox]`,
  },
} as const;

function text() {
  return TEXT[lang()];
}

/** The image folder of the catalog this CLI runs from (`workers/sandbox/image`). */
export function sandboxImageDir(hostToml: string): string {
  return join(catalogRoot(hostToml), "workers", "sandbox", "image");
}

/** The service's state folder: `<host state>/sandbox`, as the descriptor's `{state}/sandbox`. */
function sandboxState(hostToml: string): string {
  try {
    return join(loadHostConfig(hostToml).state.root, "sandbox");
  } catch {
    return resolve("data", "host", "sandbox");
  }
}

export interface SandboxServeOptions {
  env?: NodeJS.ProcessEnv;
  hostToml?: string;
}

/**
 * `miyoria sandbox serve`: runs until SIGINT / SIGTERM. hostd sets `HOST`, `PORT`,
 * `SANDBOX_HOST_TOML`, `SANDBOX_STATE`, `SANDBOX_IMAGE_DIR` and the two tokens.
 */
export async function sandboxServe(options: SandboxServeOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const hostToml = resolve(env.SANDBOX_HOST_TOML ?? options.hostToml ?? "host.toml");
  const service = await startSandboxService({
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 0) || 0,
    hostToml,
    state: resolve(env.SANDBOX_STATE ?? sandboxState(hostToml)),
    imageDir: resolve(env.SANDBOX_IMAGE_DIR ?? sandboxImageDir(hostToml)),
    token: env.MIYORIA_SERVICE_TOKEN ?? null,
    hostToken: env.MIYORIA_HOST_TOKEN ?? null,
    parseHostConfig,
    version: cliVersion(),
  });
  println(text().listening(service.url));
  await new Promise<void>((done) => {
    const stop = () => {
      for (const signal of SIGNALS) process.off(signal, stop);
      void service.close().finally(done);
    };
    for (const signal of SIGNALS) process.on(signal, stop);
  });
}

const SIGNALS: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

/** Image roles this checkout can build (the browser's once its folder is there). */
async function buildable(imageDir: string): Promise<{ role: SandboxImage; tag: string }[]> {
  const out: { role: SandboxImage; tag: string }[] = [];
  for (const role of ["default", "browser"] as const) {
    const source = imageSource(imageDir, role);
    const hash = await imageHash(source.dir, source.skip).catch(() => null);
    if (hash !== null) out.push({ role, tag: imageTag(role, hash) });
  }
  return out;
}

async function dockerVersion(runner: ProcessDockerRunner): Promise<{ ok: boolean; why: string }> {
  const result = await runner.exec(["version", "--format", "{{.Server.Version}}"], {
    maxOutputBytes: 4096,
    signal: AbortSignal.timeout(15_000),
  });
  const version = result.stdout.toString("utf8").trim();
  if (result.exit_code === 0 && version !== "") return { ok: true, why: "" };
  return {
    ok: false,
    why: (result.error ?? result.stderr.toString("utf8").trim().split("\n")[0]) || "?",
  };
}

async function present(runner: ProcessDockerRunner, tag: string): Promise<boolean> {
  const result = await runner.exec(["image", "inspect", "--format", "{{.Id}}", tag], {
    maxOutputBytes: 4096,
    signal: AbortSignal.timeout(15_000),
  });
  return result.exit_code === 0;
}

export interface SandboxBuildOptions {
  yes: boolean;
  hostToml?: string;
  docker?: string;
}

/** `miyoria sandbox build [--yes]`. Returns whether every image is there afterwards. */
export async function sandboxBuild(options: SandboxBuildOptions): Promise<boolean> {
  const m = text();
  const hostToml = resolve(options.hostToml ?? "host.toml");
  const imageDir = sandboxImageDir(hostToml);
  const roles = await buildable(imageDir);
  if (roles.length === 0) {
    fail(m.noDockerfile(imageDir));
    return false;
  }
  const runner = new ProcessDockerRunner(options.docker ?? "docker");
  const docker = await dockerVersion(runner);
  if (!docker.ok) {
    fail(m.dockerDown(docker.why));
    note(m.dockerFix);
    return false;
  }
  const missing: typeof roles = [];
  for (const r of roles) {
    if (await present(runner, r.tag)) ok(m.upToDate(r.tag));
    else missing.push(r);
  }
  if (missing.length === 0) return true;
  println(m.plan(missing.map((r) => bold(r.tag))));
  const command = "miyoria sandbox build --yes";
  if (!options.yes) {
    if (!isInteractive()) {
      note(m.noTerminal(command));
      return false;
    }
    if (!(await new ClackPrompter().confirm(m.question, true))) {
      note(m.declined(command));
      return false;
    }
  }
  const state = sandboxState(hostToml);
  let all = true;
  for (const r of missing) {
    const outcome = await buildImage({
      runner,
      imageDir,
      state,
      role: r.role,
      onOutput: (chunk) => process.stdout.write(dim(chunk)),
    });
    if (outcome.ok) {
      ok(m.built(outcome.tag));
      if (outcome.removed.length > 0) note(m.removed(outcome.removed));
    } else {
      all = false;
      fail(m.failed(r.role, outcome.error ?? "?"));
    }
  }
  return all;
}

/** One check of `miyoria doctor` (group `services`). */
export interface DoctorCheck {
  group: "services";
  run(): Promise<Finding>;
}

/** Docker answers, and the sandbox image is built and current. */
export function sandboxDoctorChecks(options: { hostToml: string; docker?: string }): DoctorCheck[] {
  const m = text();
  const runner = new ProcessDockerRunner(options.docker ?? "docker");
  return [
    {
      group: "services",
      run: async () => {
        const docker = await dockerVersion(runner);
        return docker.ok
          ? { level: "ok", what: m.doctorDocker, detail: "" }
          : {
              level: "fail",
              what: m.doctorDocker,
              detail: m.dockerDown(docker.why),
              fix: [m.dockerFix],
            };
      },
    },
    {
      group: "services",
      run: async () => {
        const roles = await buildable(sandboxImageDir(options.hostToml));
        const wanted = roles.find((r) => r.role === "default");
        if (wanted === undefined) {
          return {
            level: "fail",
            what: m.doctorImage,
            detail: m.noDockerfile(sandboxImageDir(options.hostToml)),
          };
        }
        if (await present(runner, wanted.tag))
          return { level: "ok", what: m.doctorImage, detail: wanted.tag };
        const older = await runner.exec(
          [
            "image",
            "ls",
            "--filter",
            "label=miyoria.sandbox.image=default",
            "--format",
            "{{.Repository}}:{{.Tag}}",
          ],
          { maxOutputBytes: 16 * 1024, signal: AbortSignal.timeout(15_000) },
        );
        const stale = older.exit_code === 0 && older.stdout.toString("utf8").trim() !== "";
        return stale
          ? {
              level: "warn",
              what: m.doctorImage,
              detail: m.imageStale(wanted.tag),
              fix: [m.buildFix],
            }
          : { level: "fail", what: m.doctorImage, detail: m.imageMissing, fix: [m.buildFix] };
      },
    },
  ];
}

/**
 * After `miyoria add sandbox`: the commented `[sandbox]` table at the end of `host.toml` (when it
 * has none), then the question whether to build the image now (§6.3).
 */
export async function sandboxAfterAdd(ctx: {
  hostToml: string;
  yes: boolean;
  docker?: string;
}): Promise<void> {
  if (existsSync(ctx.hostToml)) {
    const before = readFileSync(ctx.hostToml, "utf8");
    const after = withSandboxHint(before);
    if (after !== before) {
      parseHostConfig(ctx.hostToml, after); // what is written must load
      writeFileSync(ctx.hostToml, after, "utf8");
      note(text().hintAdded(ctx.hostToml));
    }
  }
  const built = await sandboxBuild({
    yes: ctx.yes,
    hostToml: ctx.hostToml,
    ...(ctx.docker !== undefined ? { docker: ctx.docker } : {}),
  });
  if (!built) warn(text().imageMissing);
}
