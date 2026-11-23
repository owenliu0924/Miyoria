// Output for scripts: results on stdout and everything else on stderr, the `--json` documents of
// status, doctor and config list, and a non-interactive `init` that takes its secrets from the
// environment or stdin and never prints them.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostInfo } from "@miyoria/contracts/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exampleConfig, PACKAGE_ROOT } from "../src/assets.js";
import { checkArgs, parseArgs, UsageError } from "../src/cli.js";
import * as configCmd from "../src/commands/config.js";
import * as doctor from "../src/commands/doctor.js";
import * as host from "../src/commands/host.js";
import { initSecrets, run, SECRET_ENV } from "../src/commands/init.js";
import { DefaultsPrompter, type Reporter } from "../src/prompt.js";
import { eprintln, note, type Output, ok, println, setOutput, warn } from "../src/ui.js";
import { tempDir } from "./scripted.js";

const BUNDLED = join(PACKAGE_ROOT, "..", "..", "profiles");

let dir: string;
let stdout: string[];
let stderr: string[];
let restore: () => void;

beforeEach(() => {
  dir = tempDir();
  stdout = [];
  stderr = [];
  const sink: Output = { out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
  restore = setOutput(sink);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

const out = () => stdout.join("");
const err = () => stderr.join("");

describe("streams", () => {
  it("puts results on stdout and notes, warnings and failures on stderr", () => {
    println("result");
    ok("done");
    note("a note");
    warn("a warning");
    eprintln("a failure");
    expect(out()).toBe("result\n✓ done\n");
    expect(err()).toBe("· a note\n! a warning\na failure\n");
  });
});

describe("--json", () => {
  it("status: a miyoria.status/1 document and nothing else on stdout", async () => {
    writeFileSync(join(dir, "host.toml"), 'name = "test-pc"\n[services.asr]\n');
    await host.status(host.hostTarget(join(dir, "miyoria.toml")), { json: true });
    const doc = JSON.parse(out());
    expect(doc).toEqual({
      schema: "miyoria.status/1",
      host_toml: join(dir, "host.toml"),
      machine: { name: "test-pc", enabled: ["asr"], hostd: null, gpu: null, services: [] },
      core: null,
    });
  });

  it("status: this machine's part, from hostd's report, without its tokens", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    const info = {
      name: "main-pc",
      version: "0.5.0",
      platform: "win32",
      protocol: 1,
      link: "connected",
      gpu: { name: "RTX 4070 SUPER", total_mb: 12_282, used_mb: 5_120, reserve_mb: 1_500 },
      services: [
        {
          name: "asr",
          kind: "worker",
          provides: ["asr"],
          state: "running",
          since: now,
          port: 8003,
          pid: 4242,
          url: "http://127.0.0.1:8003",
          healthy: true,
          restarts: 0,
          token: "secret-service-token",
        },
      ],
    } as unknown as HostInfo;
    const daemon = { pid: 1000, started_at: "2026-11-23T09:00:00Z", workspace: "/srv/miyoria" };
    const machine = host.machineJson("main-pc", ["asr"], info, daemon);
    expect(machine).toEqual({
      name: "main-pc",
      enabled: ["asr"],
      hostd: {
        pid: 1000,
        started_at: "2026-11-23T09:00:00Z",
        workspace: "/srv/miyoria",
        version: "0.5.0",
        link: "connected",
      },
      gpu: {
        name: "RTX 4070 SUPER",
        total_mb: 12_282,
        used_mb: 5_120,
        free_mb: null,
        reserve_mb: 1_500,
      },
      services: [
        {
          name: "asr",
          kind: "worker",
          provides: ["asr"],
          state: "running",
          healthy: true,
          port: 8003,
          pid: 4242,
          url: "http://127.0.0.1:8003",
          restarts: 0,
          since: "2026-11-23T12:00:00.000Z",
          reason: null,
        },
      ],
    });
    expect(JSON.stringify(machine)).not.toContain("secret-service-token");
  });

  it("config list: every setting with its sources, secrets masked", () => {
    const config = join(dir, "miyoria.toml");
    writeFileSync(config, exampleConfig());
    writeFileSync(join(dir, ".env"), "DISCORD_BOT_TOKEN=bot.token.value.1234\nUNUSED=1\n");
    configCmd.list(config, false, true);
    const doc = JSON.parse(out());
    expect(Object.keys(doc)).toEqual(["schema", "config", "settings", "env_file", "env"]);
    expect(doc.schema).toBe("miyoria.config-list/1");
    const token = doc.settings.find(
      (s: { key: string }) => s.key === 'modules."platform.discord.bot".token',
    );
    expect(token).toMatchObject({
      sources: [{ variable: "DISCORD_BOT_TOKEN", source: "dotenv" }],
      plain_secret: false,
    });
    expect(token.value).toMatch(/^••••/);
    expect(out()).not.toContain("bot.token.value");
    expect(doc.env).toContainEqual({ name: "UNUSED", value: "1", referenced: false });
  });

  it("doctor: the checks as a document; the exit code still says it failed", async () => {
    await expect(doctor.run(join(dir, "missing.toml"), { json: true })).rejects.toBeInstanceOf(
      doctor.DoctorError,
    );
    const doc = JSON.parse(out());
    expect(doc).toMatchObject({ schema: "miyoria.doctor/1", ok: false, failures: 1 });
    expect(doc.checks).toHaveLength(1);
    expect(doc.checks[0]).toMatchObject({ group: "config", level: "fail", fix: [] });
  });

  it("cannot be combined with doctor --fix or --print-hashes", async () => {
    const config = join(dir, "miyoria.toml");
    await expect(doctor.run(config, { json: true, fix: true })).rejects.toThrow(
      "--json cannot be combined with --fix",
    );
    await expect(doctor.run(config, { json: true, printHashes: "asr" })).rejects.toThrow(
      "--json cannot be combined with --print-hashes",
    );
    expect(out()).toBe("");
    expect(parseArgs(["status", "--json", "--all"]).ctx.options).toMatchObject({
      json: true,
      all: true,
    });
    expect(parseArgs(["host", "ls", "--json"]).ctx.options.json).toBe(true);
    expect(parseArgs(["config", "list", "--json"]).ctx.options.json).toBe(true);
  });
});

describe("init --non-interactive", () => {
  const LLM = "sk-from-the-pipeline-0987654321";
  const DISCORD = "discord.token.from.the.pipeline";

  it("reads the secrets from the documented variables", async () => {
    expect(
      await initSecrets(
        {},
        { [SECRET_ENV.llmKey]: LLM, [SECRET_ENV.discordToken]: DISCORD },
        async () => "",
      ),
    ).toEqual({ LLM_API_KEY: LLM, OPENCODE_API_KEY: LLM, DISCORD_BOT_TOKEN: DISCORD });
    expect(await initSecrets({}, {}, async () => "")).toEqual({});
  });

  it("reads them from stdin, the LLM key first, before the variables", async () => {
    const stdin = async () => `${LLM}\r\n${DISCORD}\n`;
    expect(await initSecrets({ llmKeyStdin: true, discordTokenStdin: true }, {}, stdin)).toEqual({
      LLM_API_KEY: LLM,
      OPENCODE_API_KEY: LLM,
      DISCORD_BOT_TOKEN: DISCORD,
    });
    expect(
      await initSecrets(
        { discordTokenStdin: true },
        { [SECRET_ENV.discordToken]: "ignored", [SECRET_ENV.llmKey]: LLM },
        async () => `${DISCORD}\n`,
      ),
    ).toEqual({ LLM_API_KEY: LLM, OPENCODE_API_KEY: LLM, DISCORD_BOT_TOKEN: DISCORD });
  });

  it("writes them to .env and never prints them", async () => {
    const printed: string[] = [];
    const reporter: Reporter = {
      intro: (m) => printed.push(m),
      outro: (m) => printed.push(m),
      section: (m) => printed.push(m),
      note: (m) => printed.push(m),
      ok: (m) => printed.push(m),
      warn: (m) => printed.push(m),
      fail: (m) => printed.push(m),
      box: (title, lines) => printed.push(title, ...lines),
    };
    const secrets = await initSecrets(
      { llmKeyStdin: true },
      { [SECRET_ENV.discordToken]: DISCORD },
      async () => `${LLM}\n`,
    );
    await run(join(dir, "miyoria.toml"), new DefaultsPrompter(reporter, secrets), {
      yes: true,
      bundledProfiles: BUNDLED,
      processEnv: new Map(),
      command: "miyoria",
    });
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain(`LLM_API_KEY=${LLM}\n`);
    expect(env).toContain(`DISCORD_BOT_TOKEN=${DISCORD}\n`);
    const shown = [...printed, out(), err()].join("\n");
    expect(shown).not.toContain(LLM);
    expect(shown).not.toContain(DISCORD);
    expect(shown).not.toContain("No LLM API key is set");
  });

  it("takes secrets only from stdin or the environment, never from a flag value", () => {
    const parsed = parseArgs(["init", "--llm-key-stdin", LLM]);
    expect(() => checkArgs(parsed.path, parsed.ctx)).toThrow(UsageError);
    expect(parseArgs(["init", "--yes"]).ctx.yes).toBe(true);
    expect(parseArgs(["init", "--non-interactive"]).ctx.options["non-interactive"]).toBe(true);
  });
});
