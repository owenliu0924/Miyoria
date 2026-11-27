// The egress proxy's program runs for real here, as a child `node` on loopback (no Docker); the
// Docker topology around it (`--internal` network, the proxy container) is covered by argument
// tests and by the integration test, which needs Docker.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import {
  connect,
  createServer as createTcp,
  isIP,
  isIPv6,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { isBlockedAddress } from "../../web/src/net.js";
import {
  addressesInSubnets,
  isolatesGateway,
  jobEgressProxyArgs,
  LABEL_JOB,
  parseEgressStats,
} from "../src/egress.js";
import {
  buildRunArgs,
  defaultSandboxConfig,
  EGRESS_ALIAS,
  EGRESS_PROGRAM,
  egressProxyArgs,
  networkCreateArgs,
  proxyEnv,
  SandboxConfigSchema,
} from "../src/index.js";

const children: ChildProcess[] = [];
const servers: Array<Server | NetServer> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.close();
});

async function startProxy(env: Record<string, string>): Promise<number> {
  const child = spawn(process.execPath, ["-e", EGRESS_PROGRAM], {
    env: { PATH: process.env.PATH ?? "", EGRESS_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return await new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /listening (\d+)/.exec(chunk.toString());
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", () => reject(new Error("proxy exited")));
  });
}

async function startTarget(): Promise<number> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello from ${req.headers.host}`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** A plain HTTP request through the proxy, as a client with `HTTP_PROXY` would send it. */
async function viaProxy(proxy: number, url: string): Promise<{ status: number; body: string }> {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: proxy, method: "GET", path: url, headers: { host: "x" } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** `CONNECT host:port`; resolves with the status line the proxy answers. */
function connectThrough(proxy: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0] ?? "");
      socket.destroy();
    });
    // Closed without a word (a request line the parser refuses).
    socket.once("close", () => resolve(""));
    socket.once("error", reject);
  });
}

describe("egress proxy program", () => {
  it("forwards_an_allowed_host_and_refuses_everything_else", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      EGRESS_ALLOW: "localhost",
      EGRESS_PORTS: String(target),
      EGRESS_ALLOW_PRIVATE: "1",
    });
    const ok = await viaProxy(proxy, `http://localhost:${target}/x`);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe(`hello from localhost:${target}`);
    // A host that is not on the list, even though it resolves to the same place.
    const other = await viaProxy(proxy, `http://127.0.0.1:${target}/x`);
    expect(other.status).toBe(403);
    // A port that is not on the list.
    const port = await viaProxy(proxy, `http://localhost:${target + 1}/x`);
    expect(port.status).toBe(403);
    // Not an absolute URL (a direct request to the proxy).
    const direct = await viaProxy(proxy, "/x");
    expect(direct.status).toBe(400);
  });

  it("tunnels_connect_only_to_allowed_hosts_and_ports", async () => {
    const tcp = createTcp((s) => s.end("up"));
    servers.push(tcp);
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const port = (tcp.address() as { port: number }).port;
    const proxy = await startProxy({
      EGRESS_ALLOW: "localhost",
      EGRESS_PORTS: String(port),
      EGRESS_ALLOW_PRIVATE: "1",
    });
    expect(await connectThrough(proxy, `localhost:${port}`)).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    expect(await connectThrough(proxy, `evil.example:${port}`)).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, `localhost:${port + 1}`)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("matches_suffix_patterns_on_label_boundaries", async () => {
    const proxy = await startProxy({ EGRESS_ALLOW: "*.pythonhosted.org,pypi.org" });
    // Never resolves (refused before any lookup would matter), so only the 403s are asserted.
    expect(await connectThrough(proxy, "evilpythonhosted.org:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "pythonhosted.org:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "pypi.org.evil.example:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "files.pythonhosted.org.evil.example:443")).toBe(
      "HTTP/1.1 403 Forbidden",
    );
  });

  it("never_reaches_private_loopback_or_metadata_addresses_even_when_named_in_the_list", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      EGRESS_ALLOW: "localhost,127.0.0.1,169.254.169.254,10.0.0.1,192.168.1.1",
      EGRESS_PORTS: `${target},80,443`,
    });
    // `EGRESS_ALLOW_PRIVATE` is not set: a name on the list that resolves inside is still refused.
    expect((await viaProxy(proxy, `http://localhost:${target}/`)).status).toBe(403);
    expect((await viaProxy(proxy, `http://127.0.0.1:${target}/`)).status).toBe(403);
    expect(await connectThrough(proxy, "169.254.169.254:80")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "10.0.0.1:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "192.168.1.1:443")).toBe("HTTP/1.1 403 Forbidden");
  });
});

