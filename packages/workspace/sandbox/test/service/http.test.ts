// The sandbox service over real HTTP on loopback, with a scripted Docker underneath
// (docs/design/v6-sandbox.md §14 "HTTP" and the unit cases that need the whole service).

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIB } from "../../src/service/util.js";
import { FakeDocker, result } from "./fake-docker.js";
import {
  execBody,
  type Harness,
  harness,
  type Json,
  jobBody,
  nextId,
  sha,
  tarOf,
  until,
  upload,
} from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function open(over: Parameters<typeof jobBody>[0] = {}): Promise<string> {
  const id = nextId();
  const res = await (h as Harness).call("PUT", `/v1/jobs/${id}`, jobBody(over));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return id;
}

async function finished(job: string, exec: string) {
  let view: Json = null;
  await until(async () => {
    view = (await (h as Harness).call("GET", `/v1/jobs/${job}/execs/${exec}`)).json;
    return view?.state !== "running";
  });
  return view;
}

describe("sandbox service: auth and health", () => {
  it("answers 401 without the token, even on /health and unknown paths", async () => {
    h = await harness();
    for (const path of ["/health", "/v1/info", "/v1/jobs", "/nope"]) {
      const res = await fetch(`${h.service.url}${path}`);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: "unauthorized", message: "unauthorized" },
      });
      const wrong = await fetch(`${h.service.url}${path}`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(wrong.status).toBe(401);
    }
  });

  it("is ready with Docker and the image, and says why not otherwise, always with 200", async () => {
    h = await harness();
    const ok = await h.call("GET", "/health");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ status: "ok", running: 0, busy: false, queued: 0, ready: true });
    h.docker.up = false;
    await h.service.refresh();
    const down = await h.call("GET", "/health");
    expect(down.status).toBe(200);
    expect(down.json.ready).toBe(false);
    expect(down.json.reason).toContain("Docker 沒有回應");
    h.docker.up = true;
    h.docker.images.clear();
    await h.service.refresh();
    expect((await h.call("GET", "/health")).json.reason).toContain("miyoria sandbox build");
    writeFileSync(h.hostToml, "BROKEN");
    await h.service.refresh();
    expect((await h.call("GET", "/health")).json.reason).toContain("host.toml");
  });

  it("answers a caller of the first moment once its first look at Docker is done", async () => {
    const docker = new FakeDocker();
    const exec = docker.exec.bind(docker);
    // A slow Docker: the first `docker version` takes a while, as on a loaded machine.
    docker.exec = async (args, options) => {
      if (args[0] === "version") await new Promise((r) => setTimeout(r, 400));
      return exec(args, options);
    };
    h = await harness({ docker, refresh: false });
    const info = (await h.call("GET", "/v1/info")).json;
    expect(info.ready, JSON.stringify(info)).toBe(true);
    expect((await h.call("GET", "/health")).json.ready).toBe(true);
  });

  it("reports the owner's rules and the reservations in /v1/info", async () => {
    h = await harness({
      hostToml: "members = true\ncpus = 4\nmemory_mb = 8192\nmax_job_cpus = 1\n",
    });
    const id = await open();
    const info = (await h.call("GET", "/v1/info")).json;
    expect(info.api).toBe(1);
    expect(info.policy).toMatchObject({ members: true, plugins: false, cpus: 4, max_job_cpus: 1 });
    expect(info.load).toMatchObject({ jobs: 1, cpus: 1 });
    const job = (await h.call("GET", `/v1/jobs/${id}`)).json;
    // Asked for 2 CPUs; this machine gives one job 1.
    expect(job.limits.cpus).toBe(1);
  });
});

