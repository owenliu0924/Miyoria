// The hostd commands: option parsing, `host migrate`, and up / status / logs / restart / down
// against a daemon running in this process with a fake service.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostServiceStatus } from "@miyoria/contracts/host";
import { Daemon, parseHostConfig } from "@miyoria/hostd";
import { Config } from "@miyoria/runtime/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import * as host from "../src/commands/host.js";
import { hostTomlFrom, migrate } from "../src/commands/migrate.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const NOENV = () => undefined;

let dir: string;
let out: string[];
let restore: () => void;
const daemons: Daemon[] = [];

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "host-"));
  // A checkout of its own, so nothing above it is taken for the source folder.
  write("pnpm-workspace.yaml", "packages: []\n");
  mkdirSync(join(dir, "workers"), { recursive: true });
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(async () => {
  restore();
  for (const d of daemons.splice(0)) await d.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const text = () => out.join("");

describe("command line", () => {
  it("parses_the_hostd_commands", () => {
    const up = parseArgs(["up", "asr", "tts", "--host-config", "x/host.toml", "--no-wait"]);
    expect(up.path.at(-1)?.name).toBe("up");
    expect(up.ctx.args).toEqual(["asr", "tts"]);
    expect(up.ctx.options).toMatchObject({ "host-config": "x/host.toml", "no-wait": true });
    expect(parseArgs(["up", "--foreground"]).ctx.options.foreground).toBe(true);

    const down = parseArgs(["down", "--force"]);
    expect(down.path.at(-1)?.name).toBe("down");
    expect(down.ctx.args).toEqual([]);
    expect(down.ctx.options.force).toBe(true);

    const restart = parseArgs(["restart", "core", "--force"]);
    expect(restart.ctx.args).toEqual(["core"]);

    const logs = parseArgs(["logs", "asr", "-f", "-n", "20"]);
    expect(logs.ctx.args).toEqual(["asr"]);
    expect(logs.ctx.options).toMatchObject({ follow: true, lines: "20" });
    expect(parseArgs(["logs", "asr"]).ctx.options.lines).toBe("100");

    const migrateArgs = parseArgs(["host", "migrate", "--dry-run", "--force"]);
    expect(migrateArgs.path.map((c) => c.name)).toEqual(["miyoria", "host", "migrate"]);
    expect(migrateArgs.ctx.options).toMatchObject({ "dry-run": true, force: true });

    expect(parseArgs(["hostd", "-c", "a/miyoria.toml"]).ctx.config).toBe("a/miyoria.toml");
    expect(parseArgs(["status", "--host-config", "h.toml"]).ctx.options["host-config"]).toBe(
      "h.toml",
    );
  });

  it("puts_host_toml_next_to_the_config_by_default", () => {
    const t = host.hostTarget(join(dir, "miyoria.toml"));
    expect(t.hostToml).toBe(join(dir, "host.toml"));
    expect(host.hostTarget("miyoria.toml", join(dir, "other", "h.toml")).hostToml).toBe(
      join(dir, "other", "h.toml"),
    );
  });
});

describe("host migrate", () => {
  const ALL = `[machine]\nroles = ["broadcast", "core", "inference"]\n[modules.voice]\nvad_engine = "silero"\n`;

  function migrated(toml: string) {
    const configPath = write("miyoria.toml", toml);
    const { text: written, notes } = hostTomlFrom(
      Config.fromToml(toml, NOENV),
      configPath,
      join(dir, "host.toml"),
      "main-pc",
    );
    return { text: written, notes, host: parseHostConfig("host.toml", written) };
  }

  it("keeps_the_environments_ports_and_services_of_a_single_pc", () => {
    const { host: h, notes } = migrated(ALL);
    expect(h.name).toBe("main-pc");
    expect(h.network).toEqual({ bind: "127.0.0.1" });
    expect(h.paths.state).toBe("data/host");
    expect(Object.keys(h.services)).toEqual([
      "asr",
      "tts",
      "sing",
      "turn",
      "core",
      "voice-node",
      "stage",
    ]);
    expect(h.services.asr).toMatchObject({
      enabled: true,
      python: "workers/.venv-asr-qwen",
      port: 8003,
      env: {},
    });
    expect(h.services.tts).toMatchObject({ python: "workers/.venv-tts-faster", port: 8002 });
    expect(h.services.sing).toMatchObject({ python: "workers/.venv-sing", port: 8005 });
    expect(h.services.turn).toMatchObject({ python: "workers/.venv-turn", port: 8006 });
    expect(h.services.core).toEqual({ enabled: true, env: {} });
    expect(h.services["voice-node"]).toEqual({ enabled: true, env: {} });
    expect(notes).toEqual([]);
  });

  it("writes_worker_overrides_the_core_port_and_the_voice_link_of_a_split_setup", () => {
    const { host: h } = migrated(`[machine]
roles = ["broadcast", "inference"]
[machine.hosts]
core = "192.168.1.10"
inference = "192.168.1.20"
[stack.workers]
asr = { env = { ASR_QWEN_SIZE = "1.7B" }, venv = "envs/asr" }
[stage]
overlay_bind = "0.0.0.0:7990"
`);
    expect(h.network).toEqual({ bind: "192.168.1.20", advertise: "192.168.1.20" });
    expect(h.services.asr).toMatchObject({ python: "envs/asr", env: { ASR_QWEN_SIZE: "1.7B" } });
    expect(h.services.core).toBeUndefined();
    expect(h.services["voice-node"]?.env).toEqual({
      VOICE_LINK_URL: "ws://192.168.1.10:7879/voice-link",
    });
    expect(h.services.stage?.port).toBe(7990);
  });

  it("keeps_loopback_for_a_core_machine_whose_inference_is_elsewhere", () => {
    const { host: h } = migrated(`[machine]
roles = ["core"]
[machine.hosts]
inference = "192.168.1.20"
[modules.api]
bind = "127.0.0.1:7999"
`);
    expect(h.network).toEqual({ bind: "127.0.0.1" });
    expect(h.services).toEqual({ core: { enabled: true, port: 7999, env: {} } });
  });

  it("notes_what_host_toml_cannot_say", () => {
    const { notes, text: written } = migrated(
      `[machine]\nroles = ["inference"]\n[stack.workers]\nasr = { start_timeout_secs = 300, vram_mb = 2000 }\n`,
    );
    expect(notes.join("\n")).toMatch(/start_timeout_secs = 300/);
    expect(notes.join("\n")).toMatch(/vram_mb = 2000/);
    expect(written).toMatch(/# Not carried over:/);
  });

  it("never_overwrites_without_force_and_writes_nothing_on_a_dry_run", async () => {
    write("miyoria.toml", ALL);
    const target = host.hostTarget(join(dir, "miyoria.toml"));
    await migrate(target, { dryRun: true, name: "pc" });
    expect(existsSync(target.hostToml)).toBe(false);
    expect(text()).toContain("dry-run");
    await migrate(target, { name: "pc" });
    expect(readFileSync(target.hostToml, "utf8")).toContain('name = "pc"');
    await expect(migrate(target, { name: "other" })).rejects.toThrow(/--force/);
    await migrate(target, { name: "other", force: true });
    expect(readFileSync(target.hostToml, "utf8")).toContain('name = "other"');
  });
});

describe("status table", () => {
  it("lines_up_the_columns", () => {
    const s: HostServiceStatus = {
      name: "asr",
      kind: "worker",
      provides: ["asr"],
      state: "running",
      since: 1_000,
      port: 8003,
      pid: 42,
      healthy: true,
      restarts: 0,
    };
    const { port: _port, pid: _pid, ...rest } = s;
    const failed: HostServiceStatus = {
      ...rest,
      name: "voice-node",
      state: "failed",
      healthy: false,
      restarts: 5,
      reason: "放棄",
    };
    const lines = host.serviceTable([s, failed], 61_000);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^asr\s+running\s+✓\s+8003\s+42\s+0\s+1 分前$/);
    expect(lines[2]).toMatch(/^voice-node\s+failed\s+-\s+-\s+-\s+5\s+1 分前\s+放棄$/);
    // The columns start at the same place in every row.
    expect(lines[1]?.indexOf("running")).toBe(lines[2]?.indexOf("failed"));
  });
});

describe("up, status, logs, restart and down against a daemon", () => {
  const HEALTH = `
const http = require("node:http");
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("fake ready on " + process.env.PORT));
`;

  async function running(): Promise<host.HostTarget> {
    write("workers/fake/server.cjs", HEALTH);
    write(
      "workers/fake/service.toml",
      'name = "fake"\nkind = "worker"\n[run]\ncommand = ["{node}", "{service}/server.cjs"]\nport = "auto"\nport_env = "PORT"\n[run.health]\nhttp = "/"\nstartup_s = 15\n[run.stop]\ngrace_s = 1\n',
    );
    write("host.toml", 'name = "test-pc"\n[services.fake]\n');
    const target = host.hostTarget(join(dir, "miyoria.toml"));
    const daemon = new Daemon({
      hostConfig: target.hostToml,
      catalogRoot: dir,
      configPath: target.configPath,
      miyoria: [process.execPath],
      version: "test",
      readGpu: async () => null,
      timing: { pollMs: 100 },
      onShutdown: () => {},
    });
    daemons.push(daemon);
    await daemon.start();
    return target;
  }

  it("starts_shows_tails_restarts_and_stops", { timeout: 60_000 }, async () => {
    const target = await running();
    await host.up(target, { services: [] });
    expect(text()).toMatch(/hostd 已在執行/);
    expect(text()).toMatch(/✓ fake\s+http:\/\/127\.0\.0\.1:\d+/);
    expect(text()).toContain("全部就緒");

    out.length = 0;
    await host.status(target);
    expect(text()).toContain("這台電腦:test-pc");
    expect(text()).toMatch(/fake\s+running\s+✓/);
    expect(text()).toContain("讀不到");
    expect(text()).toContain("Core 連線:沒有");

    out.length = 0;
    await host.logs(target, { service: "fake", lines: 10 });
    expect(text()).toContain("fake ready on");

    out.length = 0;
    await host.restart(target, { service: "fake" });
    expect(text()).toMatch(/✓ fake/);

    out.length = 0;
    await host.down(target, { services: ["fake"] });
    expect(text()).toContain("■ fake");
    await expect(host.up(target, { services: ["nope"] })).rejects.toThrow(/沒有起來/);
    expect(text()).toContain("沒有叫 nope 的服務");

    out.length = 0;
    await host.down(target, { services: [] });
    expect(text()).toContain("hostd 已結束");
  });

  it("says_so_when_no_daemon_runs", async () => {
    write("host.toml", 'name = "idle-pc"\n[services.asr]\n[services.tts]\nenabled = false\n');
    const target = host.hostTarget(join(dir, "miyoria.toml"));
    await host.down(target, { services: [] });
    expect(text()).toContain("hostd 沒有在執行");
    out.length = 0;
    // No miyoria.toml either: the Core part says why it is skipped.
    await host.status(target);
    expect(text()).toContain("hostd 沒有在執行");
    expect(text()).toContain("host.toml 啟用的服務:asr");
    expect(text()).toContain("不查 Core");
  });

  it("needs_a_host_toml", async () => {
    await expect(
      host.up(host.hostTarget(join(dir, "miyoria.toml")), { services: [] }),
    ).rejects.toThrow(/host migrate/);
  });
});