/**
 * The program's own `refusedAddress`, run in a context where nothing listens or resolves: the
 * table is checked address by address without a network.
 */
function programTable(env: Record<string, string> = {}): (address: string) => boolean {
  const stub = {
    createServer: () => ({ on() {}, listen() {}, address: () => ({ port: 0 }) }),
    request() {},
  };
  const context = createContext({
    require: (name: string) =>
      name === "net"
        ? { isIP, isIPv6, connect() {} }
        : name === "dns"
          ? { promises: { lookup: async () => [] } }
          : name === "fs"
            ? { writeFile() {}, rename() {} }
            : stub,
    process: { env, on() {} },
    console,
    URL,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    out: {} as { refused?: (a: string) => boolean },
  });
  runInContext(`${EGRESS_PROGRAM}\nout.refused = refusedAddress;`, context);
  return (context.out as { refused: (a: string) => boolean }).refused;
}

describe("egress address table", () => {
  const refused = programTable();
  const mustRefuse = [
    // IPv4 ranges of the design (§5.2), the tailnet and the metadata addresses among them.
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.100.100.200",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "172.17.0.1",
    "172.31.255.255",
    "192.0.0.170",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.65.254",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.251",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6, and every form that carries one of the IPv4 addresses above.
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:0:a9fe:a9fe",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::169.254.169.254",
    "64:ff9b::a64:1",
    "64:ff9b:1::808:808",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "2002:c0a8:101::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:1::1",
    "2001:db8::1",
    "3fff::1",
    "100::1",
    "fc00::1",
    "fd00:ec2::254",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "ff0e::1",
    // Not an address at all.
    "fe80::1%eth0",
    "localhost",
    "1.2.3",
    "",
  ];
  const mustPass = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.215.14",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ];

  it("refuses_every_private_tailnet_metadata_and_embedded_form", () => {
    for (const address of mustRefuse) expect(refused(address), address).toBe(true);
    for (const address of mustPass) expect(refused(address), address).toBe(false);
  });

  it("refuses_at_least_what_cores_own_guard_refuses", () => {
    // Core's `isBlockedAddress` and the proxy are two copies of one table (the proxy runs as
    // `node -e` and cannot import it); the proxy may refuse more, never less.
    for (const address of [...mustRefuse, ...mustPass]) {
      if (isBlockedAddress(address)) expect(refused(address), address).toBe(true);
    }
    for (const address of mustPass) expect(isBlockedAddress(address), address).toBe(false);
  });

  it("adds_the_machines_own_addresses_and_gateways_from_the_deny_list", () => {
    const own = programTable({ EGRESS_DENY_ADDRS: "203.0.114.7,2a01:4f8:1:2::/64,8.8.4.0/24" });
    expect(own("203.0.114.7")).toBe(true);
    expect(own("203.0.114.8")).toBe(false);
    expect(own("2a01:4f8:1:2::99")).toBe(true);
    expect(own("2a01:4f8:1:3::99")).toBe(false);
    expect(own("8.8.4.4")).toBe(true);
    // The IPv4 deny list holds for the IPv6 forms that carry the address as well.
    expect(own("::ffff:203.0.114.7")).toBe(true);
    expect(own("64:ff9b::cb00:7207")).toBe(true);
    expect(own("2002:cb00:7207::1")).toBe(true);
    // The test switch turns off the built-in table, never the deny list.
    const testing = programTable({ EGRESS_ALLOW_PRIVATE: "1", EGRESS_DENY_ADDRS: "127.0.0.2" });
    expect(testing("127.0.0.1")).toBe(false);
    expect(testing("127.0.0.2")).toBe(true);
    expect(testing("::ffff:127.0.0.2")).toBe(true);
  });
});