describe("sandbox service: opening a job", () => {
  it("starts a hardened container on its own internal network with its own proxy", async () => {
    h = await harness();
    const id = await open();
    const run = h.docker.jobRun() as string[];
    const at = (flag: string) => run[run.indexOf(flag) + 1];
    expect(at("--cap-drop")).toBe("ALL");
    expect(at("--security-opt")).toBe("no-new-privileges");
    expect(at("--user")).toBe("65534:65534"); // the keeper, not the programs' uid 1000
    expect(at("--cgroupns")).toBe("private");
    expect(at("--network")).toBe(`miyoria-sbx-net-${id}`);
    expect(at("--pids-limit")).toBe("512");
    expect(at("--memory")).toBe("2048m");
    expect(at("--memory-swap")).toBe("2048m");
    expect(at("--cpus")).toBe("2");
    expect(at("--workdir")).toBe("/workspace");
    expect(run).toContain("--read-only");
    expect(run).not.toContain("--privileged");
    // Only the job's own folders are mounted; never the Docker socket or anything of the host.
    const mounts = run.filter((_, i) => run[i - 1] === "--mount");
    const jobRoot = join(h.root, "state", "jobs", id);
    for (const mount of mounts) {
      if (mount.startsWith("type=tmpfs")) continue;
      const source = /source=([^,]+)/.exec(mount)?.[1] ?? "";
      expect(source.startsWith(jobRoot), mount).toBe(true);
    }
    expect(run.join(" ")).not.toMatch(/docker\.sock|\/var\/run|-v /);
    // No variable of this process: only the fixed ones, the proxy, and the request's.
    const env = run.filter((_, i) => run[i - 1] === "--env").map((e) => e.split("=")[0]);
    expect(env.sort()).toEqual(
      [
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "NO_PROXY",
        "NPM_CONFIG_PREFIX",
        "PATH",
        "PIP_USER",
        "TMPDIR",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ].sort(),
    );
    const proxy = h.docker
      .calledWith("run")
      .find((c) => c.some((a) => a.startsWith("EGRESS_MODE="))) as string[];
    expect(proxy).toContain("EGRESS_MODE=open");
    expect(proxy).toContain("EGRESS_DENY_PORTS=25,465,587,2525");
    expect(proxy).toContain("EGRESS_DENY_ADDRS=203.0.113.50,2a01:4f8:1:2::/64");
    const create = h.docker.calledWith("network", "create")[0] as string[];
    expect(create).toContain("--internal");
    // The host keeps no address on the job's network, so the job cannot reach its listeners.
    expect(create).toContain("com.docker.network.bridge.gateway_mode_ipv4=isolated");
    expect(create).toContain("com.docker.network.bridge.gateway_mode_ipv6=isolated");
  });

  it("is not ready on a Docker too old to keep a job network off this machine", async () => {
    h = await harness();
    h.docker.version = "27.5.1";
    await h.service.refresh();
    const health = (await h.call("GET", "/health")).json;
    expect(health.ready).toBe(false);
    expect(health.reason).toContain("27.5.1");
    const refused = await h.call("PUT", `/v1/jobs/${nextId()}`, jobBody());
    expect(refused.status, JSON.stringify(refused.json)).toBe(503);
    expect(h.docker.calledWith("network", "create")).toHaveLength(0);
  });

  it("refuses a job whose network Docker made with the host's gateway on it", async () => {
    h = await harness();
    const docker = h.docker;
    const exec = docker.exec.bind(docker);
    // An engine that drops the option it does not know.
    docker.exec = (args, options) =>
      exec(
        args[0] === "network" && args[1] === "create"
          ? args.filter((a, i) => a !== "--opt" && args[i - 1] !== "--opt")
          : args,
        options,
      );
    const refused = await h.call("PUT", `/v1/jobs/${nextId()}`, jobBody());
    expect(refused.status).toBe(502);
    expect(refused.json.error.message).toContain('not "isolated"');
    expect(docker.networks.size).toBe(0);
  });

  it("gives a job without network no network and no proxy", async () => {
    h = await harness();
    await open({
      network: { mode: "none", allow: [], deny_ports: [], max_connections: 1, max_mb: 0 },
    });
    const run = h.docker.jobRun() as string[];
    expect(run[run.indexOf("--network") + 1]).toBe("none");
    expect(h.docker.calledWith("network", "create")).toHaveLength(0);
    expect(
      run.filter((_, i) => run[i - 1] === "--env").some((e) => e.startsWith("HTTP_PROXY")),
    ).toBe(false);
  });

  it("answers the same request with the same job and another one with 409", async () => {
    h = await harness();
    const id = nextId();
    expect((await h.call("PUT", `/v1/jobs/${id}`, jobBody())).status).toBe(201);
    const again = await h.call("PUT", `/v1/jobs/${id}`, jobBody());
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(id);
    expect(
      h.docker.calledWith("run").filter((c) => !c.some((a) => a.startsWith("EGRESS_MODE="))).length,
    ).toBe(1);
    const other = await h.call("PUT", `/v1/jobs/${id}`, jobBody({ label: "x" }));
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("conflict");
  });

  it("refuses members and plugins unless the owner allows them", async () => {
    h = await harness();
    const member = await h.call(
      "PUT",
      `/v1/jobs/${nextId()}`,
      jobBody({ for: "member", payer: "0123456789abcdef" }),
    );
    expect(member.status).toBe(403);
    expect(member.json.error.code).toBe("not_accepting");
    const plugin = await h.call(
      "PUT",
      `/v1/jobs/${nextId()}`,
      jobBody({ kind: "plugin", for: "plugin" }),
    );
    expect(plugin.status).toBe(403);
  });

  it("is busy when the machine's places, CPUs or one person's share are used up", async () => {
    h = await harness({ hostToml: "members = true\ncpus = 3\nmemory_mb = 16384\n" });
    await open();
    const cpu = await h.call("PUT", `/v1/jobs/${nextId()}`, jobBody());
    expect(cpu.status).toBe(429);
    expect(cpu.json.error.code).toBe("busy");
    expect(cpu.json.error.retry_after_ms).toBeGreaterThan(0);
    await h.close();
    h = await harness({ hostToml: "members = true\ncpus = 16\nmemory_mb = 65536\n" });
    const small = { limits: { ...jobBody().limits, cpus: 0.5, memory_mb: 256, disk_mb: 64 } };
    const payer = "fedcba9876543210";
    await open({ ...small, for: "member", payer });
    await open({ ...small, for: "member", payer });
    const third = await h.call(
      "PUT",
      `/v1/jobs/${nextId()}`,
      jobBody({ ...small, for: "member", payer }),
    );
    expect(third.status).toBe(429);
    await open(small);
    await open(small);
    expect((await h.call("PUT", `/v1/jobs/${nextId()}`, jobBody(small))).status).toBe(429);
  });

  it("checks what the wire shapes do not: env names, payer, sizes", async () => {
    h = await harness();
    for (const bad of [
      jobBody({ env: { lower: "x" } }),
      jobBody({ env: { PATH: "/evil" } }),
      jobBody({ env: { HTTP_PROXY: "http://elsewhere" } }),
      jobBody({ payer: "not-hex" }),
      jobBody({ lease_s: 1 }),
      jobBody({ limits: { ...jobBody().limits, pids: 1 } }),
      jobBody({
        network: { mode: "allowlist", allow: [], deny_ports: [], max_connections: 1, max_mb: 1 },
      }),
      jobBody({
        network: {
          mode: "allowlist",
          allow: ["http://x.com"],
          deny_ports: [],
          max_connections: 1,
          max_mb: 1,
        },
      }),
    ]) {
      const res = await h.call("PUT", `/v1/jobs/${nextId()}`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await h.call("PUT", "/v1/jobs/NOT-AN-ID", jobBody())).status).toBe(400);
    const huge = await fetch(`${h.service.url}/v1/jobs/${nextId()}`, {
      method: "PUT",
      headers: { authorization: "Bearer test-service-token", "content-type": "application/json" },
      body: Buffer.alloc(9 * MIB, 0x20),
    });
    expect(huge.status).toBe(413);
  });

  it("tears everything down when the start fails half way", async () => {
    h = await harness();
    const real = h.docker.exec.bind(h.docker);
    h.docker.exec = async (args, options) =>
      args[0] === "run" && !args.some((a) => a.startsWith("EGRESS_MODE="))
        ? result({
            exit_code: 125,
            stderr: Buffer.from("docker: Error response from daemon: boom\n"),
          })
        : real(args, options);
    const id = nextId();
    const res = await h.call("PUT", `/v1/jobs/${id}`, jobBody());
    expect(res.status).toBe(502);
    expect(res.json.error.code).toBe("docker_failed");
    expect(h.docker.networks.size).toBe(0);
    expect([...h.docker.containers.keys()]).toEqual([]);
    expect(existsSync(join(h.root, "state", "jobs", id))).toBe(false);
    expect((await h.call("GET", "/v1/info")).json.load.jobs).toBe(0);
  });
});

