// The browser driver in the browser image on a real Docker, without the sandbox service: the
// container is started the way the service starts a job's (read-only, not root, no capabilities,
// tmpfs for /tmp and /dev/shm) with no network at all, and a small web server runs next to the
// driver inside it, so nothing leaves the machine. Core's `RpcClient` talks to the driver over
// the container's stdin and stdout.
//
// What it needs, and skips without:
// - Docker answering (`docker version`); CI's Linux has it.
// - The browser image built on this machine (`miyoria sandbox build`, or CI's buildx job tagging
//   it as `imageTag("browser", imageHash(...))`), and `MIYORIA_SANDBOX_IMAGE_TESTS=1`.
// Nothing here needs the sandbox service (work package P2).

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRIVER, DRIVER_ARGV } from "../../src/browse/protocol.js";
import { RpcClient, RpcError } from "../../src/browse/rpc.js";
import { imageHash, imageTag } from "../../src/service/images.js";
import { TEST_SERVER } from "./test-server.js";

function dockerAvailable(): boolean {
  if (process.env.MIYORIA_SKIP_DOCKER_TESTS === "1") return false;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

const IMAGE_DIR = resolve(import.meta.dirname, "../../../../../workers/sandbox/image/browser");
const wanted = process.env.MIYORIA_SANDBOX_IMAGE_TESTS === "1" && dockerAvailable();
const tag = wanted ? imageTag("browser", (await imageHash(IMAGE_DIR)) ?? "") : "";
const present =
  wanted && spawnSync("docker", ["image", "inspect", tag], { windowsHide: true }).status === 0;

describe.skipIf(!present)(
  "the browser driver in the browser image (needs the image, not P2)",
  () => {
    let child: ChildProcessWithoutNullStreams;
    let rpc: RpcClient;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      rpc.call(method, params, { timeoutMs: 60_000 });

    beforeAll(async () => {
      child = spawn(
        "docker",
        [
          "run",
          "-i",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=512m",
          "--tmpfs",
          "/dev/shm:rw,nosuid,nodev,size=256m",
          "--tmpfs",
          "/home/sandbox:rw,size=256m,mode=1777",
          "--tmpfs",
          "/workspace:rw,size=64m,mode=1777",
          "--user",
          "65534:65534",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "1024",
          "--memory",
          "2048m",
          "--init",
          "--env",
          "HOME=/home/sandbox",
          "--env",
          `SERVER_JS=${TEST_SERVER}`,
          "--workdir",
          "/workspace",
          tag,
          "sh",
          "-c",
          `node -e "$SERVER_JS" & exec ${DRIVER_ARGV.join(" ")}`,
        ],
        { windowsHide: true },
      );
      child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
      rpc = new RpcClient(child.stdin, child.stdout);
      await call(DRIVER.ping);
    }, 180_000);

    afterAll(() => {
      rpc?.close("done");
      child?.stdin.end();
      child?.kill();
    });

    it("opens, reads the outline, clicks, types and goes back", async () => {
      const opened = (await call(DRIVER.open, { url: "http://127.0.0.1:8080/" })) as {
        title: string;
        status: number;
      };
      expect(opened).toMatchObject({ title: "首頁", status: 200 });
      const outline = (await call(DRIVER.read, { mode: "outline" })) as { text: string };
      expect(outline.text).toContain("# 測試首頁");
      const link = /\[(e\d+)\] 連結 去第二頁/.exec(outline.text)?.[1];
      const field = /\[(e\d+)\] 輸入框\(text\) 搜尋/.exec(outline.text)?.[1];
      const button = /\[(e\d+)\] 按鈕 送出/.exec(outline.text)?.[1];
      expect([link, field, button].every((r) => r !== undefined)).toBe(true);

      await call(DRIVER.act, { action: "type", ref: field, text: "小莉" });
      await call(DRIVER.act, { action: "click", ref: button });
      expect(((await call(DRIVER.read, { mode: "text" })) as { text: string }).text).toContain(
        "你好 小莉",
      );

      const step = (await call(DRIVER.act, { action: "click", ref: link })) as {
        navigated: boolean;
        title: string;
      };
      expect(step).toMatchObject({ navigated: true, title: "第二頁" });
      const back = (await call(DRIVER.act, { action: "back" })) as { title: string };
      expect(back.title).toBe("首頁");
    }, 120_000);

    it("saves a download under /workspace/downloads with a safe name", async () => {
      await call(DRIVER.open, { url: "http://127.0.0.1:8080/" });
      const outline = (await call(DRIVER.read, { mode: "links" })) as { text: string };
      const file = /\[(e\d+)\] 下載報告/.exec(outline.text)?.[1];
      const step = (await call(DRIVER.act, { action: "click", ref: file })) as {
        downloads: { path: string; bytes: number }[];
      };
      expect(step.downloads).toEqual([{ path: "downloads/report.txt", bytes: 17 }]);
    }, 120_000);

    it("takes a PNG screenshot 1280 wide, under 2 MiB", async () => {
      await call(DRIVER.open, { url: "data:text/html,<h1 style='font-size:80px'>截圖測試</h1>" });
      const shot = (await call(DRIVER.shot, { full_page: true })) as {
        mime: string;
        data: string;
        width: number;
      };
      const bytes = Buffer.from(shot.data, "base64");
      expect(shot.mime).toBe("image/png");
      expect(shot.width).toBe(1280);
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBe(1280);
      expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    }, 120_000);

    it("refuses the machine's files and the browser's own pages", async () => {
      for (const url of ["file:///etc/passwd", "chrome://version"]) {
        const error = await call(DRIVER.open, { url }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcError);
        expect((error as RpcError).code).toBe(-32602);
      }
    }, 60_000);

    it("has no way out without the job's proxy", async () => {
      const error = await call(DRIVER.open, { url: "http://172.17.0.1/" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).message).toMatch(/ERR_/);
    }, 120_000);
  },
);
