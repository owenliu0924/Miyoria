// The browser tools end to end: Core's `HttpSandboxClient` against the real sandbox service on a
// real Docker, a `browser` job with the driver as its proc, the tools through the gate. The pages
// come from a web server run as a second proc in the same job (nothing leaves the machine), and
// one page of a server on this machine shows that the job cannot reach it: the job's only way out
// is its egress proxy, which refuses private addresses (172.17.0.1 is Docker's bridge).
//
// What it needs from work package P2, and skips without:
// - `startSandboxService` (packages/workspace/sandbox/src/service/index.ts), with the `procs`
//   channel (`PUT /v1/jobs/{job}/procs/{proc}`, stdin, `proc_out` events) and `browser` jobs
//   (the image role, /dev/shm), and syncs of `/workspace` from a browser job.
// - Docker answering; both images built on this machine (`miyoria sandbox build`), and
//   `MIYORIA_SANDBOX_IMAGE_TESTS=1`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKSPACE_ALL } from "@miyoria/gate/actions";
import type { Endpoint, EndpointSource } from "@miyoria/runtime/kernel";
import { newId, Principals } from "@miyoria/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browse, BrowseConfigSchema, browseCapabilities } from "../../src/browse/index.js";
import { SandboxConfigSchema } from "../../src/config.js";
import { NODE_CODE_RUN } from "../../src/nodes.js";
import { DEFAULT_PERSON_LIMITS } from "../../src/people.js";
import { HttpSandboxClient } from "../../src/remote/client.js";
import { MemorySandboxJobs } from "../../src/remote/jobs-store.js";
import { CountedWorkspace } from "../../src/workspace-totals.js";
import { CTX, harness, OWNER, toolContext } from "../gate-helpers.js";
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

type Running = { url: string; close(): Promise<void>; refresh(): Promise<void> };
type Start = (options: Record<string, unknown>) => Promise<Running>;
const service = (await import("../../src/service/index.js").catch(() => ({}))) as {
  startSandboxService?: Start;
};
const start = service.startSandboxService;
const enabled =
  typeof start === "function" &&
  process.env.MIYORIA_SANDBOX_IMAGE_TESTS === "1" &&
  dockerAvailable();

function loopback(url: string, token: string): EndpointSource {
  const endpoint: Endpoint = {
    capability: "sandbox",
    host: "this-pc",
    service: "sandbox",
    url,
    via: "direct",
    headers: { authorization: `Bearer ${token}` },
    healthy: true,
    version: null,
  };
  return {
    pick: () => endpoint,
    candidates: () => [endpoint],
    failed: () => {},
    request: (e, path, init = {}) =>
      fetch(new URL(path, e.url), {
        ...init,
        headers: { ...e.headers, ...Object.fromEntries(new Headers(init.headers)) },
      }),
    watch: () => () => {},
  };
}

const SECRET = "the-host-page-the-job-must-not-see";

describe.skipIf(!enabled)(
  "browse_* on the real sandbox service (needs P2's service and procs)",
  () => {
    let root: string;
    let running: Running;
    let client: HttpSandboxClient;
    let browse: Browse;
    let workspace: CountedWorkspace;
    let hostServer: Server;
    let hostPort = 0;
    const h = harness();
    h.grants.grant(OWNER, NODE_CODE_RUN);
    // An owner reaches the whole workspace: the job is the owner's, which every computer takes.
    h.grants.grant(OWNER, WORKSPACE_ALL);
    const owner = toolContext(Principals.user(OWNER, CTX));
    const run = (name: string, args: object) => h.tools.run(name, owner, args as never);

    beforeAll(async () => {
      root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-browse-e2e-"));
      const hostToml = join(root, "host.toml");
      writeFileSync(hostToml, "[sandbox]\n");
      const token = "browse-e2e-token";
      running = await (start as Start)({
        host: "127.0.0.1",
        port: 0,
        hostToml,
        state: join(root, "state"),
        imageDir: resolve(import.meta.dirname, "../../../../../workers/sandbox/image"),
        token,
        hostToken: null,
      });
      // Docker, the images and the jobs of an earlier run are looked at before the first question.
      await running.refresh();
      const config = SandboxConfigSchema.parse({});
      client = new HttpSandboxClient({
        endpoints: loopback(running.url, token),
        config,
        jobs: new MemorySandboxJobs(),
      });
      await client.refresh({ force: true });
      workspace = new CountedWorkspace(join(root, "workspace"), {
        maxBytes: 64 * 1024 * 1024,
        maxFiles: 500,
        maxFileBytes: 16 * 1024 * 1024,
      });
      browse = browseCapabilities({
        client,
        quota: null,
        workspace,
        people: DEFAULT_PERSON_LIMITS,
        config: BrowseConfigSchema.parse({}),
        resultChars: 3900,
      });
      for (const capability of browse.capabilities) h.registry.register(capability);
      hostServer = createServer((_req, res) => res.end(SECRET));
      await new Promise<void>((r) => hostServer.listen(0, "0.0.0.0", r));
      const address = hostServer.address();
      hostPort = typeof address === "object" && address !== null ? address.port : 0;
    }, 180_000);

    afterAll(async () => {
      await browse?.close();
      client?.close();
      await running?.close();
      hostServer?.close();
      rmSync(root, { recursive: true, force: true });
    });

    it("opens, clicks, reads, looks and brings a download back", async () => {
      expect(browse.availability()).toEqual({ ok: true });
      const first = await run("browse_open", { url: "data:text/html;charset=utf-8,<h1>開始</h1>" });
      expect(first.ok, first.text).toBe(true);
      expect(first.text).toContain("# 開始");

      // The test's pages, from a second proc of the same job.
      const session = browse.sessions.get("all", "main");
      if (session === null) throw new Error("no session");
      await session.job.proc(newId().toLowerCase(), { argv: ["node", "-e", TEST_SERVER] });
      await new Promise((r) => setTimeout(r, 1500));

      const home = await run("browse_open", { url: "http://127.0.0.1:8080/" });
      expect(home.text, JSON.stringify(home)).toContain("測試首頁");
      const link = /\[(e\d+)\] 連結 去第二頁/.exec(home.text)?.[1];
      const file = /\[(e\d+)\] 連結 下載報告/.exec(home.text)?.[1];
      expect(link && file).toBeTruthy();

      const two = await run("browse_act", { action: "click", ref: link });
      expect(two.text, JSON.stringify(two)).toContain("頁面換了");
      expect((await run("browse_read", {})).text).toContain("這裡是第二頁的內容");

      const shot = await run("browse_shot", {});
      expect(shot.ok && shot.images?.[0]?.image_url.url.startsWith("data:image/png;base64,")).toBe(
        true,
      );

      await run("browse_act", { action: "back" });
      const saved = await run("browse_act", { action: "click", ref: file });
      expect(saved.text, JSON.stringify(saved)).toContain("downloads/report.txt");
      expect((await workspace.read("downloads/report.txt")).text).toBe("downloaded bytes\n");
    }, 300_000);

    it("cannot reach a server on this machine", async () => {
      const out = await run("browse_open", { url: `http://172.17.0.1:${hostPort}/` });
      expect(out.text).not.toContain(SECRET);
    }, 120_000);

    it("closes the job with the session", async () => {
      const session = browse.sessions.get("all", "main");
      const out = await run("browse_act", { action: "close" });
      expect(out.text, JSON.stringify(out)).toContain("關掉了");
      expect((await session?.job.ended)?.reason).toBeDefined();
      expect(browse.sessions.size).toBe(0);
    }, 120_000);
  },
);