describe("sandbox service: execs", () => {
  it("runs one exec as the programs' uid, streams it, and kills every process after", async () => {
    h = await harness();
    const job = await open();
    h.docker.cpuUsec = 1_000_000;
    h.docker.onProgram = async (call, options) => {
      (h as Harness).docker.cpuUsec = 3_500_000;
      options.onData?.("stdout", Buffer.from("héllo "));
      options.onData?.("stdout", Buffer.from("world\n"));
      expect(call.user).toBe("1000:1000");
      expect(call.workdir).toBe("/workspace");
      return result({ stdout: Buffer.from("héllo world\n") });
    };
    const exec = nextId();
    const started = await h.call("PUT", `/v1/jobs/${job}/execs/${exec}`, execBody());
    expect(started.status).toBe(202);
    expect(started.json.state).toBe("running");
    const done = await finished(job, exec);
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({
      exit_code: 0,
      killed_reason: null,
      stdout: "héllo world\n",
      cpu_ms: 2500,
    });
    expect(h.docker.programs[0]?.command).toEqual(["bash", `/code/${exec}.sh`]);
    // Killed after the exec, as the programs' uid.
    expect(h.docker.killAlls.length).toBeGreaterThan(0);
    const killAll = h.docker.calls.find((c) => c.join(" ").includes("kill -KILL -1")) as string[];
    expect(killAll[killAll.indexOf("--user") + 1]).toBe("1000:1000");
    const events = (await h.call("GET", "/v1/events")).json;
    const kinds = events.events.filter((e: Json) => e.job === job).map((e: Json) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["state", "stdout", "exit", "cpu"]));
    const text = events.events
      .filter((e: Json) => e.kind === "stdout")
      .map((e: Json) => e.text)
      .join("");
    expect(text).toBe("héllo world\n");
    // The full output is in the log, with a range.
    const log = await h.call("GET", `/v1/jobs/${job}/execs/${exec}/log`, undefined, {
      range: "bytes=7-",
    });
    expect(log.status).toBe(206);
    expect(log.bytes.toString("utf8")).toBe("world\n");
    // Python keeps the packages she installed with pip importable.
    const py = nextId();
    await h.call(
      "PUT",
      `/v1/jobs/${job}/execs/${py}`,
      execBody({ program: { language: "python", code: "print(1)" } }),
    );
    await finished(job, py);
    expect(h.docker.programs[1]?.command).toEqual(["python3", "-B", "-u", `/code/${py}.py`]);
  });

  it("allows one exec at a time and answers a resend with the same exec", async () => {
    h = await harness();
    const job = await open();
    let release!: () => void;
    h.docker.onProgram = () => new Promise((r) => (release = () => r(result())));
    const exec = nextId();
    expect((await h.call("PUT", `/v1/jobs/${job}/execs/${exec}`, execBody())).status).toBe(202);
    expect((await h.call("PUT", `/v1/jobs/${job}/execs/${exec}`, execBody())).status).toBe(200);
    const second = await h.call("PUT", `/v1/jobs/${job}/execs/${nextId()}`, execBody());
    expect(second.status).toBe(409);
    const different = await h.call(
      "PUT",
      `/v1/jobs/${job}/execs/${exec}`,
      execBody({ timeout_ms: 1000 }),
    );
    expect(different.status).toBe(409);
    expect((await h.call("GET", "/health")).json).toMatchObject({ running: 1, busy: true });
    await until(() => release !== undefined);
    release();
    await finished(job, exec);
    expect(h.docker.programs).toHaveLength(1);
  });

  it("stops an exec for quota, for its timeout and at its output limit", async () => {
    h = await harness();
    const job = await open();
    h.docker.onProgram = (_call, options) =>
      new Promise((resolve) =>
        options.signal?.addEventListener("abort", () => resolve(result({ exit_code: 137 }))),
      );
    const exec = nextId();
    await h.call("PUT", `/v1/jobs/${job}/execs/${exec}`, execBody());
    const stopped = await h.call("DELETE", `/v1/jobs/${job}/execs/${exec}?reason=quota`);
    expect(stopped.status).toBe(200);
    expect((await finished(job, exec)).result.killed_reason).toBe("quota");
    const slow = nextId();
    await h.call("PUT", `/v1/jobs/${job}/execs/${slow}`, execBody({ timeout_ms: 100 }));
    expect((await finished(job, slow)).result.killed_reason).toBe("timeout");
    h.docker.onProgram = (_call, options) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(result({ exit_code: 137 })));
        options.onData?.("stdout", Buffer.alloc(2048, 0x61));
        options.outputLimit?.onExceeded();
      });
    const loud = nextId();
    await h.call(
      "PUT",
      `/v1/jobs/${job}/execs/${loud}`,
      execBody({ output: { keep_bytes: 512, kill_bytes: 1024, stream_bytes: 256 } }),
    );
    const loudResult = (await finished(job, loud)).result;
    expect(loudResult.killed_reason).toBe("output_limit");
    expect(loudResult.log_bytes).toBe(1024);
  });

  it("ends the job as lost when even the kill cannot run (its pids used up)", async () => {
    h = await harness();
    const job = await open();
    h.docker.killFails = true;
    const exec = nextId();
    await h.call("PUT", `/v1/jobs/${job}/execs/${exec}`, execBody());
    const done = await finished(job, exec);
    expect(done.result.killed_reason).toBe("lost");
    await until(async () => (await (h as Harness).call("GET", `/v1/jobs/${job}`)).status === 410);
    const gone = await h.call("GET", `/v1/jobs/${job}`);
    expect(gone.json.error.ended.reason).toBe("lost");
  });

  it("refuses input files through a link an earlier exec left in /work", async () => {
    h = await harness();
    const job = await open();
    const work = join(h.root, "state", "jobs", job, "work");
    const outside = join(h.root, "outside");
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(work, "evil"), "junction");
    } catch {
      return; // No links on this machine.
    }
    const res = await h.call(
      "PUT",
      `/v1/jobs/${job}/execs/${nextId()}`,
      execBody({ files: [{ path: "evil/x.txt", content: "pwned" }] }),
    );
    expect(res.status).toBe(400);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });
});

