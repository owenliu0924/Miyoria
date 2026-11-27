// The sandbox service against a real Docker, as an attacker with code execution inside a job would
// see it (docs/design/v6-sandbox.md §14 "真的 Docker"). Skipped when Docker does not answer (or with
// MIYORIA_SKIP_DOCKER_TESTS=1); CI's Linux runs it. Jobs run in `python:3.12-slim`, their proxies
// in `node:24-slim` (no 2 GB build); with MIYORIA_SANDBOX_IMAGE_TESTS=1 both are the built
// `miyoria/sandbox` image. Nothing here sends a packet to the internet: every target is refused
// before a connection is made, or has no route at all. MIYORIA_SANDBOX_PUBLIC_NET=1 adds the one
// check that does (a public site is reachable through the proxy).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessDockerRunner } from "../../src/runner.js";
import { imageHash, imageTag } from "../../src/service/images.js";
import { type RunningSandboxService, startSandboxService } from "../../src/service/index.js";
import { type Json, jobBody, nextId, sha, tarOf, tempDir } from "./helpers.js";

function dockerAvailable(): boolean {
  if (process.env.MIYORIA_SKIP_DOCKER_TESTS === "1") return false;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

function docker(...args: string[]): string {
  const run = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 900_000 });
  return run.status === 0 ? run.stdout.trim() : "";
}

const TOKEN = "integration-token";
const SECRET = "s3cret-the-host-keeps-to-itself";
const ownV4 =
  Object.values(networkInterfaces())
    .flat()
    .find((n) => n !== undefined && n.family === "IPv4" && !n.internal)?.address ?? null;

