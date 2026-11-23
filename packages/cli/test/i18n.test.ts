// The language layer: both catalogues have the same messages with the same parameters, the
// language of a run is chosen as documented, and the first screen of `miyoria init` and the help
// render in both languages.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { HOST_ERROR_CODE } from "@miyoria/contracts/host";
import { HostRpcError } from "@miyoria/hostd";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { helpText, main, parseArgs } from "../src/cli.js";
import { rpcText } from "../src/commands/host.js";
import { run } from "../src/commands/init.js";
import { detectLang, langFlag, langOfLocale, parseLang } from "../src/i18n/detect.js";
import { catalogue, lang, setLang } from "../src/i18n/index.js";
import { type Output, setOutput } from "../src/ui.js";
import { Cancel, Scripted, tempDir } from "./scripted.js";

/** Every message as `path -> "string" | "array" | parameter count`. */
function shape(value: unknown, path = ""): Map<string, string | number> {
  const out = new Map<string, string | number>();
  if (typeof value === "function") out.set(path, value.length);
  else if (typeof value === "string") out.set(path, "string");
  else if (Array.isArray(value)) out.set(path, `array of ${value.length}`);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      for (const [p, s] of shape(inner, path === "" ? key : `${path}.${key}`)) out.set(p, s);
    }
  } else out.set(path, typeof value);
  return out;
}

describe("catalogues", () => {
  it("have the same keys and parameter counts in both languages", () => {
    const en = shape(catalogue("en"));
    const zh = shape(catalogue("zh-TW"));
    expect([...zh.keys()].sort()).toEqual([...en.keys()].sort());
    const differ = [...en].filter(
      ([key, s]) => zh.get(key) !== s && !String(s).startsWith("array"),
    );
    expect(differ).toEqual([]);
    expect(en.size).toBeGreaterThan(900);
  });

  it("have no empty message", () => {
    for (const code of ["en", "zh-TW"] as const) {
      const empty = [...shape(catalogue(code))].filter(([, s]) => s === "string");
      for (const [key] of empty) {
        const value = key
          .split(".")
          .reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], catalogue(code));
        if (value === "") throw new Error(`${code}: ${key} is empty`);
      }
    }
  });

  it("keep the English catalogue free of CJK text", () => {
    const cjk = /[㐀-鿿＀-￯]/;
    const found: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string" && cjk.test(value)) found.push(path);
      else if (typeof value === "object" && value !== null)
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(catalogue("en"), "en");
    expect(found).toEqual([]);
  });

  it("formats numbers and durations the same way everywhere", () => {
    setLang("en");
    const en = catalogue("en").common;
    expect(en.mb(24_564)).toBe("24,564 MB");
    expect(en.gb(1.25)).toBe("1.3 GB");
    expect([12, 300, 7200, 172_800].map(en.duration)).toEqual(["12 s", "5 min", "2 h", "2 d"]);
    expect(en.ago(90)).toBe("1 min ago");
    expect(en.list(["asr", "tts"])).toBe("asr, tts");
    const zh = catalogue("zh-TW").common;
    expect(zh.mb(24_564)).toBe("24,564 MB");
    expect([12, 300, 7200, 172_800].map(zh.duration)).toEqual([
      "12 秒",
      "5 分鐘",
      "2 小時",
      "2 天",
    ]);
    expect(zh.ago(90)).toBe("1 分鐘前");
    expect(zh.list(["asr", "tts"])).toBe("asr、tts");
  });
});