describe("sandbox service: files in and out", () => {
  it("unpacks an upload, checking each part and the whole, and answers a resent commit the same", async () => {
    h = await harness();
    const job = await open();
    const data = await tarOf([
      { name: "a.txt", content: "hello" },
      { name: "dir/", type: "directory" },
      { name: "dir/b.txt", content: "world" },
    ]);
    const id = nextId();
    const bad = await h.call("PUT", `/v1/jobs/${job}/uploads/${id}/parts/0`, data, {
      "x-sha256": sha(Buffer.from("x")),
    });
    expect(bad.status).toBe(400);
    const half = Math.floor(data.length / 2);
    for (const [n, part] of [data.subarray(0, half), data.subarray(half)].entries()) {
      const put = await h.call("PUT", `/v1/jobs/${job}/uploads/${id}/parts/${n}`, part, {
        "x-sha256": sha(part),
      });
      expect(put.status).toBe(201);
    }
    const commit = {
      parts: 2,
      bytes: data.length,
      sha256: sha(data),
      format: "tar",
      target: "workspace",
      replace: true,
      manifest: [],
    };
    const wrong = await h.call("PUT", `/v1/jobs/${job}/uploads/${id}`, {
      ...commit,
      sha256: sha(Buffer.from("no")),
    });
    expect(wrong.status).toBe(400);
    const done = await h.call("PUT", `/v1/jobs/${job}/uploads/${id}`, commit);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ files: 2, bytes: 10, skipped: [] });
    const ws = join(h.root, "state", "jobs", job, "workspace");
    expect(readFileSync(join(ws, "dir", "b.txt"), "utf8")).toBe("world");
    expect((await h.call("PUT", `/v1/jobs/${job}/uploads/${id}`, commit)).json).toEqual(done.json);
    // The programs were stopped before the host wrote into /workspace.
    expect(h.docker.killAlls.length).toBeGreaterThan(0);
  });

  it("never writes outside the job for traversal, absolute paths, links or devices in the tar", async () => {
    h = await harness();
    const job = await open();
    const data = await tarOf([
      { name: "../escape.txt", content: "x" },
      { name: "../../../../etc/passwd", content: "x" },
      { name: "/abs.txt", content: "x" },
      { name: "C:/win.txt", content: "x" },
      { name: "a\\..\\..\\b.txt", content: "x" },
      { name: "link", type: "symlink", linkname: "/etc" },
      { name: "link/inside.txt", content: "x" },
      { name: "hard", type: "link", linkname: "/etc/passwd" },
      { name: "dev", type: "character-device" },
      { name: "pipe", type: "fifo" },
      { name: "ok.txt", content: "fine" },
    ]);
    const res = await upload(h, job, data);
    expect(res.status).toBe(200);
    // ok.txt, and link/inside.txt in a real directory (the link before it was never made).
    expect(res.json.files).toBe(2);
    const why = Object.fromEntries(res.json.skipped.map((s: Json) => [s.path, s.why]));
    expect(why.link).toBe("link");
    expect(why.hard).toBe("link");
    expect(Object.keys(why).length).toBeGreaterThanOrEqual(9);
    const jobs = join(h.root, "state", "jobs");
    expect(existsSync(join(jobs, "escape.txt"))).toBe(false);
    expect(existsSync(join(h.root, "state", "escape.txt"))).toBe(false);
    expect(existsSync(join(jobs, job, "workspace", "ok.txt"))).toBe(true);
    expect(lstatSync(join(jobs, job, "workspace", "link")).isDirectory()).toBe(true);
    expect(lstatSync(join(jobs, job, "workspace", "link")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(jobs, job, "workspace", "ok.txt")).mode & 0o7000).toBe(0);
  });

  it("does not follow a link the program left in /workspace while unpacking", async () => {
    h = await harness();
    const job = await open();
    const ws = join(h.root, "state", "jobs", job, "workspace");
    const outside = join(h.root, "outside-dir");
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(ws, "steer"), "junction");
    } catch {
      return;
    }
    const res = await upload(h, job, await tarOf([{ name: "steer/owned.txt", content: "x" }]));
    expect(res.status).toBe(200);
    expect(res.json.skipped[0]).toMatchObject({ path: "steer/owned.txt" });
    expect(existsSync(join(outside, "owned.txt"))).toBe(false);
  });

  it("refuses a tar bomb and a part that is too large", async () => {
    h = await harness();
    const job = await open({ limits: { ...jobBody().limits, disk_mb: 16, file_mb: 1 } });
    const big = await tarOf([{ name: "big.bin", content: "x".repeat(2 * MIB) }]);
    const res = await upload(h, job, big);
    expect(res.status).toBe(200);
    expect(res.json.skipped[0]).toMatchObject({ path: "big.bin", why: "file too large" });
    const many = await tarOf(
      Array.from({ length: 20 }, (_, i) => ({
        name: `f${i}.bin`,
        content: "y".repeat(900 * 1024),
      })),
    );
    const bomb = await upload(h, job, many);
    expect(bomb.status).toBe(413);
  });

  it("sends back what changed since the upload, with a resumable download, and moves on once received", async () => {
    h = await harness();
    const job = await open();
    const first = await tarOf([
      { name: "keep.txt", content: "same" },
      { name: "edit.txt", content: "old" },
      { name: "gone.txt", content: "bye" },
    ]);
    const manifest = [
      { path: "keep.txt", size: 4, sha256: sha(Buffer.from("same")), mtime_ms: 0 },
      { path: "edit.txt", size: 3, sha256: sha(Buffer.from("old")), mtime_ms: 0 },
      { path: "gone.txt", size: 3, sha256: sha(Buffer.from("bye")), mtime_ms: 0 },
    ];
    expect((await upload(h, job, first, { replace: true, manifest })).status).toBe(200);
    const ws = join(h.root, "state", "jobs", job, "workspace");
    writeFileSync(join(ws, "edit.txt"), "new content");
    writeFileSync(join(ws, "made.txt"), "made");
    const { rmSync } = await import("node:fs");
    rmSync(join(ws, "gone.txt"));
    try {
      symlinkSync(join(h.root, "host.toml"), join(ws, "secret-link"));
    } catch {
      // No links here: the rest still holds.
    }
    const sync = nextId();
    const res = await h.call("PUT", `/v1/jobs/${job}/syncs/${sync}`, { target: "workspace" });
    expect(res.status).toBe(200);
    expect(res.json.changed.map((e: Json) => e.path).sort()).toEqual(["edit.txt", "made.txt"]);
    expect(res.json.deleted).toEqual(["gone.txt"]);
    const tar = await h.call("GET", `/v1/jobs/${job}/syncs/${sync}/tar`);
    expect(tar.status).toBe(200);
    expect(tar.headers.get("etag")).toBe(`"${res.json.tar.sha256}"`);
    expect(sha(tar.bytes)).toBe(res.json.tar.sha256);
    expect(tar.bytes.toString("latin1")).not.toContain("cluster");
    const tail = await h.call("GET", `/v1/jobs/${job}/syncs/${sync}/tar`, undefined, {
      range: "bytes=100-",
    });
    expect(tail.status).toBe(206);
    expect(Buffer.compare(tail.bytes, tar.bytes.subarray(100))).toBe(0);
    // Not received yet: a new sync sends the same again.
    const again = await h.call("PUT", `/v1/jobs/${job}/syncs/${nextId()}`, { target: "workspace" });
    expect(again.json.changed.map((e: Json) => e.path).sort()).toEqual(["edit.txt", "made.txt"]);
    expect((await h.call("DELETE", `/v1/jobs/${job}/syncs/${sync}`)).status).toBe(200);
    const after = await h.call("PUT", `/v1/jobs/${job}/syncs/${nextId()}`, { target: "workspace" });
    expect(after.json.changed).toEqual([]);
    expect(after.json.deleted).toEqual([]);
    expect(after.json.tar).toBeNull();
  });

  it("pauses a job whose procs run while it reads its files, and refuses when it cannot", async () => {
    h = await harness();
    const job = await open({ kind: "browser" });
    await h.call("PUT", `/v1/jobs/${job}/procs/${nextId()}`, { argv: ["node", "driver.mjs"] });
    const res = await h.call("PUT", `/v1/jobs/${job}/syncs/${nextId()}`, { target: "workspace" });
    expect(res.status).toBe(200);
    expect(h.docker.calledWith("pause")).toHaveLength(1);
    expect(h.docker.calledWith("unpause")).toHaveLength(1);
    h.docker.pauseFails = true;
    expect(
      (await h.call("PUT", `/v1/jobs/${job}/syncs/${nextId()}`, { target: "workspace" })).status,
    ).toBe(409);
  });
});

