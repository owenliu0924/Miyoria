// `miyoria doctor`, per service: what a service's descriptor says it needs, checked against this
// host (docs/design/v5-hostd.md §9). Everything here is read-only; `--fix` is the caller's, and
// it only syncs an environment or downloads `install.files`. Checking a file hashes it when it is
// new or changed since its hash was remembered (`--deep` hashes every one).

import type { HostInfo } from "@miyoria/contracts/host";
import {
  type CatalogEntry,
  checkServiceFiles,
  formatBytes,
  type InstallDeps,
  inspectService,
  type LoadedHostConfig,
  pythonIn,
  readHostKey,
} from "@miyoria/hostd";
import { isJsonObject } from "@miyoria/types";
import { t } from "../i18n/index.js";
import { type DeepDeps, type Finding, fail, type Listener, ok, ping, warn } from "./checks.js";

export interface HostCheckInput {
  host: LoadedHostConfig;
  /** The enabled services, in the order `host.toml` lists them. */
  entries: readonly CatalogEntry[];
  deps: DeepDeps;
  /** The installer's seams (the platform and PATH it looks in); `root` is added. */
  install?: Omit<InstallDeps, "root">;
  /** The catalog root: `install.manual` paths start there. */
  root: string;
  /** What the running daemon says; `null` when none runs for this workspace. */
  daemon: HostInfo | null;
  /** Also run what is slow: the import check, ports, health and the GPU budget. */
  deep: boolean;
}

const name = (entry: CatalogEntry, what: string): string => `${entry.name}  ${what}`;

function installDeps(input: HostCheckInput): InstallDeps {
  return { ...input.install, root: input.root, platform: input.deps.platform, env: input.deps.env };
}

// ---- per service -------------------------------------------------------------------------

/** Platform, runtime, system programs, manual items, files and models of one service. */
export async function serviceChecks(input: HostCheckInput): Promise<Finding[]> {
  const m = t.stack.hostChecks;
  const findings: Finding[] = [];
  for (const entry of input.entries) {
    const inspected = inspectService(entry, input.host, installDeps(input));
    if (!inspected.platformOk) {
      findings.push(
        fail(
          name(entry, m.platform),
          m.platformUnsupported(t.common.list(entry.descriptor.platforms), input.deps.platform),
          [m.platformFix(entry.name)],
        ),
      );
      continue;
    }
    const rt = inspected.runtime;
    const env = name(entry, m.environment);
    if (rt.kind === "managed") {
      const state = rt.state;
      if (state?.state === "ready") {
        findings.push(
          ok(env, m.envReady(rt.dir ?? "", rt.extras.length > 0 ? t.common.list(rt.extras) : null)),
        );
        if (input.deep) findings.push(...(await importCheck(input, entry, rt.dir ?? "")));
      } else if (state?.state === "stale") {
        findings.push(fail(env, m.envStale(t.common.list(state.reasons)), [m.envStaleFix]));
      } else {
        findings.push(fail(env, m.envMissing(rt.dir ?? ""), [m.envMissingFix(entry.name)]));
      }
    } else if (rt.kind === "user-managed") {
      if (rt.pythonExists) {
        findings.push(ok(env, m.envUserManaged(rt.dir ?? "")));
        if (input.deep) findings.push(...(await importCheck(input, entry, rt.dir ?? "")));
      } else {
        findings.push(fail(env, m.envUserMissing(rt.dir ?? ""), [m.envUserMissingFix(entry.name)]));
      }
    }
    for (const s of inspected.system) {
      const what = name(entry, m.systemProgram(s.program));
      findings.push(
        s.found ? ok(what, m.onPath) : fail(what, m.notOnPath, s.hint ? [s.hint] : undefined),
      );
    }
    for (const item of inspected.manual) {
      const what = name(entry, m.manualItem);
      findings.push(
        item.present
          ? ok(what, m.manualPresent(item.what, item.path))
          : warn(what, m.manualMissing(item.what, item.path), [m.manualFix]),
      );
    }
    // `install.files`: hashed when new or changed since the last check (`--deep`: every one).
    for (const f of await checkServiceFiles(entry, input.host, input.deep ? "deep" : "cached")) {
      const what = name(entry, m.file(f.path));
      if (f.state === "verified" || f.state === "present") {
        findings.push(ok(what, m.fileVerified(formatBytes(f.size))));
      } else if (f.state === "wrong") {
        findings.push(fail(what, m.fileWrong(f.detail ?? m.checksumMismatch), [m.fileRefetch]));
      } else {
        const detail = m.fileMissing(f.what, formatBytes(f.size), f.licence, f.source);
        const fix = [m.fileFetch, ...(f.optional ? [] : [m.fileRequired])];
        findings.push(f.optional ? warn(what, detail, fix) : fail(what, detail, fix));
      }
    }
    for (const model of inspected.models) {
      const what = name(entry, m.model(model.repo));
      findings.push(
        model.present
          ? ok(what, m.modelCached)
          : warn(what, m.modelMissing, [m.modelPull(entry.name)]),
      );
    }
  }
  return findings;
}