/** `EGRESS_MODE=open` on loopback: the private table is off, so only the other rules are seen. */
describe("egress proxy in open mode", () => {
  it("refuses_mail_ports_names_of_the_lan_and_a_listed_own_address", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      EGRESS_MODE: "open",
      EGRESS_ALLOW_PRIVATE: "1",
      EGRESS_DENY_ADDRS: "127.0.0.2",
    });
    expect((await viaProxy(proxy, `http://127.0.0.1:${target}/x`)).status).toBe(200);
    for (const port of [25, 465, 587, 2525]) {
      expect(await connectThrough(proxy, `127.0.0.1:${port}`), String(port)).toBe(
        "HTTP/1.1 403 Forbidden",
      );
      expect((await viaProxy(proxy, `http://127.0.0.1:${port}/`)).status).toBe(403);
    }
    expect(await connectThrough(proxy, "127.0.0.2:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "[::ffff:127.0.0.2]:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "127.0.0.1:0")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "127.0.0.1:70000")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "bad_host!:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "bad host:443")).not.toContain("200");
  });

  it("refuses_private_names_and_addresses_without_the_test_switch", async () => {
    const target = await startTarget();
    const proxy = await startProxy({ EGRESS_MODE: "open" });
    expect((await viaProxy(proxy, `http://127.0.0.1:${target}/`)).status).toBe(403);
    expect((await viaProxy(proxy, `http://[::1]:${target}/`)).status).toBe(403);
    expect((await viaProxy(proxy, `http://0x7f.1:${target}/`)).status).toBe(403);
    expect((await viaProxy(proxy, `http://2130706433:${target}/`)).status).toBe(403);
    for (const target of [
      "localhost:443",
      "metadata:80",
      "metadata.google.internal:80",
      "host.docker.internal:80",
      "router:80",
      "nas.local:443",
      "169.254.169.254:80",
      "100.100.100.200:80",
      "100.101.102.103:22",
      "172.17.0.1:2375",
      "192.168.65.254:80",
      "10.0.0.1:443",
      "[::1]:443",
      "[::ffff:169.254.169.254]:80",
      "[64:ff9b::a9fe:a9fe]:80",
      "[2002:ac11:1::]:2375",
      "[fd7a:115c:a1e0::1]:443",
      "[fe80::1]:443",
    ]) {
      expect(await connectThrough(proxy, target), target).toBe("HTTP/1.1 403 Forbidden");
    }
  });

  it("caps_the_connections_open_at_once", async () => {
    const tcp = createTcp(() => {});
    servers.push(tcp);
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const port = (tcp.address() as { port: number }).port;
    const proxy = await startProxy({
      EGRESS_MODE: "open",
      EGRESS_ALLOW_PRIVATE: "1",
      EGRESS_MAX_CONNECTIONS: "1",
    });
    const first = await openTunnel(proxy, `127.0.0.1:${port}`);
    expect(first.line).toBe("HTTP/1.1 200 Connection Established");
    expect(await connectThrough(proxy, `127.0.0.1:${port}`)).toBe(
      "HTTP/1.1 503 Service Unavailable",
    );
    first.socket.destroy();
    await until(
      async () => (await connectThrough(proxy, `127.0.0.1:${port}`)).includes("200"),
      5000,
    );
  });

  it("caps_new_connections_per_minute_and_the_places_one_job_may_reach", async () => {
    const tcp = createTcp((s) => s.end("up"));
    servers.push(tcp);
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const port = (tcp.address() as { port: number }).port;
    const rate = await startProxy({
      EGRESS_MODE: "open",
      EGRESS_ALLOW_PRIVATE: "1",
      EGRESS_MAX_PER_MINUTE: "3",
    });
    for (let i = 0; i < 3; i++) {
      expect(await connectThrough(rate, `127.0.0.1:${port}`), String(i)).toContain("200");
    }
    // A fourth new connection within the minute: a scan or a flood from a friend's address.
    expect(await connectThrough(rate, `127.0.0.1:${port}`)).toBe("HTTP/1.1 429 Too Many Requests");
    expect((await viaProxy(rate, `http://127.0.0.1:${port}/`)).status).toBe(429);

    const places = await startProxy({
      EGRESS_MODE: "open",
      EGRESS_ALLOW_PRIVATE: "1",
      EGRESS_MAX_DESTINATIONS: "2",
    });
    expect(await connectThrough(places, `127.0.0.1:${port}`)).toContain("200");
    expect(await connectThrough(places, `localhost:${port}`)).toContain("200");
    // A third place is refused; the two it has been to stay open to it.
    expect(await connectThrough(places, `127.0.0.3:${port}`)).toBe(
      "HTTP/1.1 429 Too Many Requests",
    );
    expect(await connectThrough(places, `127.0.0.1:${port}`)).toContain("200");
  });

  it("cuts_everything_once_the_bytes_are_used_up_and_says_so_after", async () => {
    const big = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(256 * 1024, 7));
    });
    servers.push(big);
    await new Promise<void>((resolve) => big.listen(0, "127.0.0.1", resolve));
    const port = (big.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "egress-stats-"));
    const statsFile = join(dir, "egress.json");
    try {
      const proxy = await startProxy({
        EGRESS_MODE: "open",
        EGRESS_ALLOW_PRIVATE: "1",
        EGRESS_MAX_BYTES: String(32 * 1024),
        EGRESS_STATS: statsFile,
      });
      const cut = await rawThrough(proxy, `http://127.0.0.1:${port}/`);
      // Either the head made it and the body was cut short, or the connection went first.
      expect(cut.bytes).toBeLessThan(256 * 1024);
      const after = await viaProxy(proxy, `http://127.0.0.1:${port}/`);
      expect(after.status).toBe(403);
      expect(await connectThrough(proxy, `127.0.0.1:${port}`)).toBe("HTTP/1.1 403 Forbidden");
      await until(async () => {
        try {
          return parseEgressStats(readFileSync(statsFile, "utf8"))?.limited === true;
        } catch {
          return false;
        }
      }, 5000);
      const stats = parseEgressStats(readFileSync(statsFile, "utf8"));
      expect(stats?.bytes_in).toBeGreaterThan(32 * 1024);
      expect(stats?.total).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives_an_upstream_that_breaks_mid_stream", async () => {
    // Head and part of the body, then the socket is cut: answering 502 then would throw
    // ERR_HTTP_HEADERS_SENT and take the whole proxy down.
    const broken = createTcp((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100000\r\n\r\npartial");
        setTimeout(() => socket.destroy(), 50);
      });
    });
    servers.push(broken);
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const brokenPort = (broken.address() as { port: number }).port;
    const target = await startTarget();
    const proxy = await startProxy({ EGRESS_MODE: "open", EGRESS_ALLOW_PRIVATE: "1" });
    const first = await rawThrough(proxy, `http://127.0.0.1:${brokenPort}/`);
    expect(first.status).toBe(200);
    await rawThrough(proxy, `http://127.0.0.1:${brokenPort}/`);
    const ok = await viaProxy(proxy, `http://127.0.0.1:${target}/`);
    expect(ok.status).toBe(200);
  });
});