describe("sandbox service: procs", () => {
  it("writes stdin by offset once, streams output with offsets, and fills a gap on request", async () => {
    h = await harness();
    const job = await open({
      kind: "plugin",
      for: "owner",
      lifetime_s: 0,
      mounts: { tools: false, ext: true },
    });
    const proc = nextId();
    const started = await h.call("PUT", `/v1/jobs/${job}/procs/${proc}`, {
      argv: ["node", "/ext/index.mjs"],
      cwd: "/ext",
    });
    expect(started.status).toBe(201);
    const fake = h.spawner.procs[0];
    expect(fake?.args).toContain("1000:1000");
    expect(fake?.args).toContain("/ext");
    const write = (offset: number, text: string) =>
      (h as Harness).call(
        "PUT",
        `/v1/jobs/${job}/procs/${proc}/stdin?offset=${offset}`,
        Buffer.from(text),
      );
    expect((await write(0, "hello")).json.stdin_offset).toBe(5);
    expect((await write(0, "hello")).json.stdin_offset).toBe(5); // resent: not written again
    expect((await write(3, "lo world")).json.stdin_offset).toBe(11); // overlap: only the new part
    expect((await write(20, "gap")).status).toBe(409);
    await until(() => Buffer.concat(fake?.received ?? []).toString() === "hello world");
    fake?.stdout.write(Buffer.from("first "));
    fake?.stdout.write(Buffer.from("second"));
    await until(async () => {
      const events = (await (h as Harness).call("GET", "/v1/events")).json.events;
      return events.filter((e: Json) => e.kind === "proc_out").length >= 2;
    });
    const events = (await h.call("GET", "/v1/events")).json.events.filter(
      (e: Json) => e.kind === "proc_out",
    );
    expect(events.map((e: Json) => e.offset)).toEqual([0, 6]);
    expect(Buffer.from(events[1].data_b64, "base64").toString()).toBe("second");
    const fill = await h.call("GET", `/v1/jobs/${job}/procs/${proc}/stdout?after=3`);
    expect(fill.bytes.toString()).toBe("st second");
    expect(fill.headers.get("x-next-offset")).toBe("12");
    expect(fill.headers.get("x-proc-state")).toBe("running");
    fake?.exit(0);
    await until(
      async () =>
        (await (h as Harness).call("GET", `/v1/jobs/${job}/procs/${proc}`)).json.state === "exited",
    );
    // No execs in a plugin job, and no procs in a session.
    expect((await h.call("PUT", `/v1/jobs/${job}/execs/${nextId()}`, execBody())).status).toBe(409);
    const session = await open();
    expect(
      (await h.call("PUT", `/v1/jobs/${session}/procs/${nextId()}`, { argv: ["sh"] })).status,
    ).toBe(409);
  });
});