describe("language detection", () => {
  it.each([
    ["zh_TW.UTF-8", "zh-TW"],
    ["zh_TW.Big5", "zh-TW"],
    ["zh-TW", "zh-TW"],
    ["zh_HK.UTF-8", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh_Hant_HK", "zh-TW"],
    ["zh_CN.UTF-8", "en"],
    ["zh-Hans-TW", "en"],
    ["zh-SG", "en"],
    ["zh", "en"],
    ["en_US.UTF-8", "en"],
    ["ja_JP.UTF-8", "en"],
    ["C", "en"],
    ["POSIX", "en"],
    ["C.UTF-8", "en"],
    ["", "en"],
  ])("maps the locale %j to %s", (locale, expected) => {
    expect(langOfLocale(locale)).toBe(expected);
  });

  it("parses --lang values", () => {
    expect(parseLang("en")).toBe("en");
    expect(parseLang("zh-TW")).toBe("zh-TW");
    expect(parseLang("ZH_tw")).toBe("zh-TW");
    expect(parseLang("zh-CN")).toBeUndefined();
    expect(parseLang("fr")).toBeUndefined();
    expect(langFlag(["status", "--lang", "zh-TW"])).toBe("zh-TW");
    expect(langFlag(["--lang=en", "doctor"])).toBe("en");
    expect(langFlag(["--lang"])).toBe("");
    expect(langFlag(["config", "set", "--", "--lang", "x"])).toBeUndefined();
    expect(langFlag(["status"])).toBeUndefined();
  });

  it("takes --lang, then MIYORIA_LANG, then LC_ALL, LC_MESSAGES, LANG, then the system", () => {
    const system = () => "zh-Hant-TW";
    const zhEnv = { LANG: "zh_TW.UTF-8" };
    expect(detectLang({ flag: "en", env: { MIYORIA_LANG: "zh-TW", ...zhEnv }, system })).toBe("en");
    expect(detectLang({ env: { MIYORIA_LANG: "en", ...zhEnv }, system })).toBe("en");
    expect(detectLang({ env: { MIYORIA_LANG: "zh_HK.UTF-8" }, system: () => "en-US" })).toBe(
      "zh-TW",
    );
    expect(detectLang({ env: { MIYORIA_LANG: " " }, system })).toBe("zh-TW");
    expect(detectLang({ env: { LC_ALL: "en_US.UTF-8", LANG: "zh_TW.UTF-8" }, system })).toBe("en");
    expect(detectLang({ env: { LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US" }, system })).toBe(
      "zh-TW",
    );
    expect(detectLang({ env: { LANG: "zh_CN.UTF-8" }, system })).toBe("en");
    expect(detectLang({ env: {}, system })).toBe("zh-TW");
    expect(detectLang({ env: {}, system: () => "zh-CN" })).toBe("en");
    expect(detectLang({ env: {}, system: () => "en-GB" })).toBe("en");
  });
});

describe("rendering", () => {
  let out: string[];
  let restore: () => void;
  beforeEach(() => {
    out = [];
    const sink: Output = { out: (s) => out.push(s), err: (s) => out.push(s) };
    restore = setOutput(sink);
  });
  afterEach(() => restore());

  /** The intro, the first question and its choices of `miyoria init` in a new folder. */
  async function firstScreen(): Promise<string> {
    const dir = tempDir();
    try {
      const p = new Scripted([Cancel]);
      const shown: string[] = [];
      const select = p.select.bind(p);
      p.select = async (message, options, initial) => {
        shown.push(message, ...options.map((o, i) => `${i === initial ? ">" : " "} ${o}`));
        return select(message, options, initial);
      };
      await run(join(dir, "miyoria.toml"), p, { bundledProfiles: null }).catch(() => {});
      return [...p.printed, ...shown].join("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("renders the first screen of init in English", async () => {
    setLang("en");
    expect(await firstScreen()).toBe(
      [
        "intro: Miyoria setup. Press Ctrl+C at any time to cancel.",
        "Choose a role for this machine",
        "> Core node, text only (recommended; no GPU required)",
        "  Core node with voice (speech recognition and synthesis here; requires an NVIDIA GPU)",
        "  Service node: provides services, such as GPU singing, to a Core node on another machine",
      ].join("\n"),
    );
  });

  it("renders the first screen of init in Traditional Chinese", async () => {
    setLang("zh-TW");
    expect(await firstScreen()).toBe(
      [
        "intro: Miyoria 設定精靈。隨時可按 Ctrl+C 取消。",
        "請選擇本機的用途",
        "> Core 節點，僅文字（建議；不需要顯示卡）",
        "  Core 節點（含語音）：於本機執行語音辨識與語音合成（需要 NVIDIA 顯示卡）",
        "  服務節點：為另一台機器上的 Core 節點提供服務（例如以顯示卡執行翻唱）",
      ].join("\n"),
    );
  });

  it("builds the help in the language active when it is asked for", () => {
    setLang("zh-TW");
    const zh = helpText(parseArgs([]).path);
    expect(zh).toContain("用法：miyoria [選項] <指令>");
    expect(zh).toContain("--lang <LANG>");
    expect(zh).toContain("使用 `miyoria <指令> --help` 查看指令的詳細說明。");
    expect(zh).toContain("zh-TW、zh-HK、zh-MO、zh-Hant 使用繁體中文");
    setLang("en");
    const en = helpText(parseArgs([]).path);
    expect(en).toContain("Usage: miyoria [options] <command>");
    expect(en).toContain("Use `miyoria <command> --help` for more about a command.");
    expect(en).toContain("zh-Hant select Traditional Chinese");
  });

  it("words hostd's refusals from their codes", () => {
    const guarded = new HostRpcError(HOST_ERROR_CODE.Guarded, "sing 受保護", {
      states: ["singing", "live"],
    });
    const unknown = new HostRpcError(HOST_ERROR_CODE.Guarded, "sing 受保護", { states: null });
    const missing = new HostRpcError(HOST_ERROR_CODE.NotInstalled, "sing 不是這台的服務");
    setLang("en");
    expect(rpcText(guarded, "sing")).toBe(
      "sing is busy (singing in progress, live stream in progress). Try again when it is idle, or add --force.",
    );
    expect(rpcText(unknown, "sing")).toContain("could not be determined");
    expect(rpcText(missing, "sing")).toBe(
      "sing is not a service of this machine (host.toml has no [services.sing])",
    );
    // Without the service, or for a code the CLI does not word, hostd's own text.
    expect(rpcText(missing)).toBe("sing 不是這台的服務");
    expect(rpcText(new HostRpcError(HOST_ERROR_CODE.Busy, "busy"), "sing")).toBe("busy");
    setLang("zh-TW");
    expect(rpcText(guarded, "sing")).toBe(
      "sing 正在使用中（翻唱進行中、直播進行中）。請待其閒置後再試；若仍要執行，請加上 --force。",
    );
  });

  it("follows --lang and refuses an unknown language", async () => {
    expect(await main(["--lang", "zh-TW", "--help"])).toBe(0);
    expect(lang()).toBe("zh-TW");
    expect(out.join("")).toContain("用法：");
    out.length = 0;
    expect(await main(["--help"])).toBe(0);
    expect(lang()).toBe("en"); // MIYORIA_LANG=en (vitest.config.ts)
    expect(out.join("")).toContain("Usage:");
    out.length = 0;
    expect(await main(["--lang", "fr", "--help"])).toBe(2);
    expect(out.join("")).toContain("Unsupported language `fr` for --lang; use en or zh-TW");
  });
});