describe.skipIf(!dockerAvailable())("sandbox service (live Docker)", () => {
  let root: string;
  let service: RunningSandboxService;
  let jobImage = "python:3.12-slim";
  let proxyImage = "node:24-slim";
  const opened: string[] = [];

  const start = () =>
    startSandboxService({
      host: "127.0.0.1",
      port: 0,
      hostToml: join(root, "host.toml"),
      state: join(root, "state"),
      imageDir: join(root, "image"),
      token: TOKEN,
      hostToken: null,
      runner: new ProcessDockerRunner("docker", { ...process.env, LLM_API_KEY: SECRET }),
      images: { default: jobImage, proxy: proxyImage },
      checkEveryMs: 3_600_000,
    });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } };
    if (body !== undefined) init.body = Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const res = await fetch(`${service.url}${path}`, init);
    const bytes = Buffer.from(await res.arrayBuffer());
    let json: Json = null;
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      // Raw bytes.
    }
    return { status: res.status, json, bytes };
  };

  const open = async (over: Parameters<typeof jobBody>[0] = {}) => {
    const id = nextId();
    const res = await call(
      "PUT",
      `/v1/jobs/${id}`,
      jobBody({ limits: { ...jobBody().limits, cpus: 1, memory_mb: 512 }, ...over }),
    );
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    opened.push(id);
    return id;
  };

  /** Runs a Python program in `job` and returns its result. */
  const python = async (job: string, code: string, timeout = 60_000) => {
    const exec = nextId();
    const started = await call("PUT", `/v1/jobs/${job}/execs/${exec}`, {
      program: { language: "python", code },
      timeout_ms: timeout,
      output: { keep_bytes: 262_144, kill_bytes: 8_388_608, stream_bytes: 65_536 },
      collect: null,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    for (;;) {
      const view = (await call("GET", `/v1/jobs/${job}/execs/${exec}`)).json;
      if (view.state !== "running") return view.result;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    root = tempDir("sbx-live-");
    writeFileSync(join(root, "host.toml"), "");
    mkdirSync(join(root, "image"));
    if (process.env.MIYORIA_SANDBOX_IMAGE_TESTS === "1") {
      const dir = join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "workers",
        "sandbox",
        "image",
      );
      const tag = imageTag("default", (await imageHash(dir, ["browser"])) as string);
      jobImage = tag;
      proxyImage = tag;
    }
    for (const image of new Set([jobImage, proxyImage])) {
      if (docker("image", "inspect", "--format", "{{.Id}}", image) === "") docker("pull", image);
    }
    service = await start();
    await service.refresh();
    const health = (await call("GET", "/health")).json;
    expect(health.ready, JSON.stringify(health)).toBe(true);
  }, 900_000);

  afterAll(async () => {
    for (const id of opened) await call("DELETE", `/v1/jobs/${id}`).catch(() => undefined);
    await service?.close();
    // Only this test's jobs: their ids are the ones opened here.
    for (const id of opened) {
      docker("rm", "-f", `miyoria-sbx-${id}`, `miyoria-sbx-egress-${id}`);
      docker("network", "rm", `miyoria-sbx-net-${id}`);
    }
    if (root) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it("runs as nobody with no capabilities, no host environment and no host files", async () => {
    const job = await open({
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    const result = await python(
      job,
      `
import json, os
report = {"uid": os.getuid()}
status = open("/proc/self/status").read()
report["capeff"] = [l.split()[1] for l in status.splitlines() if l.startswith("CapEff:")][0]
report["nonewprivs"] = [l.split()[1] for l in status.splitlines() if l.startswith("NoNewPrivs:")][0]
report["secret"] = any("${SECRET}" in v for v in os.environ.values())
report["sock"] = os.path.exists("/var/run/docker.sock") or os.path.exists("/run/docker.sock")
report["mounts"] = [l.split()[1] for l in open("/proc/mounts") if l.split()[1].startswith(("/work", "/home", "/code", "/tools", "/ext"))]
try:
    open("/etc/evil", "w"); report["rootfs"] = "writable"
except OSError: report["rootfs"] = "read-only"
print(json.dumps(report))
`,
    );
    const report = JSON.parse(result.stdout.trim());
    expect(report.uid).not.toBe(0);
    expect(report.capeff).toBe("0000000000000000");
    expect(report.nonewprivs).toBe("1");
    expect(report.secret).toBe(false);
    expect(report.sock).toBe(false);
    expect(report.rootfs).toBe("read-only");
    expect(report.mounts.sort()).toEqual(["/code", "/home/sandbox", "/work", "/workspace"]);
  }, 180_000);

  it("measures CPU and kills everything an exec left running", async () => {
    const job = await open({
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    const busy = await python(
      job,
      `
import os, subprocess, time
subprocess.Popen(["sleep", "600"], start_new_session=True)
if os.fork() == 0:
    os.setsid()
    time.sleep(600)
end = time.time() + 1.5
while time.time() < end: pass
print("spun")
`,
    );
    expect(busy.stdout.trim()).toBe("spun");
    expect(busy.cpu_ms).toBeGreaterThan(500);
    const check = await python(
      job,
      `
import os
me, mine = os.getuid(), []
for pid in os.listdir("/proc"):
    if not pid.isdigit() or int(pid) == os.getpid(): continue
    try:
        uid = int([l.split()[1] for l in open(f"/proc/{pid}/status") if l.startswith("Uid:")][0])
    except OSError: continue
    if uid == me: mine.append(pid)
print(len(mine))
`,
    );
    expect(check.stdout.trim()).toBe("0");
  }, 180_000);

  it("refuses every private, tailnet, metadata, gateway and mail target through the proxy", async () => {
    const job = await open();
    const gateway = docker(
      "network",
      "inspect",
      "bridge",
      "--format",
      "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
    );
    const targets = [
      "172.17.0.1:2375",
      `${gateway || "172.17.0.1"}:22`,
      "169.254.169.254:80",
      "100.100.100.200:80",
      "100.64.0.1:22",
      "100.101.102.103:41641",
      "10.0.0.1:80",
      "192.168.1.1:80",
      "192.168.65.254:80",
      "127.0.0.1:3128",
      "egress-proxy:3128",
      "localhost:80",
      "host.docker.internal:80",
      "gateway.docker.internal:80",
      "metadata.google.internal:80",
      "metadata:80",
      "router:80",
      "[::1]:80",
      "[::ffff:169.254.169.254]:80",
      "[64:ff9b::a9fe:a9fe]:80",
      "[2002:a9fe:a9fe::1]:80",
      "[fd7a:115c:a1e0::1]:443",
      "[fe80::1]:80",
      "1.1.1.1:25",
      "1.1.1.1:465",
      "1.1.1.1:587",
      ...(ownV4 !== null ? [`${ownV4}:22`] : []),
    ];
    const result = await python(
      job,
      `
import json, socket
out = {}
for target in ${JSON.stringify(targets)}:
    s = socket.create_connection(("egress-proxy", 3128), timeout=20)
    s.sendall(f"CONNECT {target} HTTP/1.1\\r\\nHost: {target}\\r\\n\\r\\n".encode())
    out[target] = s.recv(200).decode(errors="replace").split("\\r\\n")[0]
    s.close()
import urllib.request
for url in ["http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/", "http://0x7f.1:3128/", "http://2130706433/"]:
    try:
        urllib.request.urlopen(url, timeout=20)
        out[url] = "200"
    except urllib.error.HTTPError as e:
        out[url] = str(e.code)
    except Exception as e:
        out[url] = type(e).__name__
print(json.dumps(out))
`,
      180_000,
    );
    const out = JSON.parse(result.stdout.trim()) as Record<string, string>;
    for (const target of targets) expect(out[target], target).toBe("HTTP/1.1 403 Forbidden");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00:ec2::254]/",
      "http://0x7f.1:3128/",
      "http://2130706433/",
    ]) {
      expect(out[url], url).toBe("403");
    }
  }, 300_000);

  it("has no way out but the proxy", async () => {
    const job = await open();
    const result = await python(
      job,
      `
import json, socket
out = {}
for host, port in [("1.1.1.1", 80), ("8.8.8.8", 53), ("172.17.0.1", 2375), ("169.254.169.254", 80)]:
    try:
        socket.create_connection((host, port), timeout=5).close()
        out[f"{host}:{port}"] = "connected"
    except OSError as e:
        out[f"{host}:{port}"] = "refused"
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
try:
    s.sendto(b"x", ("8.8.8.8", 53)); s.recvfrom(10); out["udp"] = "answered"
except OSError:
    out["udp"] = "no answer"
print(json.dumps(out))
`,
    );
    const out = JSON.parse(result.stdout.trim()) as Record<string, string>;
    for (const [target, what] of Object.entries(out)) {
      expect(what, target).not.toBe("connected");
      expect(what, target).not.toBe("answered");
    }
  }, 180_000);

  it("never lets a link in the workspace carry a host file out, or a tar write through one", async () => {
    const job = await open({
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    const hostDir = join(root, "host-secrets");
    mkdirSync(hostDir);
    const hostFile = join(hostDir, "key.txt");
    writeFileSync(hostFile, SECRET);
    // The links point at host paths: meaningless in the container, real on the host.
    const made = await python(
      job,
      `
import os
os.symlink(${JSON.stringify(hostFile)}, "/workspace/steal-file")
os.symlink(${JSON.stringify(hostDir)}, "/workspace/steal-dir")
os.symlink("/etc", "/workspace/etc-link")
open("/workspace/fine.txt", "w").write("fine")
print("ok")
`,
    );
    expect(made.stdout.trim()).toBe("ok");
    const sync = nextId();
    const res = await call("PUT", `/v1/jobs/${job}/syncs/${sync}`, { target: "workspace" });
    expect(res.status).toBe(200);
    expect(res.json.changed.map((e: Json) => e.path)).toEqual(["fine.txt"]);
    const skipped = Object.fromEntries(res.json.skipped.map((s: Json) => [s.path, s.why]));
    expect(skipped["steal-file"]).toBe("link");
    expect(skipped["steal-dir"]).toBe("link");
    const tar = await call("GET", `/v1/jobs/${job}/syncs/${sync}/tar`);
    expect(tar.bytes.toString("latin1")).not.toContain(SECRET);
    // A tar that writes through the directory link stays out of the host's folder.
    const data = await tarOf([
      { name: "steal-dir/planted.txt", content: "x" },
      { name: "../../planted.txt", content: "x" },
    ]);
    const upload = nextId();
    await call("PUT", `/v1/jobs/${job}/uploads/${upload}/parts/0`, data, { "x-sha256": sha(data) });
    const committed = await call("PUT", `/v1/jobs/${job}/uploads/${upload}`, {
      parts: 1,
      bytes: data.length,
      sha256: sha(data),
      format: "tar",
      target: "workspace",
      replace: false,
      manifest: [],
    });
    expect(committed.status).toBe(200);
    expect(committed.json.files).toBe(0);
    expect(readFileSync(hostFile, "utf8")).toBe(SECRET);
    expect(() => readFileSync(join(hostDir, "planted.txt"))).toThrow();
  }, 180_000);

  it("talks to a proc over its channel", async () => {
    const job = await open({
      kind: "plugin",
      for: "owner",
      lifetime_s: 0,
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    const proc = nextId();
    const started = await call("PUT", `/v1/jobs/${job}/procs/${proc}`, {
      argv: [
        "python3",
        "-u",
        "-c",
        "import sys\nfor l in sys.stdin: print(l.strip().upper(), flush=True)",
      ],
    });
    expect(started.status).toBe(201);
    await call("PUT", `/v1/jobs/${job}/procs/${proc}/stdin?offset=0`, Buffer.from("hello\n"));
    let text = "";
    for (let i = 0; i < 100 && !text.includes("HELLO"); i++) {
      text = (await call("GET", `/v1/jobs/${job}/procs/${proc}/stdout?after=0`)).bytes.toString();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(text).toContain("HELLO");
    await call("DELETE", `/v1/jobs/${job}/procs/${proc}`);
  }, 180_000);

  it("takes a job back after the service restarts, and ends one whose lease ran out", async () => {
    const kept = await open({
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    const short = await open({
      lease_s: 10,
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    await service.close();
    service = await start();
    await service.refresh();
    expect((await call("GET", `/v1/jobs/${kept}`)).status).toBe(200);
    expect((await python(kept, "print(6 * 7)")).stdout.trim()).toBe("42");
    await new Promise((r) => setTimeout(r, 11_000));
    await service.sweep();
    expect((await call("GET", `/v1/jobs/${short}`)).status).toBe(410);
    expect(docker("ps", "-aq", "--filter", `label=miyoria.sandbox.job=${short}`)).toBe("");
  }, 180_000);

  it.skipIf(process.env.MIYORIA_SANDBOX_PUBLIC_NET !== "1")(
    "reaches a public site through the proxy",
    async () => {
      const job = await open();
      const result = await python(
        job,
        `
import urllib.request
print(urllib.request.urlopen("https://example.com/", timeout=30).status)
`,
      );
      expect(result.stdout.trim()).toBe("200");
    },
    180_000,
  );
});
