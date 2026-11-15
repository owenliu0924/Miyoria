// `miyoria host migrate`: writes `host.toml` from the `[machine]` and `[stack]` sections of
// miyoria.toml, so this machine keeps its Python environments, ports and worker environment
// variables under hostd (docs/design/v5-hostd.md §3). Deleted with the two sections (H12).

import { existsSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { parseHostConfig } from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
import { parseBind, repoRoot, stackConfig, startOrder, WORKER_DEFAULTS } from "../stack/config.js";
import { apiHealth, stageOverlayBind, voiceLinkUrl } from "../stack/plan.js";
import { isLoopback } from "../stack/roles.js";
import { dim, ok, println, section, warn } from "../ui.js";
import { HostCommandError, type HostTarget } from "./host.js";
import { loadConfig } from "./node.js";

/** Ports the descriptors use; a different one goes into `host.toml`. */
const CORE_PORT = 7878;
const OVERLAY_PORT = 7884;

/** A TOML string (JSON's escapes are TOML's). */
function q(text: string): string {
  return JSON.stringify(text);
}

function key(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : q(name);
}

function inlineTable(values: Record<string, string>): string {
  const pairs = Object.entries(values).map(([k, v]) => `${key(k)} = ${q(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

/** A folder as `host.toml` writes it: relative to the workspace when it can be, `/` separators. */
function folder(workspace: string, abs: string): string {
  // Another drive gives an absolute path back.
  const rel = relative(workspace, abs);
  return (rel === "" ? "." : rel).replaceAll("\\", "/");
}

export interface Migration {
  text: string;
  /** What `host.toml` cannot say; written as comments too. */
  notes: string[];
}

/** The `host.toml` for a config. No side effects. */
export function hostTomlFrom(
  config: Config,
  configPath: string,
  hostToml: string,
  name: string,
): Migration {
  const stack = stackConfig(config);
  const workspace = dirname(resolve(hostToml));
  const root = repoRoot(configPath) ?? dirname(resolve(configPath));
  const notes: string[] = [];
  const lines: string[] = [
    "# This machine's services for hostd, written by `miyoria host migrate` from [machine] and [stack].",
    "# docs/design/v5-hostd.md §3",
    "",
    `name = ${q(name)}`,
    "",
    "# Set by `miyoria host join` once Core has its cluster module (H5).",
    "# [cluster]",
    '# url = "ws://127.0.0.1:7880/cluster-link"',
    "",
    "[paths]",
    'state = "data/host"',
    "",
  ];

  const inference = stack.machine?.hosts.inference;
  const serves = stack.workers.length > 0 && inference !== undefined && !isLoopback(inference);
  const bind = serves ? inference : "127.0.0.1";
  lines.push("[network]", `bind = ${q(bind)}`);
  if (serves) lines.push(`advertise = ${q(inference)}`);
  lines.push("");

  for (const w of startOrder(stack.workers)) {
    const table = [`[services.${key(w.name)}]`, "enabled = true"];
    table.push(`python = ${q(folder(workspace, resolve(root, w.venv)))}`);
    table.push(`port = ${w.port}`);
    const defaults = WORKER_DEFAULTS[w.name]?.env ?? {};
    const env = Object.fromEntries(Object.entries(w.env).filter(([k, v]) => defaults[k] !== v));
    if (Object.keys(env).length > 0) table.push(`env = ${inlineTable(env)}`);
    lines.push(...table, "");

    if (w.host !== bind) {
      notes.push(`${w.name}:host = "${w.host}"(host.toml 只有整台的 [network] bind = "${bind}")`);
    }
    if (w.dir !== w.name || w.entry !== "server.py") {
      notes.push(`${w.name}:dir / entry 不同於預設(要改 workers/${w.name}/service.toml)`);
    }
    if (w.vramMb !== null) notes.push(`${w.name}:vram_mb = ${w.vramMb}`);
    if (w.startTimeoutSecs !== null) {
      notes.push(
        `${w.name}:start_timeout_secs = ${w.startTimeoutSecs}(在 service.toml 的 [run.health] startup_s)`,
      );
    }
    const defaultOffload = (WORKER_DEFAULTS[w.name]?.offload ?? []).filter((n) =>
      stack.workers.some((x) => x.name === n),
    );
    if (w.offload.join(",") !== defaultOffload.join(",")) {
      notes.push(
        `${w.name}:offload = [${w.offload.join(", ")}](hostd 給的是這台所有 evictable 的服務)`,
      );
    }
  }
  if (stack.core) {
    lines.push("[services.core]", "enabled = true");
    const api = apiHealth(config);
    if (api !== null && api.port !== CORE_PORT) lines.push(`port = ${api.port}`);
    lines.push("");
  }
  if (stack.voiceNode) {
    lines.push("[services.voice-node]", "enabled = true");
    const link = voiceLinkUrl(config, stack);
    if (link !== null) lines.push(`env = ${inlineTable({ VOICE_LINK_URL: link })}`);
    lines.push("");
  }
  if (stack.stage) {
    lines.push("[services.stage]", "enabled = true");
    const overlay = parseBind(stageOverlayBind(config));
    if (overlay !== null && overlay.port !== OVERLAY_PORT) lines.push(`port = ${overlay.port}`);
    lines.push("");
  }
  if (notes.length > 0) {
    lines.push("# Not carried over:", ...notes.map((n) => `#   ${n}`), "");
  }
  const text = `${lines.join("\n").trimEnd()}\n`;
  parseHostConfig(hostToml, text); // what is written must load
  return { text, notes };
}

export interface MigrateOptions {
  force?: boolean;
  dryRun?: boolean;
  /** Defaults to the OS host name. */
  name?: string;
}

export async function migrate(target: HostTarget, options: MigrateOptions = {}): Promise<void> {
  const config = await loadConfig(target.configPath);
  const name = options.name ?? (osHostname().toLowerCase() || "main");
  const { text, notes } = hostTomlFrom(config, target.configPath, target.hostToml, name);
  if (!options.dryRun && existsSync(target.hostToml) && !options.force) {
    throw new HostCommandError(`${target.hostToml} 已經存在;要覆寫請加 --force`);
  }
  if (options.dryRun) section(`會寫入 ${target.hostToml}(dry-run,沒有寫入)`);
  else {
    writeFileSync(target.hostToml, text, "utf8");
    ok(`已寫入 ${target.hostToml}`);
  }
  for (const line of text.trimEnd().split("\n")) println(dim(`  ${line}`));
  for (const n of notes) warn(`沒有帶過來:${n}`);
}
