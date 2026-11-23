// `miyoria doctor --deep`: the install problems met on 2026-11-07, each as a finding with a fix.
// Read-only: it reports Windows port reservations and antivirus effects and never changes system,
// firewall or antivirus settings. What each service needs comes from its descriptor
// (`host-checks.ts`); this file holds the findings that are not about one service.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortProbe } from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
import { isJsonObject } from "@miyoria/types";
import { t } from "../i18n/index.js";
import {
  buildTargets,
  checkTarget,
  findJdk21,
  installedModJars,
  minecraftModsDir,
  modFreshness,
  modInfo,
  protocolVersions,
} from "./builds.js";
import { inRanges, parseDynamicPort, parseExcludedRanges, type Runner } from "./system.js";

export type Level = "ok" | "warn" | "fail";

export interface Finding {
  level: Level;
  what: string;
  detail: string;
  /** How to fix it, one step per line. */
  fix?: string[];
}

export interface DeepDeps {
  platform: NodeJS.Platform;
  run: Runner;
  probe: PortProbe;
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  tmpdir: string;
  /** Version of this CLI, compared with the running core's. */
  version: string;
  /** Whether something accepts TCP connections at host:port (cross-machine checks). */
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export interface DeepInput {
  config: Config;
  configDir: string;
  root: string | null;
  deps: DeepDeps;
}

export const ok = (what: string, detail: string): Finding => ({ level: "ok", what, detail });
export const warn = (what: string, detail: string, fix?: string[]): Finding => ({
  level: "warn",
  what,
  detail,
  fix,
});
export const fail = (what: string, detail: string, fix?: string[]): Finding => ({
  level: "fail",
  what,
  detail,
  fix,
});

// ---- ports -------------------------------------------------------------------------------

export interface Listener {
  label: string;
  host: string;
  port: number;
  /** URL answering 200 when the service is ours and running. */
  health?: string;
  /**
   * Whether hostd says this is its own running service: `true` ours, `false` hostd runs and this
   * service is not running (an answering port is somebody else's), `undefined` hostd is not
   * running (the health URL decides).
   */
  ours?: boolean;
}

export async function ping(fetchImpl: typeof fetch, url: string): Promise<Response | null> {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
  } catch {
    return null;
  }
}

const winnatFix = (): string[] => [
  t.stack.checks.winnatList,
  t.stack.checks.winnatRestart,
  t.stack.checks.winnatMove,
];

/** One finding per listener: free, ours, foreign, or denied by Windows (with the WinNAT hint). */
export async function portChecks(
  input: Pick<DeepInput, "deps">,
  listeners: readonly Listener[],
): Promise<Finding[]> {
  const { deps } = input;
  const m = t.stack.checks;
  const findings: Finding[] = [];
  let ranges: ReturnType<typeof parseExcludedRanges> = [];
  if (deps.platform === "win32") {
    const excluded = await deps.run(
      "netsh",
      ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      { timeoutMs: 10_000 },
    );
    if (!excluded.missing) ranges = parseExcludedRanges(excluded.stdout);
    const dynamic = await deps.run("netsh", ["int", "ipv4", "show", "dynamicport", "tcp"], {
      timeoutMs: 10_000,
    });
    const info = dynamic.missing ? null : parseDynamicPort(dynamic.stdout);
    if (info && info.start < 49152) {
      findings.push(warn(m.dynamicPortRange, m.dynamicPortLow(info.start), winnatFix()));
    } else if (info) {
      findings.push(ok(m.dynamicPortRange, m.dynamicPortOk(info.start)));
    }
  }
  for (const l of listeners) {
    const range = inRanges(l.port, ranges);
    const state = await deps.probe(l.port, l.host);
    const name = m.port(l.port, l.label);
    if (state === "denied" || (range && state !== "in-use")) {
      const where = range ? m.inReservedRange(range.start, range.end) : m.bindDenied;
      findings.push(fail(name, m.portBlocked(where), winnatFix()));
    } else if (state === "in-use") {
      const res = l.ours === undefined && l.health ? await ping(deps.fetchImpl, l.health) : null;
      if (l.ours === true || res?.ok) findings.push(ok(name, m.portOurs));
      else {
        findings.push(warn(name, m.portForeign, [m.portForeignFind(l.port), m.portForeignStop]));
      }
    } else if (state === "error") {
      findings.push(warn(name, m.portUntestable));
    } else {
      findings.push(ok(name, m.portFree));
    }
  }
  return findings;
}

// ---- builds ------------------------------------------------------------------------------

