// A sandbox service on loopback over the fake Docker, and the calls the tests make to it.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobCreate } from "@miyoria/contracts/workers";
import tar from "tar-stream";
import { type RunningSandboxService, startSandboxService } from "../../src/service/index.js";
import type { HostConfigParser } from "../../src/service/policy.js";
import { FakeDocker, FakeSpawner } from "./fake-docker.js";

/** An answer of any route, looked into by path in the tests. */
// biome-ignore lint/suspicious/noExplicitAny: every route answers its own shape
export type Json = any;

export const TOKEN = "test-service-token";
export const IMAGE = "miyoria/sandbox:1-aaaaaaaaaaaa";

/** A folder under the worktree's `.tmp-test` (or the system's). */
export function tempDir(prefix: string): string {
  const base = process.env.TMP ?? process.env.TEMP;
  const root = base !== undefined ? base : join(process.cwd(), ".tmp-test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

/** `[sandbox]` lines of a host.toml, read by a tiny parser for the keys the tests use. */
export const parseHost: HostConfigParser = (_file, text) => {
  if (text.includes("BROKEN")) throw new Error("not valid TOML: line 1");
  const sandbox: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line.trim());
    if (m === null) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    sandbox[key] = raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return { sandbox, services: {} } as ReturnType<HostConfigParser>;
};

export interface Harness {
  service: RunningSandboxService;
  docker: FakeDocker;
  spawner: FakeSpawner;
  root: string;
  hostToml: string;
  now: { t: number };
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Json; bytes: Buffer; headers: Headers }>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function harness(
  over: {
    hostToml?: string;
    images?: boolean;
    docker?: FakeDocker;
    root?: string;
    /** `false`: answer at once after the start, without waiting for the first check. */
    refresh?: boolean;
  } = {},
): Promise<Harness> {
  const root = over.root ?? tempDir("sbx-service-");
  const hostToml = join(root, "host.toml");
  writeFileSync(hostToml, over.hostToml ?? "cpus = 8\nmemory_mb = 16384\n");
  const docker = over.docker ?? new FakeDocker();
  if (over.images !== false) docker.images.add(IMAGE);
  const spawner = new FakeSpawner();
  const now = { t: 1_800_000_000_000 };
  const start = () =>
    startSandboxService({
      host: "127.0.0.1",
      port: 0,
      hostToml,
      state: join(root, "state"),
      imageDir: join(root, "image"),
      token: TOKEN,
      hostToken: null,
      runner: docker,
      spawner,
      clock: { now: () => now.t },
      parseHostConfig: parseHost,
      images: { default: IMAGE, proxy: IMAGE },
      hostUser: { uid: 1000, gid: 1000 },
      denyAddresses: () => ["203.0.113.50", "2a01:4f8:1:2::/64"],
      checkEveryMs: 3_600_000,
      killGraceMs: 50,
    });
  let service = await start();
  if (over.refresh !== false) await service.refresh();
  const h: Harness = {
    get service() {
      return service;
    },
    docker,
    spawner,
    root,
    hostToml,
    now,
    async call(method, path, body, headers = {}) {
      const init: RequestInit = {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      };
      if (body !== undefined) {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        init.body = data;
        (init.headers as Record<string, string>)["content-type"] = Buffer.isBuffer(body)
          ? "application/octet-stream"
          : "application/json";
      }
      const res = await fetch(`${service.url}${path}`, init);
      const bytes = Buffer.from(await res.arrayBuffer());
      let json: Json = null;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        // Not JSON.
      }
      return { status: res.status, json, bytes, headers: res.headers };
    },
    async restart() {
      await service.close();
      service = await start();
      await service.refresh();
    },
    async close() {
      await service.close();
      if (over.root === undefined) rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

let counter = 0;
/** A fresh lower-case ULID-shaped id. */
export function nextId(): string {
  counter += 1;
  return `01j${String(counter).padStart(23, "0")}`;
}

export function jobBody(over: Partial<JobCreate> = {}): JobCreate {
  return {
    kind: "session",
    image: "default",
    for: "self",
    payer: null,
    limits: {
      cpus: 2,
      memory_mb: 2048,
      pids: 512,
      tmp_mb: 512,
      file_mb: 256,
      nofile: 4096,
      disk_mb: 2048,
    },
    network: {
      mode: "open",
      allow: [],
      deny_ports: [25, 465, 587],
      max_connections: 64,
      max_mb: 4096,
    },
    lifetime_s: 7200,
    idle_s: 900,
    lease_s: 600,
    mounts: { tools: false, ext: false },
    env: {},
    label: null,
    ...over,
  };
}

export function execBody(over: Record<string, unknown> = {}) {
  return {
    program: { language: "shell", code: "echo hi" },
    timeout_ms: 30_000,
    output: { keep_bytes: 65_536, kill_bytes: 8_388_608, stream_bytes: 262_144 },
    collect: null,
    ...over,
  };
}

export function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface TarEntry {
  name: string;
  type?: "file" | "directory" | "symlink" | "link" | "character-device" | "fifo";
  content?: string;
  linkname?: string;
}

export async function tarOf(entries: readonly TarEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const e of entries) {
    const type = e.type ?? "file";
    const content = Buffer.from(e.content ?? "");
    const header = {
      name: e.name,
      type,
      ...(e.linkname !== undefined ? { linkname: e.linkname } : {}),
      size: type === "file" ? content.length : 0,
      // setuid in the tar: never carried onto the disk.
      mode: 0o4755,
    };
    if (type === "file") pack.entry(header, content);
    else pack.entry(header, "");
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Uploads `data` as one part and commits it. */
export async function upload(
  h: Harness,
  job: string,
  data: Buffer,
  over: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const id = nextId();
  const part = await h.call("PUT", `/v1/jobs/${job}/uploads/${id}/parts/0`, data, {
    "x-sha256": sha(data),
  });
  if (part.status >= 300) return part;
  return await h.call(
    "PUT",
    `/v1/jobs/${job}/uploads/${id}`,
    {
      parts: 1,
      bytes: data.length,
      sha256: sha(data),
      format: "tar",
      target: "workspace",
      replace: false,
      manifest: [],
      ...over,
    },
    headers,
  );
}

/** Waits until `check` holds (polling). */
export async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}