/** `check_imports` with the environment's Python: the smoke test of `--deep`. */
async function importCheck(
  input: HostCheckInput,
  entry: CatalogEntry,
  envDir: string,
): Promise<Finding[]> {
  const modules = entry.descriptor.install.check_imports;
  if (modules.length === 0) return [];
  const python = pythonIn(envDir, input.deps.platform);
  const result = await input.deps.run(python, ["-c", `import ${modules.join(", ")}`], {
    timeoutMs: 180_000,
  });
  const m = t.stack.hostChecks;
  const what = name(entry, m.importCheck);
  if (result.code === 0) return [ok(what, t.common.list(modules))];
  const last = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  return [
    fail(
      what,
      result.missing
        ? m.pythonMissing(python)
        : m.importFailed(modules.join(", "), result.timedOut, last ? last : null),
      [m.importFix(entry.name)],
    ),
  ];
}

// ---- hostd, the control link, the host key -----------------------------------------------

export function hostdChecks(input: HostCheckInput): Finding[] {
  const m = t.stack.hostChecks;
  const findings: Finding[] = [];
  const { daemon, host } = input;
  if (daemon === null) {
    findings.push(warn("hostd", m.hostdNotRunning, [m.hostdStart]));
  } else {
    const running = daemon.services.filter((s) => s.state === "running").length;
    findings.push(ok("hostd", m.hostdRunning(daemon.name, running, daemon.services.length)));
  }
  if (host.config.cluster === undefined) return findings;
  let key: ReturnType<typeof readHostKey> = null;
  let keyError: string | null = null;
  try {
    key = readHostKey(host.state.root);
  } catch (error) {
    keyError = error instanceof Error ? error.message : String(error);
  }
  const url = host.config.cluster.url;
  if (keyError !== null) {
    findings.push(fail("host.key", m.hostKeyUnreadable(keyError), [m.hostKeyRejoin]));
  } else if (key === null) {
    findings.push(fail("host.key", m.hostKeyMissing(url), [m.hostKeyJoin]));
  } else {
    findings.push(ok("host.key", m.hostKeyOk(key.id)));
  }
  if (daemon !== null) {
    switch (daemon.link) {
      case "connected":
        findings.push(ok(m.coreLink, m.linkConnected(url)));
        break;
      case "unauthorized":
        findings.push(fail(m.coreLink, m.linkUnauthorized, [m.linkRejoin]));
        break;
      case "connecting":
        findings.push(warn(m.coreLink, m.linkConnecting, [m.linkReachable(url)]));
        break;
      default:
        findings.push(warn(m.coreLink, m.linkNone, [m.linkCheck]));
    }
  }
  return findings;
}

// ---- listeners, health, VRAM -------------------------------------------------------------

/** The port a service listens on: `host.toml`'s, else the descriptor's number; `null` for `auto`. */
export function portOf(host: LoadedHostConfig, entry: CatalogEntry): number | null {
  const configured = host.config.services[entry.name]?.port;
  if (configured !== undefined) return configured;
  const preferred = entry.descriptor.run?.port;
  return typeof preferred === "number" ? preferred : null;
}

export function listenersOf(input: HostCheckInput): Listener[] {
  const out: Listener[] = [];
  for (const entry of input.entries) {
    const port = portOf(input.host, entry);
    if (port === null) continue;
    const path = entry.descriptor.run?.health.http;
    const status = input.daemon?.services.find((s) => s.name === entry.name);
    out.push({
      label: entry.name,
      host: "127.0.0.1",
      port,
      ...(path !== undefined ? { health: `http://127.0.0.1:${port}${path}` } : {}),
      ...(input.daemon === null
        ? {}
        : { ours: status?.state === "running" || status?.state === "starting" }),
    });
  }
  return out;
}

