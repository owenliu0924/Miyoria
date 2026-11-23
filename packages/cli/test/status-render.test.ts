// `miyoria status` for this machine, rendered from fixed hostd data in both languages: the column
// alignment holds for English and for CJK text.

import type { HostInfo } from "@miyoria/contracts/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostStatus } from "../src/commands/host.js";
import { setLang } from "../src/i18n/index.js";
import { type Output, setOutput } from "../src/ui.js";

const NOW = Date.parse("2026-11-23T12:00:00Z");

const INFO: HostInfo = {
  name: "main-pc",
  version: "0.5.0",
  platform: "win32",
  protocol: 1,
  link: "connected",
  gpu: {
    name: "RTX 4070 SUPER",
    total_mb: 12_282,
    used_mb: 5_120,
    free_mb: 7_162,
    reserve_mb: 1_500,
  },
  services: [
    {
      name: "asr",
      kind: "worker",
      provides: ["asr"],
      state: "running",
      since: NOW - 120_000,
      port: 8003,
      pid: 4242,
      healthy: true,
      restarts: 0,
    },
    {
      name: "tts",
      kind: "worker",
      provides: ["tts"],
      state: "failed",
      since: NOW - 30_000,
      healthy: false,
      restarts: 3,
      reason: "exited with code 1",
    },
  ],
};

const DAEMON = { pid: 1000, started_at: "2026-11-23T09:00:00Z", workspace: "/srv/miyoria" };

let restore: () => void;
beforeEach(() => {
  // A replaced output prints no colours.
  const sink: Output = { out: () => {}, err: () => {} };
  restore = setOutput(sink);
});
afterEach(() => restore());

describe("status of this machine", () => {
  it("renders_in_english", () => {
    setLang("en");
    const { title, lines } = hostStatus(INFO, DAEMON, NOW);
    expect(title).toBe("This machine: main-pc");
    expect(lines[0]).toBe("hostd    PID 1000  up 3 h  Core link: connected  /srv/miyoria");
    expect(lines[1]).toBe(
      "GPU      RTX 4070 SUPER  5,120 / 12,282 MB used, 7,162 MB free, 1,500 MB reserved",
    );
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("Service  State    Health  Port  PID   Restarts  Changed    Reason");
    expect(lines[4]).toBe("asr      running  ✓       8003  4242  0         2 min ago");
    expect(lines[5]?.indexOf("failed")).toBe(lines[4]?.indexOf("running"));
    expect(lines[5]?.indexOf("30 s ago")).toBe(lines[3]?.indexOf("Changed"));
    expect(lines[5]).toBe(
      "tts      failed   -       -     -     3         30 s ago   exited with code 1",
    );
  });

  it("renders_in_traditional_chinese", () => {
    setLang("zh-TW");
    const { title, lines } = hostStatus(INFO, DAEMON, NOW);
    expect(title).toBe("本機：main-pc");
    expect(lines[0]).toBe("hostd   PID 1000  已執行 3 小時  Core 連線：已連線  /srv/miyoria");
    expect(lines[1]).toBe(
      "顯示卡  RTX 4070 SUPER  已用 5,120 / 12,282 MB，可用 7,162 MB，保留 1,500 MB",
    );
    expect(lines[3]).toBe("服務  狀態    健康狀態  埠    PID   重啟次數  變更時間  原因");
    expect(lines[4]).toBe("asr   執行中  ✓         8003  4242  0         2 分鐘前");
    // The state column is translated, and the columns line up by East Asian width.
    expect(lines[5]).toBe(
      "tts   失敗    -         -     -     3         30 秒前   exited with code 1",
    );
  });
});