/** A plain request through the proxy, read to the close however it ends. */
function rawThrough(proxy: number, url: string): Promise<{ status: number; bytes: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect(proxy, "127.0.0.1", () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("error", () => {});
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(all.toString("latin1"))?.[1] ?? 0);
      resolve({ status, bytes: all.length });
    });
  });
}

/** A `CONNECT` left open. */
function openTunnel(proxy: number, target: string): Promise<{ line: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (data) =>
      resolve({ line: data.toString().split("\r\n")[0] ?? "", socket }),
    );
    socket.once("error", reject);
  });
}

async function until(check: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

describe("a network the host has no address on", () => {
  it("needs Docker 28 or newer", () => {
    for (const v of ["28.0.0", "28.3.2", "29.0.1+dfsg1", "v30.1.0"])
      expect(isolatesGateway(v), v).toBe(true);
    for (const v of ["27.5.1", "26.1.5+dfsg1", "20.10.24", "", "podman", null]) {
      expect(isolatesGateway(v), String(v)).toBe(false);
    }
  });

  it("finds this machine's own addresses inside a network's subnets", () => {
    const own = ["127.0.0.1", "10.1.0.4", "172.18.0.1", "fe80::1%eth0", "fd00:1::1"];
    expect(addressesInSubnets(["172.18.0.0/16"], own)).toEqual(["172.18.0.1"]);
    expect(addressesInSubnets(["fd00:1::/64", "bogus", "1.2.3.0/x"], own)).toEqual(["fd00:1::1"]);
    expect(addressesInSubnets(["192.0.2.0/24"], own)).toEqual([]);
  });
});

describe("egress arguments", () => {
  const instance = "0123456789abcdef";

  it("creates_an_internal_network_and_hardens_the_proxy_container", () => {
    expect(networkCreateArgs("n", instance)).toContain("--internal");
    expect(networkCreateArgs("n", instance)).toContain(
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    );
    const config = SandboxConfigSchema.parse({
      network: { allow: ["pypi.org", "*.pythonhosted.org"] },
    });
    const args = egressProxyArgs({
      name: "p",
      instance,
      image: "node:24-slim",
      network: config.network,
    });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-d"]);
    expect(at("--cap-drop")).toBe("ALL");
    expect(at("--user")).toBe("65534:65534");
    expect(args).toContain("--read-only");
    expect(at("--security-opt")).toBe("no-new-privileges");
    expect(at("--network")).toBe("bridge");
    expect(args).toContain("EGRESS_ALLOW=pypi.org,*.pythonhosted.org");
    expect(args).not.toContain("--privileged");
    // No bind mounts at all: the proxy sees nothing of the host.
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("-v");
    expect(args.slice(-3)).toEqual(["node", "-e", EGRESS_PROGRAM]);
  });

  it("gives_a_jobs_own_proxy_its_rules_counters_and_label", () => {
    const args = jobEgressProxyArgs({
      name: "miyoria-sbx-egress-01jabcdefghjkmnpqrstvwxyz0",
      instance: "i",
      job: "01jabcdefghjkmnpqrstvwxyz0",
      image: "miyoria/sandbox:1-abc",
      port: 3128,
      egress: {
        mode: "open",
        allow: [],
        denyPorts: [25, 465, 587, 0, 99999],
        maxConnections: 64,
        maxBytes: 4096 * 1024 * 1024,
        denyAddresses: ["172.17.0.1", "2a01:4f8::/32", "--privileged", "1.2.3.4,5"],
      },
    });
    const env = args.filter((_, i) => args[i - 1] === "--env");
    expect(env).toContain("EGRESS_MODE=open");
    expect(env).toContain("EGRESS_DENY_PORTS=25,465,587");
    expect(env).toContain("EGRESS_MAX_CONNECTIONS=64");
    expect(env).toContain(`EGRESS_MAX_BYTES=${4096 * 1024 * 1024}`);
    expect(env).toContain("EGRESS_DENY_ADDRS=172.17.0.1,2a01:4f8::/32");
    expect(env).toContain("EGRESS_STATS=/tmp/egress.json");
    expect(args).toContain(`${LABEL_JOB}=01jabcdefghjkmnpqrstvwxyz0`);
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp:rw,noexec,nosuid,nodev,size=1m");
    expect(args[args.indexOf("--memory") + 1]).toBe("64m");
    expect(args[args.indexOf("--cpus") + 1]).toBe("0.25");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).not.toContain("--mount");
    expect(args.slice(-3)).toEqual(["node", "-e", EGRESS_PROGRAM]);
  });

  it("reads_the_counters_and_ignores_anything_else", () => {
    expect(parseEgressStats("nope")).toBeNull();
    expect(
      parseEgressStats('{"bytes_in":5,"bytes_out":-1,"open":1,"total":2,"refused":{"port":3}}'),
    ).toEqual({
      bytes_in: 5,
      bytes_out: 0,
      open: 1,
      total: 2,
      refused: { address: 0, port: 3, cap: 0 },
      limited: false,
    });
  });

  it("points_a_run_at_the_proxy_and_never_adds_a_flag_for_a_closed_network", () => {
    const env = proxyEnv(3128);
    expect(env.HTTPS_PROXY).toBe(`http://${EGRESS_ALIAS}:3128`);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    const base = {
      name: "miyoria-sbx-x",
      image: "python:3.12-slim",
      labels: {},
      workDir: "/w",
      codeDir: "/c",
      toolsDir: null,
      user: "65534:65534",
      limits: defaultSandboxConfig().limits,
      command: ["python3"],
      env,
    };
    const closed = buildRunArgs(base);
    expect(closed[closed.indexOf("--network") + 1]).toBe("none");
    const open = buildRunArgs({ ...base, network: "miyoria-sbx-net-0123456789abcdef" });
    expect(open[open.indexOf("--network") + 1]).toBe("miyoria-sbx-net-0123456789abcdef");
    expect(() => buildRunArgs({ ...base, network: "--privileged" })).toThrow();
    for (const bad of ["host", "bridge", "container:abc", "default"]) {
      expect(() => buildRunArgs({ ...base, network: bad }), bad).toThrow();
    }
  });

  it("accepts_only_host_names_in_the_allowlist", () => {
    const parse = (allow: string[]) =>
      SandboxConfigSchema.safeParse({ network: { allow } }).success;
    expect(parse(["pypi.org", "*.pythonhosted.org", "github.com"])).toBe(true);
    expect(parse([])).toBe(true);
    for (const bad of [
      "*",
      "*.com",
      "https://pypi.org",
      "pypi.org:443",
      "pypi.org/x",
      "a b.com",
      "localhost",
      "-x.com",
    ]) {
      expect(parse([bad]), bad).toBe(false);
    }
    expect(defaultSandboxConfig().network.allow).toEqual([]);
  });
});