describe("sandbox service: lifetimes, restarts and events", () => {
  it("ends a job whose lease ran out, and keeps one Core touches", async () => {
    h = await harness();
    const stale = await open({ lease_s: 60 });
    const kept = await open({ lease_s: 60 });
    h.now.t += 50_000;
    await h.call("PUT", `/v1/jobs/${kept}/lease`, {});
    h.now.t += 20_000;
    await h.service.sweep();
    const gone = await h.call("GET", `/v1/jobs/${stale}`);
    expect(gone.status).toBe(410);
    expect(gone.json.error.ended.reason).toBe("lease");
    expect((await h.call("GET", `/v1/jobs/${kept}`)).status).toBe(200);
    expect(h.docker.containers.has(`miyoria-sbx-${stale}`)).toBe(false);
    expect(h.docker.networks.has(`miyoria-sbx-net-${stale}`)).toBe(false);
    expect(existsSync(join(h.root, "state", "jobs", stale))).toBe(false);
    const closed = await h.call("DELETE", `/v1/jobs/${kept}`);
    expect(closed.json.ended.reason).toBe("closed");
  });

  it("closes a member's job when the owner stops taking members", async () => {
    h = await harness({ hostToml: "members = true\n" });
    const job = await open({ for: "member", payer: "0123456789abcdef" });
    writeFileSync(h.hostToml, "members = false\n");
    await h.service.refresh();
    await h.service.sweep();
    expect((await h.call("GET", `/v1/jobs/${job}`)).json.error.ended.reason).toBe("host_policy");
  });

  it("takes running jobs back after a restart and removes what is left of the rest", async () => {
    h = await harness();
    const kept = await open();
    const dead = await open();
    h.docker.containers.delete(`miyoria-sbx-${dead}`);
    // A leftover of this instance that belongs to no job at all.
    const instance = h.docker.containers.get(`miyoria-sbx-${kept}`)?.labels[
      "miyoria.sandbox.instance"
    ] as string;
    h.docker.containers.set("miyoria-sbx-orphan", {
      name: "miyoria-sbx-orphan",
      args: [],
      labels: {
        "miyoria.sandbox": "1",
        "miyoria.sandbox.instance": instance,
        "miyoria.sandbox.job": "zzz",
      },
      running: true,
      paused: false,
    });
    const killsBefore = h.docker.killAlls.length;
    await h.restart();
    expect((await h.call("GET", `/v1/jobs/${kept}`)).status).toBe(200);
    expect((await h.call("GET", `/v1/jobs/${dead}`)).status).toBe(404);
    expect(existsSync(join(h.root, "state", "jobs", dead))).toBe(false);
    expect(h.docker.containers.has("miyoria-sbx-orphan")).toBe(false);
    expect(h.docker.networks.has(`miyoria-sbx-net-${dead}`)).toBe(false);
    // The programs that ran before the restart were killed before it was taken back.
    expect(h.docker.killAlls.length).toBeGreaterThan(killsBefore);
    // A cursor of the old start is reset.
    const page = (await h.call("GET", "/v1/events?after=oldboot:5")).json;
    expect(page.reset).toBe(true);
  });

  it("waits for events, then answers as soon as one comes", async () => {
    h = await harness();
    const first = (await h.call("GET", "/v1/events")).json;
    const started = Date.now();
    const waiting = h.call("GET", `/v1/events?after=${first.cursor}&wait_ms=5000`);
    let opened: Promise<string> | null = null;
    setTimeout(() => {
      opened = open();
    }, 100);
    const page = (await waiting).json;
    await until(() => opened !== null);
    await opened;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(page.reset).toBe(false);
    expect(page.events[0].kind).toBe("state");
    const none = (await h.call("GET", `/v1/events?after=${page.cursor.replace(/:\d+$/, ":9999")}`))
      .json;
    expect(none.reset).toBe(true);
  });
});
