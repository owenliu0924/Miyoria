import { Config, ConfigError } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import {
  ExtensionManifest,
  extensionEnv,
  extensionEnvReport,
  extensionSecrets,
  extensionSettings,
  isCoreSecret,
  looksLikeSecret,
} from "../src/index.js";

const HOST = {
  PATH: "/usr/bin",
  HOME: "/home/owen",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LLM_API_KEY: "sk-secret",
  DISCORD_BOT_TOKEN: "token",
  MIYORIA_API_TOKEN: "api",
  NODE_OPTIONS: "--import tsx",
  HTTPS_PROXY: "http://user:pass@proxy:8080",
  MIYORIA_MC_URL: "ws://127.0.0.1:7890",
  MIYORIA_MC_TOKEN: "mc",
  MIYORIA_MCP_SECRET: "nope",
};

describe("extensionEnv", () => {
  it("passes_the_platform_allowlist_only", () => {
    const env = extensionEnv("x", { pass: [], set: {} }, HOST, "linux");
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/owen",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      MIYORIA_RPC: "stdio",
      MIYORIA_EXTENSION_ID: "x",
    });
  });

  it("adds_declared_names_and_prefixes_and_configured_values", () => {
    const env = extensionEnv(
      "miyoria.minecraft",
      { pass: ["MIYORIA_MC_*"], set: { MIYORIA_MC_TOKEN: "from-config", EXTRA: "1" } },
      HOST,
      "linux",
    );
    expect(env.MIYORIA_MC_URL).toBe("ws://127.0.0.1:7890");
    expect(env.MIYORIA_MC_TOKEN).toBe("from-config");
    expect(env.EXTRA).toBe("1");
    // `MIYORIA_MC_*` is a prefix of `MIYORIA_MC`, not of `MIYORIA_MCP_...`.
    expect(env.MIYORIA_MCP_SECRET).toBeUndefined();
    for (const secret of [
      "LLM_API_KEY",
      "DISCORD_BOT_TOKEN",
      "MIYORIA_API_TOKEN",
      "NODE_OPTIONS",
    ]) {
      expect(env[secret]).toBeUndefined();
    }
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("protocol_variables_cannot_be_overridden", () => {
    const env = extensionEnv(
      "x",
      { pass: ["MIYORIA_*"], set: { MIYORIA_RPC: "tcp", MIYORIA_EXTENSION_ID: "other" } },
      { MIYORIA_RPC: "tcp" },
      "linux",
    );
    expect(env.MIYORIA_RPC).toBe("stdio");
    expect(env.MIYORIA_EXTENSION_ID).toBe("x");
  });

  it("matches_case_insensitively_on_windows", () => {
    const host = { Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\T", Secret: "s" };
    const win = extensionEnv("x", { pass: [], set: { path: "D:\\bin" } }, host, "win32");
    expect(win.SystemRoot).toBe("C:\\Windows");
    expect(win.TEMP).toBe("C:\\T");
    expect(win.Secret).toBeUndefined();
    // The configured value replaces the inherited `Path` instead of adding a second one.
    expect(win.Path).toBeUndefined();
    expect(win.path).toBe("D:\\bin");
    // Exact case elsewhere.
    expect(extensionEnv("x", undefined, { Path: "/bin" }, "linux").Path).toBeUndefined();
  });
});

describe("credentials and wildcards", () => {
  const HOST2 = {
    PATH: "/usr/bin",
    LLM_API_KEY: "sk-secret",
    LLM_BASE_URL: "https://api.example",
    DISCORD_BOT_TOKEN: "token",
    MIYORIA_API_TOKEN: "api",
    MIYORIA_HLS_SECRET: "hls",
    MIYORIA_GITHUB_APP_PRIVATE_KEY: "pem",
    MIYORIA_MC_URL: "ws://127.0.0.1:7890",
    MIYORIA_MC_TOKEN: "mc",
    MIYORIA_OSU_TOKEN: "osu",
  };

  it("a wildcard never hands over a credential, whoever wrote it", () => {
    for (const owner of [false, true]) {
      const r = extensionEnvReport(
        "x",
        { pass: ["LLM_*", "MIYORIA_*", "DISCORD_*"], set: {}, owner },
        HOST2,
        "linux",
      );
      expect(r.env.LLM_BASE_URL).toBe("https://api.example");
      expect(r.env.MIYORIA_MC_URL).toBe("ws://127.0.0.1:7890");
      expect(r.held).toEqual([
        "DISCORD_BOT_TOKEN",
        "LLM_API_KEY",
        "MIYORIA_API_TOKEN",
        "MIYORIA_GITHUB_APP_PRIVATE_KEY",
        "MIYORIA_HLS_SECRET",
        "MIYORIA_MC_TOKEN",
        "MIYORIA_OSU_TOKEN",
      ]);
      for (const name of r.held) expect(r.env[name]).toBeUndefined();
    }
  });

  it("an extension's own credential passes by its exact name, Core's only by the owner's", () => {
    const manifest = extensionEnvReport(
      "miyoria.minecraft",
      { pass: ["MIYORIA_MC_*", "MIYORIA_MC_TOKEN", "LLM_API_KEY", "DISCORD_BOT_TOKEN"], set: {} },
      HOST2,
      "linux",
    );
    expect(manifest.env.MIYORIA_MC_TOKEN).toBe("mc");
    expect(manifest.env.MIYORIA_MC_URL).toBe("ws://127.0.0.1:7890");
    expect(manifest.env.LLM_API_KEY).toBeUndefined();
    expect(manifest.held).toEqual(["DISCORD_BOT_TOKEN", "LLM_API_KEY"]);
    const owner = extensionEnv(
      "x",
      { pass: ["LLM_API_KEY"], set: {}, owner: true },
      HOST2,
      "linux",
    );
    expect(owner.LLM_API_KEY).toBe("sk-secret");
  });

  it("tells credentials by their words", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "APIKEY",
      "MY_ACCESSKEY",
      "GH_TOKEN",
      "DB_PASS",
      "DB_PASSWORD",
      "X_CLIENT_SECRET",
      "SESSION_COOKIE",
      "SENTRY_DSN",
      "SLACK_WEBHOOK_URL",
    ]) {
      expect(looksLikeSecret(name), name).toBe(true);
    }
    for (const name of [
      "MIYORIA_MC_URL",
      "MIYORIA_TEST_PASSED",
      "PATH",
      "HOME",
      "KEYBOARD_LAYOUT",
    ]) {
      expect(looksLikeSecret(name), name).toBe(false);
    }
    expect(isCoreSecret("LLM_API_KEY")).toBe(true);
    expect(isCoreSecret("LLM_BASE_URL")).toBe(false);
    expect(isCoreSecret("MIYORIA_MC_TOKEN")).toBe(false);
  });

  it("the owner's secrets come by name, kept apart from the environment", () => {
    expect(
      extensionSecrets(["LLM_API_KEY", "MISSING", "MIYORIA_MC_TOKEN"], HOST2, "linux"),
    ).toEqual({ LLM_API_KEY: "sk-secret", MIYORIA_MC_TOKEN: "mc" });
    expect(extensionSecrets(["llm_api_key"], HOST2, "win32")).toEqual({ llm_api_key: "sk-secret" });
  });

  it("a manifest naming one of Core's credentials gets a warning saying the owner decides", () => {
    const m = ExtensionManifest.parse(
      [
        'id = "x"',
        'version = "1"',
        'runtime = "node"',
        'entry = "i.js"',
        "[env]",
        'pass = ["LLM_API_KEY", "X_TOKEN"]',
        'secrets = ["X_TOKEN"]',
      ].join("\n"),
    );
    expect(m.errors()).toEqual([]);
    const warnings = m.warnings().join("\n");
    expect(warnings).toContain("`LLM_API_KEY`, one of Core's own credentials");
    expect(warnings).toContain("asks for credentials the owner must grant");
    expect(warnings).not.toContain("`X_TOKEN`, one of");
  });
});