export async function healthChecks(input: HostCheckInput): Promise<Finding[]> {
  const m = t.stack.hostChecks;
  const findings: Finding[] = [];
  for (const l of listenersOf(input)) {
    if (l.health === undefined) continue;
    const what = m.service(l.label);
    const status = input.daemon?.services.find((s) => s.name === l.label);
    if (input.daemon !== null && status?.state !== "running") {
      findings.push(
        warn(what, m.serviceNotRunning(status?.state ?? m.unknownToHostd), [m.upService(l.label)]),
      );
      continue;
    }
    const res = await ping(input.deps.fetchImpl, l.health);
    if (!res) {
      findings.push(warn(what, m.noAnswer(l.health), [m.upStart]));
      continue;
    }
    if (!res.ok) {
      findings.push(fail(what, m.httpStatus(l.health, res.status)));
      continue;
    }
    let version: string | null = null;
    try {
      const body: unknown = await res.json();
      if (isJsonObject(body) && typeof body.version === "string") version = body.version;
      if (isJsonObject(body) && (body.smart_turn === false || body.silero === false)) {
        const missing = [
          body.smart_turn === false ? "smart_turn" : null,
          body.silero === false ? "silero" : null,
        ].filter((x): x is string => x !== null);
        findings.push(
          warn(what, m.modelsNotLoaded(l.health, t.common.list(missing)), [m.modelsNotLoadedFix]),
        );
        continue;
      }
    } catch {
      // health without a JSON body is fine
    }
    if (l.health.endsWith("/api/health") && version && version !== input.deps.version) {
      findings.push(warn(what, m.versionMismatch(version, input.deps.version), [m.versionFix]));
    } else findings.push(ok(what, m.healthy(version ? version : null)));
  }
  return findings;
}

/** The services' `gpu` the way the daemon reads it: `host.toml`'s policy wins. */
function gpuOf(input: HostCheckInput, entry: CatalogEntry) {
  const gpu = entry.descriptor.gpu;
  if (gpu === undefined) return null;
  return {
    policy: input.host.config.services[entry.name]?.gpu?.policy ?? gpu.policy,
    resident: gpu.vram_mb?.resident ?? 0,
  };
}

/**
 * The card's budget: what the services keep loaded (pinned, evictable and reserved memory), and the
 * moment an on-demand service works, when the evictable ones give theirs up. Against the card's
 * total minus `[gpu] reserve_mb`, with 8% headroom.
 */
export async function vramChecks(input: HostCheckInput): Promise<Finding[]> {
  const gpus = input.entries
    .map((entry) => ({ entry, gpu: gpuOf(input, entry) }))
    .filter(
      (s): s is { entry: CatalogEntry; gpu: NonNullable<ReturnType<typeof gpuOf>> } =>
        s.gpu !== null,
    );
  const smi = await input.deps.run(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    { timeoutMs: 15_000 },
  );
  const m = t.stack.hostChecks;
  if (smi.missing || smi.code !== 0) return [warn(m.vram, m.noSmi)];
  const [gpuName, total, used] = (smi.stdout.split(/\r?\n/)[0] ?? "")
    .split(",")
    .map((s) => s.trim());
  const totalMb = Number(total);
  const usedMb = Number(used);
  if (!Number.isFinite(totalMb)) return [warn(m.vram, m.smiUnreadable)];
  const head = m.vramUsed(gpuName ?? "", t.common.int(usedMb), t.common.mb(totalMb));
  if (gpus.length === 0) return [ok(m.vram, head)];

  const reserve = input.host.config.gpu.reserve_mb;
  const available = totalMb - reserve;
  const sum = (policies: readonly string[]) =>
    gpus.filter((s) => policies.includes(s.gpu.policy)).reduce((n, s) => n + s.gpu.resident, 0);
  let peak = sum(["pinned", "evictable", "reserve"]);
  let peakWhy = m.peakResident;
  const pinned = sum(["pinned", "reserve"]);
  for (const s of gpus) {
    if (s.gpu.policy !== "on_demand") continue;
    const during = s.gpu.resident + pinned;
    if (during > peak) {
      peak = during;
      peakWhy = m.peakOnDemand(s.entry.name);
    }
  }
  const detail = m.vramDetail(head, t.common.mb(reserve), t.common.mb(peak), peakWhy);
  if (peak > available * 0.92) {
    return [warn(m.vramBudget, m.vramOver(detail, t.common.mb(available)), [m.vramFix])];
  }
  return [ok(m.vramBudget, detail)];
}
