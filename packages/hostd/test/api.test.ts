import { existsSync } from "node:fs";
import { HOST_ERROR_CODE, type HostServiceList } from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import { HostdClient, HostdRunningError, readRunFile, runFilePath } from "../src/index.js";
import { writeRunFile } from "../src/run-file.js";
import { cleanup, daemonFor, fake, until, workspace } from "./fakes.js";

afterEach(cleanup);

const T = { timeout: 40_000 };

async function rpc(port: number, token: string | null, method: string, params: unknown = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function runningPort(client: HostdClient, name: string): Promise<number> {
  return until(async () => {
    const { services } = await client.call<HostServiceList>("service.list");
    const s = services.find((x) => x.name === name);
    return s?.state === "running" ? s.port : undefined;
  });
}

describe("local API", () => {
  it(
    "answers the operator through the run file and refuses missing or wrong tokens",
    T,
    async () => {
      const ws = workspace([fake("a", "health.cjs")]);
      const daemon = daemonFor(ws);
      await daemon.start();
      const info = readRunFile(runFilePath(ws.state));
      expect(info).toMatchObject({
        pid: process.pid,
        port: daemon.port,
        version: "test",
        workspace: ws.root,
      });

      const client = await HostdClient.connect(ws.state);
      expect(client).not.toBeNull();
      const { services } = await (client as HostdClient).call<HostServiceList>("service.list");
      expect(services.map((s) => s.name)).toEqual(["a"]);

      const none = await rpc(daemon.port, null, "service.list");
      expect(none.status).toBe(401);
      expect(none.body.error).toMatchObject({ code: HOST_ERROR_CODE.NotAllowed });
      const wrong = await rpc(daemon.port, "nope", "service.list");
      expect(wrong.status).toBe(401);
      const logs = await fetch(`http://127.0.0.1:${daemon.port}/logs/a`);
      expect(logs.status).toBe(401);

      const ok = await rpc(daemon.port, daemon.token, "service.list");
      expect(ok.body).toMatchObject({ jsonrpc: "2.0", id: 7 });
      const notFound = await rpc(daemon.port, daemon.token, "gpu.acquire");
      expect(notFound.body.error).toMatchObject({ code: -32601 });
      const parse = await fetch(`http://127.0.0.1:${daemon.port}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.token}` },
        body: "{",
      });
      expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
    },
  );

  it(
    "gives a service its token and the API address, and lets the token call nothing yet",
    T,
    async () => {
      const ws = workspace([
        fake("svc", "health.cjs", {
          env: { FROM_DESC: "d", OVERRIDDEN: "d" },
          host: 'env = { OVERRIDDEN = "h" }',
          run: 'pass_env = ["PASS_*"]',
        }),
      ]);
      const daemon = daemonFor(ws, {
        env: { ...process.env, PASS_ME: "yes", OPENAI_API_KEY: "secret" },
      });
      await daemon.start();
      const client = (await HostdClient.connect(ws.state)) as HostdClient;
      await client.call("service.start", { service: "svc" });
      const port = await runningPort(client, "svc");
      const env = (await (await fetch(`http://127.0.0.1:${port}/env`)).json()) as Record<
        string,
        string
      >;
      expect(env.PASS_ME).toBe("yes");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.FROM_DESC).toBe("d");
      expect(env.OVERRIDDEN).toBe("h");
      expect(env.PORT).toBe(String(port));
      expect(env.HOST).toBe("127.0.0.1");
      expect(env.MIYORIA_HOSTD_URL).toBe(`http://127.0.0.1:${daemon.port}`);
      const token = env.MIYORIA_SERVICE_TOKEN as string;
      expect(token.length).toBeGreaterThan(20);

      const asService = await rpc(daemon.port, token, "service.list");
      expect(asService.status).toBe(200);
      expect(asService.body.error).toMatchObject({ code: HOST_ERROR_CODE.NotAllowed });
      expect((await rpc(daemon.port, token, "host.shutdown")).body.error).toMatchObject({
        code: HOST_ERROR_CODE.NotAllowed,
      });
      expect(
        (
          await fetch(`http://127.0.0.1:${daemon.port}/logs/svc`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(403);

      // A new start gets a new token; the old one stops working.
      await client.call("service.restart", { service: "svc" });
      await runningPort(client, "svc");
      expect((await rpc(daemon.port, token, "service.list")).status).toBe(401);
    },
  );

  it("expands {miyoria} into the CLI's own arguments", T, async () => {
    const ws = workspace([
      fake("self", "health.cjs", { command: ["{miyoria}", "{service}/health.cjs"] }),
    ]);
    const daemon = daemonFor(ws, { miyoria: [process.execPath, "--no-deprecation"] });
    await daemon.start();
    const client = (await HostdClient.connect(ws.state)) as HostdClient;
    await client.call("service.start", { service: "self" });
    const port = await runningPort(client, "self");
    const argv = (await (await fetch(`http://127.0.0.1:${port}/argv`)).json()) as {
      execArgv: string[];
      argv: string[];
    };
    expect(argv.execArgv).toEqual(["--no-deprecation"]);
    expect(argv.argv[1]?.endsWith("health.cjs")).toBe(true);
  });

  it("streams the tail and then new lines of a log", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const daemon = daemonFor(ws);
    await daemon.start();
    const client = (await HostdClient.connect(ws.state)) as HostdClient;
    await client.call("service.start", { service: "a" });
    await runningPort(client, "a");
    const tail: string[] = [];
    for await (const line of client.logs("a", { lines: 5 })) tail.push(line);
    expect(tail.some((l) => l.includes("a listening on"))).toBe(true);

    const controller = new AbortController();
    const seen: string[] = [];
    const following = (async () => {
      for await (const line of client.logs("a", {
        lines: 0,
        follow: true,
        signal: controller.signal,
      })) {
        seen.push(line);
        if (line.includes("hostd 啟動 a")) controller.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    await client.call("service.restart", { service: "a" });
    await following;
    expect(seen.some((l) => l.includes("hostd 啟動 a"))).toBe(true);
    await expect(async () => {
      for await (const _ of client.logs("nope")) {
        // nothing
      }
    }).rejects.toMatchObject({ code: HOST_ERROR_CODE.UnknownService });
  });
});

describe("run file", () => {
  it("refuses a second daemon for the same workspace and removes the file on stop", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const first = daemonFor(ws);
    await first.start();
    const second = daemonFor(ws);
    await expect(second.start()).rejects.toBeInstanceOf(HostdRunningError);
    expect(readRunFile(runFilePath(ws.state))?.token).toBe(first.token);
    await first.stop();
    expect(existsSync(runFilePath(ws.state))).toBe(false);
  });

  it("replaces a stale file: a dead pid, or a live one that does not answer", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const file = runFilePath(ws.state);
    const stale = {
      port: 1,
      token: "old",
      started_at: "2026-01-01T00:00:00Z",
      version: "x",
      workspace: ws.root,
    };
    writeRunFile(file, { ...stale, pid: 2 ** 22 + 7 });
    const one = daemonFor(ws);
    await one.start();
    expect(readRunFile(file)?.token).toBe(one.token);
    await one.stop();

    writeRunFile(file, { ...stale, pid: process.pid });
    const two = daemonFor(ws);
    await two.start();
    expect(readRunFile(file)?.token).toBe(two.token);
  });
});