describe("extension env settings", () => {
  it("reads_env_and_env_pass_and_keeps_them_out_of_the_extension_config", () => {
    const cfg = Config.fromToml(`
      [extensions."x.y"]
      greeting = "hi"
      env = { TOKEN = "t" }
      env_pass = ["APP_*"]
    `);
    const s = extensionSettings(cfg, "x.y");
    expect(s.env).toEqual({ TOKEN: "t" });
    expect(s.envPass).toEqual(["APP_*"]);
    expect(s.config).toEqual({ greeting: "hi" });
    expect(extensionSettings(cfg, "other")).toMatchObject({ env: {}, envPass: null });
    const bad = Config.fromToml(`
      [extensions.x]
      env = { "BAD-NAME" = "v" }
    `);
    expect(() => extensionSettings(bad, "x")).toThrow(ConfigError);
  });

  it("reads run_in, secrets and the owner's tool risks, and keeps them out of the config", () => {
    const cfg = Config.fromToml(`
      [extensions."x.y"]
      greeting = "hi"
      run_in = "host"
      secrets = ["X_TOKEN"]
      tools."weather.now".risk = "low"
    `);
    const s = extensionSettings(cfg, "x.y");
    expect(s).toMatchObject({
      runIn: "host",
      secrets: ["X_TOKEN"],
      tools: { "weather.now": { risk: "low" } },
      config: { greeting: "hi" },
    });
    expect(extensionSettings(cfg, "other")).toMatchObject({ runIn: null, secrets: [], tools: {} });
    for (const bad of ['run_in = "moon"', 'secrets = ["BAD-NAME"]', 'tools.t.risk = "huge"']) {
      expect(() => extensionSettings(Config.fromToml(`[extensions.x]\n${bad}`), "x")).toThrow(
        ConfigError,
      );
    }
  });
});
