// The sandbox service's pieces on their own: the event ring and its cursor, the CPU readings,
// the owner's rules, the proc output kept for refetching, the token check, the image tag, and
// the container arguments the service adds to `buildRunArgs`.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunArgs, execWithArgs, InvalidSpecError, pauseArgs } from "../../src/args.js";
import { defaultSandboxConfig } from "../../src/config.js";
import { acceptedTokens, authorized, isLoopback } from "../../src/service/auth.js";
import { parseCpuacctUsage, parseCpuPercent, parseCpuStat } from "../../src/service/cpu.js";
import { measure } from "../../src/service/disk.js";
import { EventRing } from "../../src/service/events.js";
import { imageHash, imageSource, imageTag } from "../../src/service/images.js";
import { accepts, policyOf } from "../../src/service/policy.js";
import { Retained } from "../../src/service/procs.js";
import { requestHash, stableJson } from "../../src/service/util.js";
import { applyLimits, checkEnv } from "../../src/service/validate.js";
import { tempDir } from "./helpers.js";

describe("event ring", () => {
  it("numbers events, pages by cursor and bytes, and resets a cursor it cannot serve", () => {
    const ring = new EventRing("boot1", { maxEvents: 3, maxBytes: 1_000_000 });
    for (let i = 0; i < 5; i++) ring.push({ job: "j", kind: "cpu", cpu_ms: i });
    expect(ring.seq).toBe(5);
    // Only the last three are kept: 3, 4, 5.
    const fresh = ring.page(null, 1_000_000);
    expect(fresh.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(fresh.cursor).toBe("boot1:5");
    expect(ring.page("boot1:3", 1_000_000).events.map((e) => e.seq)).toEqual([4, 5]);
    expect(ring.page("boot1:5", 1_000_000)).toEqual({
      cursor: "boot1:5",
      events: [],
      reset: false,
    });
    // Older than what is kept: reset, and what is kept.
    const old = ring.page("boot1:1", 1_000_000);
    expect(old.reset).toBe(true);
    expect(old.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    for (const bad of ["boot0:4", "boot1:9", "boot1:x", "nonsense"]) {
      expect(ring.page(bad, 1_000_000).reset, bad).toBe(true);
    }
    // A small page still carries one event, and its cursor continues from there.
    const small = ring.page("boot1:2", 10);
    expect(small.events.map((e) => e.seq)).toEqual([3]);
    expect(small.cursor).toBe("boot1:3");
  });

  it("drops the oldest by size too, and wakes a waiting poll", async () => {
    const ring = new EventRing("b", { maxEvents: 100, maxBytes: 300 });
    for (let i = 0; i < 10; i++)
      ring.push({ job: "j", exec: "e", kind: "stdout", text: "x".repeat(50) });
    expect(ring.page(null, 10_000).events.length).toBeLessThan(10);
    const controller = new AbortController();
    const waiting = ring.wait(10_000, controller.signal);
    ring.push({ job: "j", kind: "cpu", cpu_ms: 1 });
    await waiting;
    controller.abort();
  });
});

describe("cpu readings", () => {
  it("reads cgroup v2, v1 and docker stats", () => {
    expect(parseCpuStat("usage_usec 2500999\nuser_usec 1\nsystem_usec 2\n")).toBe(2500);
    expect(parseCpuStat("user_usec 1\n")).toBeNull();
    expect(parseCpuacctUsage("3000000000\n")).toBe(3000);
    expect(parseCpuacctUsage("nope")).toBeNull();
    expect(parseCpuPercent("150.25%")).toBeCloseTo(1.5025);
    expect(parseCpuPercent("--")).toBeNull();
  });
});

describe("host policy", () => {
  const machine = { cpus: 12, memoryMb: 65_536 };

  it("defaults to half the machine, no members, no plugins, and lowers what one job gets", () => {
    const p = policyOf(undefined, undefined, machine);
    expect(p).toMatchObject({
      members: false,
      plugins: false,
      cpus: 6,
      memory_mb: 16_384,
      disk_mb: 20_480,
      max_job_cpus: 6,
      max_job_memory_mb: 16_384,
      runtime: null,
      concurrency: 4,
    });
    expect(policyOf(undefined, undefined, { cpus: 1, memoryMb: 2048 }).cpus).toBe(1);
    const owner = policyOf({ cpus: 2, max_job_cpus: 8, members: true }, 2, machine);
    expect(owner.max_job_cpus).toBe(2);
    expect(owner.concurrency).toBe(2);
    expect(policyOf(undefined, 9, machine).concurrency).toBe(4);
    expect(accepts(owner, "member")).toBe(true);
    expect(accepts(owner, "plugin")).toBe(false);
    expect(accepts(p, "self")).toBe(true);
    expect(accepts(p, "owner")).toBe(true);
  });
});

describe("proc output kept", () => {
  it("keeps the last bytes with their offsets and says when some are gone", () => {
    const kept = new Retained(10);
    expect(kept.push(Buffer.from("0123456"))).toBe(0);
    expect(kept.push(Buffer.from("789abc"))).toBe(7);
    expect(kept.total).toBe(13);
    expect(kept.start).toBe(3);
    expect(kept.from(5)?.toString()).toBe("56789abc");
    expect(kept.from(13)?.length).toBe(0);
    expect(kept.from(2)).toBeNull();
  });
});

describe("token", () => {
  const req = (authorization?: string) =>
    ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;

  it("takes either token, in constant time, and nothing else", () => {
    const accepted = acceptedTokens("service-one", " host-two ");
    expect(authorized(req("Bearer service-one"), accepted)).toBe(true);
    expect(authorized(req("bearer host-two"), accepted)).toBe(true);
    expect(authorized(req("Bearer service-on"), accepted)).toBe(false);
    expect(authorized(req("Basic service-one"), accepted)).toBe(false);
    expect(authorized(req(), accepted)).toBe(false);
    expect(authorized(req("Bearer "), accepted)).toBe(false);
    expect(acceptedTokens(null, "")).toEqual([]);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("100.101.102.103")).toBe(false);
  });
});

describe("image tag", () => {
  it("changes with any file of the image folder and leaves the browser's out of the default", async () => {
    const dir = tempDir("sbx-image-");
    try {
      writeFileSync(join(dir, "Dockerfile"), "FROM x\n");
      writeFileSync(join(dir, "requirements.txt"), "numpy==1\n");
      const first = await imageHash(dir, imageSource(dir, "default").skip);
      expect(first).toMatch(/^[0-9a-f]{12}$/);
      expect(imageTag("default", first as string)).toBe(`miyoria/sandbox:1-${first}`);
      mkdirSync(join(dir, "browser"));
      writeFileSync(join(dir, "browser", "Dockerfile"), "FROM y\n");
      expect(await imageHash(dir, ["browser"])).toBe(first);
      expect(await imageHash(join(dir, "browser"))).not.toBe(first);
      writeFileSync(join(dir, "requirements.txt"), "numpy==2\n");
      expect(await imageHash(dir, ["browser"])).not.toBe(first);
      expect(await imageHash(join(dir, "nothing"))).toBeNull();
      expect(imageTag("browser", "abcdefabcdef")).toBe("miyoria/sandbox-browser:1-abcdefabcdef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("request hash", () => {
  it("ignores key order and undefined fields", () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe("disk measure", () => {
  it("counts files and folders without following links and stops at its entry cap", async () => {
    const dir = tempDir("sbx-disk-");
    try {
      writeFileSync(join(dir, "a.bin"), Buffer.alloc(10_000));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "b.bin"), Buffer.alloc(5_000));
      const reading = await measure([dir]);
      expect(reading.bytes).toBeGreaterThanOrEqual(15_000);
      expect(reading.truncated).toBe(false);
      expect((await measure([dir], 1)).truncated).toBe(true);
      expect((await measure([join(dir, "missing")])).bytes).toBe(0);
      expect((await measure([join(dir, "missing")])).unreadable).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Permissions do not keep a Windows user or root out, so only there is a folder hidden.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "counts what a job hid under a folder it took the permissions off",
    async () => {
      const dir = tempDir("sbx-disk-");
      try {
        for (const [name, mode] of [
          ["closed", 0o000],
          ["listed", 0o444],
        ] as const) {
          mkdirSync(join(dir, name));
          writeFileSync(join(dir, name, "big.bin"), Buffer.alloc(200_000));
          chmodSync(join(dir, name), mode);
        }
        const reading = await measure([dir]);
        expect(reading.bytes).toBeGreaterThanOrEqual(400_000);
        expect(reading.unreadable).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("environment of a program", () => {
  it("refuses a value with a line break as a bad request", () => {
    expect(checkEnv({ MADE_A: "one line" })).toEqual({ MADE_A: "one line" });
    for (const value of ["two\nlines", "carriage\rreturn"]) {
      expect(() => checkEnv({ MADE_A: value })).toThrow(/line break/);
    }
  });
});

describe("job limits", () => {
  it("never lets one file grow past what the whole job may hold", () => {
    const policy = policyOf({ disk_mb: 512 }, undefined, { cpus: 8, memoryMb: 16_384 });
    const limits = {
      cpus: 1,
      memory_mb: 1024,
      pids: 256,
      tmp_mb: 64,
      file_mb: 4096,
      nofile: 1024,
      disk_mb: 1024,
    };
    const applied = applyLimits(limits, policy);
    expect(applied.disk_mb).toBe(512);
    expect(applied.file_mb).toBe(512);
    expect(applyLimits({ ...limits, file_mb: 64 }, policy).file_mb).toBe(64);
  });
});

describe("container arguments of a job", () => {
  const base = {
    name: "miyoria-sbx-01j00000000000000000000001",
    image: "miyoria/sandbox:1-abcdefabcdef",
    labels: {},
    workDir: "/j/work",
    codeDir: "/j/code",
    toolsDir: null,
    user: "65534:65534",
    limits: defaultSandboxConfig().limits,
    command: ["sleep", "infinity"],
    env: {},
  };

  it("leaves the local backend's arguments exactly as they were", () => {
    const args = buildRunArgs(base);
    expect(args).not.toContain("--cgroupns");
    expect(args).not.toContain("--runtime");
    expect(args[args.indexOf("--tmpfs") + 1]).toContain("noexec");
    expect(args[args.indexOf("--workdir") + 1]).toBe("/work");
    expect(args.join(" ")).not.toContain("/home/sandbox");
  });

  it("adds home, ext, cgroupns, an exec-able /tmp, shm and the runtime when asked", () => {
    const args = buildRunArgs({
      ...base,
      homeDir: "/j/home",
      extDir: "/j/ext",
      cgroupns: "private",
      tmpExec: true,
      shmMb: 256,
      runtime: "runsc",
      workdir: "/workspace",
    });
    expect(args[args.indexOf("--cgroupns") + 1]).toBe("private");
    expect(args[args.indexOf("--runtime") + 1]).toBe("runsc");
    expect(args).toContain(`/tmp:rw,nosuid,nodev,size=${base.limits.tmpfs_mb}m`);
    expect(args).toContain("/dev/shm:rw,nosuid,nodev,size=256m");
    expect(args).toContain("type=bind,source=/j/home,target=/home/sandbox");
    expect(args).toContain("type=bind,source=/j/ext,target=/ext,readonly");
    expect(args[args.indexOf("--workdir") + 1]).toBe("/workspace");
    expect(() => buildRunArgs({ ...base, runtime: "--privileged" })).toThrow(InvalidSpecError);
    expect(() => buildRunArgs({ ...base, shmMb: 0 })).toThrow(InvalidSpecError);
    expect(() => buildRunArgs({ ...base, workdir: "/etc" as "/work" })).toThrow(InvalidSpecError);
  });

  it("builds execs with a workdir and env that cannot be read as flags", () => {
    expect(
      execWithArgs("miyoria-sbx-x", ["bash", "/code/a.sh"], {
        user: "1000:1000",
        workdir: "/workspace",
        env: { A: "1" },
      }),
    ).toEqual([
      "exec",
      "-i",
      "--user",
      "1000:1000",
      "--workdir",
      "/workspace",
      "--env",
      "A=1",
      "miyoria-sbx-x",
      "bash",
      "/code/a.sh",
    ]);
    expect(() => execWithArgs("miyoria-sbx-x", ["x"], { user: "0", workdir: "/w" })).toThrow();
    expect(() =>
      execWithArgs("miyoria-sbx-x", ["x"], { user: "1:1", workdir: "--privileged" }),
    ).toThrow();
    expect(() =>
      execWithArgs("miyoria-sbx-x", ["x"], { user: "1:1", workdir: "/w", env: { "A=B": "1" } }),
    ).toThrow();
    expect(() => execWithArgs("--rm", ["x"], { user: "1:1", workdir: "/w" })).toThrow();
    expect(pauseArgs("miyoria-sbx-x", true)).toEqual(["pause", "miyoria-sbx-x"]);
  });
});