export async function buildChecks(input: DeepInput): Promise<Finding[]> {
  const { root, config, configDir, deps } = input;
  const m = t.stack.checks;
  const findings: Finding[] = [];
  if (!root) return findings;
  for (const target of buildTargets(root, configDir, config)) {
    const f = checkTarget(target);
    const what = m.build(target.label);
    if (f.state === "fresh") findings.push(ok(what, f.detail));
    else if (f.state === "stale") {
      findings.push(fail(what, f.detail, [m.rebuildStale]));
    } else if (target.configured === false) {
      findings.push(warn(what, m.notBuiltUnused, [m.buildWhenNeeded]));
    } else {
      findings.push(fail(what, m.notBuiltOrEmpty, [m.runUpdate]));
    }
  }

  const mod = modInfo(root);
  if (!mod) return findings;
  const built = modFreshness(mod);
  if (built.state === "fresh") findings.push(ok(m.modJar, built.detail));
  else {
    findings.push(
      fail(m.modJar, built.state === "missing" ? m.notBuilt : built.detail, [m.runUpdateJdk]),
    );
  }
  const jdk = await findJdk21(deps.run, deps.env, deps.platform);
  if (jdk.jdk21) findings.push(ok("JDK 21", jdk.jdk21.home ?? m.jdkOnPath));
  else {
    const needed = built.state !== "fresh";
    const msg = m.jdkMissing(jdk.onPath);
    const fix = [m.jdkInstall, m.jdkJavaHome];
    findings.push(needed ? fail("JDK 21", msg, fix) : warn("JDK 21", m.jdkNeededLater(msg), fix));
  }
  const versions = protocolVersions(root);
  if (versions.source !== null && versions.doc !== null && versions.source !== versions.doc) {
    findings.push(
      fail(m.protocolVersion, m.protocolMismatch(versions.source, versions.doc), [m.protocolFix]),
    );
  } else if (versions.source !== null) {
    findings.push(ok(m.protocolVersion, m.protocolOk(versions.source)));
  }
  const mods = minecraftModsDir(config);
  const ext = config.section("extensions");
  const hasMc = isJsonObject(ext) && isJsonObject(ext["miyoria.minecraft"]);
  if (!mods) {
    if (hasMc) {
      findings.push(warn(m.installedMod, m.noMinecraftDir, [m.minecraftDirExample]));
    }
  } else {
    const installed = installedModJars(mods);
    const jar = built.state === "missing" ? null : readFileOrNull(mod.jar);
    if (installed.length === 0) {
      findings.push(fail(m.installedMod, m.noBridgeJar(mods), [m.runUpdateCopy]));
    } else if (jar) {
      const want = sha(jar);
      const same = installed.some((p) => {
        const data = readFileOrNull(p);
        return data !== null && sha(data) === want;
      });
      if (same) findings.push(ok(m.installedMod, m.modSame));
      else {
        findings.push(
          fail(
            m.installedMod,
            m.modDiffers(t.common.list(installed.map((p) => p.slice(mods.length + 1)))),
            [m.modReplace],
          ),
        );
      }
    }
  }
  return findings;
}

function readFileOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---- writable folders and temp files -----------------------------------------------------

/** Writes and removes a small file; `null` when it worked, else the error code. */
export function writableProbe(dir: string): string | null {
  const file = join(dir, `.miyoria-doctor-${process.pid}`);
  try {
    writeFileSync(file, "x");
    unlinkSync(file);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "error";
  }
}

const AV_PROCESSES: Record<string, string> = {
  "avp.exe": "Kaspersky",
  "ekrn.exe": "ESET",
  "bdagent.exe": "Bitdefender",
  "mbamservice.exe": "Malwarebytes",
};

/** Large temp file write/read/delete (what esbuild does), plus leftovers of a blocked build. */
export async function tempChecks(input: DeepInput): Promise<Finding[]> {
  const { deps } = input;
  const m = t.stack.checks;
  const findings: Finding[] = [];
  const file = join(deps.tmpdir, `miyoria-doctor-${process.pid}.tmp`);
  try {
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));
    const size = readFileSync(file).length;
    unlinkSync(file);
    findings.push(ok(m.tempFiles, m.tempOk(deps.tmpdir, t.common.mb(size / 1048576))));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    findings.push(
      fail(m.tempFiles, m.tempFailed(deps.tmpdir, code), [m.tempNoBuildWeb, m.tempExclusion]),
    );
    try {
      unlinkSync(file);
    } catch {
      // still locked
    }
  }
  let leftovers = 0;
  try {
    leftovers = readdirSync(deps.tmpdir).filter((n) => /^esbuild-/i.test(n)).length;
  } catch {
    // unreadable temp folder is reported above
  }
  if (leftovers > 0) {
    findings.push(
      warn(m.esbuildTemp, m.esbuildLeftovers(deps.tmpdir, leftovers), [m.esbuildCleanup]),
    );
  }
  if (deps.platform === "win32") {
    const list = await deps.run("tasklist", ["/fo", "csv", "/nh"], { timeoutMs: 15_000 });
    const names = new Set(
      list.stdout.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]?.toLowerCase() ?? ""),
    );
    const found = Object.entries(AV_PROCESSES).filter(([exe]) => names.has(exe));
    for (const [, product] of found) {
      findings.push(warn(m.antivirus, m.antivirusFound(product), [m.antivirusBuild]));
    }
  }
  return findings;
}
