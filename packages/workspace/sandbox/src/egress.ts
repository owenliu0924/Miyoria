// The way out of the sandbox for runs that ask for the network. Docker cannot filter by host
// name, so the mechanism is topology plus one small proxy:
//
// * an `--internal` Docker network (no route to anything outside Docker) holds the run
//   container and the proxy container;
// * the proxy container (the node image running `EGRESS_PROGRAM`) is on the default bridge as
//   well, so it is the only thing that can reach the internet;
// * the run gets `HTTP_PROXY` / `HTTPS_PROXY` pointing at the proxy. A program that ignores them
//   has no other route; the proxy never connects to a private, loopback, link-local, tailnet or
//   metadata address, or to an address this machine itself has (it resolves the name itself and
//   connects to the address it checked, so a DNS answer cannot change in between).
//
// Two ways to run it. `allowlist` (the local backend's, today's default): only the listed hosts on
// ports 80 and 443. `open` (a sandbox service job, docs/design/v6-sandbox.md §5): any public host,
// except the mail ports, with a cap on connections and on bytes per job.
//
// Everything here is argument building and the proxy's source; starting it is `DockerSandbox` or
// the sandbox service.

import { BlockList, isIP } from "node:net";
import { LABEL, LABEL_INSTANCE, LABEL_KIND, NAME_PREFIX } from "./args.js";
import type { SandboxNetwork } from "./config.js";

/** Alias the proxy has on the internal network (what `HTTP_PROXY` names). */
export const EGRESS_ALIAS = "egress-proxy";

/** Label carrying the sandbox service's job id on a job's container, network and proxy. */
export const LABEL_JOB = "miyoria.sandbox.job";

/** Where the proxy writes its counters (inside its own container, a 1 MiB tmpfs). */
export const EGRESS_STATS_FILE = "/tmp/egress.json";

/** Ports `open` refuses unless told otherwise: SMTP, so nobody mails through a friend's line. */
export const DEFAULT_DENY_PORTS: readonly number[] = [25, 465, 587];

/** The instance's shared network (local backend), or a job's own one (`job` given). */
export function egressNetworkName(instance: string, job?: string): string {
  return job === undefined ? `${NAME_PREFIX}net-${instance}` : `${NAME_PREFIX}net-${job}`;
}

/** The instance's shared proxy (local backend), or a job's own one (`job` given). */
export function egressProxyName(instance: string, job?: string): string {
  return job === undefined ? `${NAME_PREFIX}egress-${instance}` : `${NAME_PREFIX}egress-${job}`;
}

/** Environment a run on the egress network gets (the proxy is its only way out). */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://${EGRESS_ALIAS}:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: "",
    no_proxy: "",
  };
}

/** The bridge options that decide whether the host has an address on the network. */
export const GATEWAY_MODE_IPV4 = "com.docker.network.bridge.gateway_mode_ipv4";
export const GATEWAY_MODE_IPV6 = "com.docker.network.bridge.gateway_mode_ipv6";

/** The first Docker Engine whose `internal` bridges take gateway mode `isolated` (28.0.0). */
export const ISOLATED_GATEWAY_DOCKER = 28;

/**
 * Whether Docker `version` (`{{.Server.Version}}`, e.g. `28.3.2`, `29.0.1+dfsg1`) can create a
 * network the host has no address on. Older engines ignore the option without a word, so the
 * network would still lead to every service the lending machine listens on at 0.0.0.0.
 */
export function isolatesGateway(version: string | null): boolean {
  const major = /^\s*v?(\d+)\./.exec(version ?? "")?.[1];
  return major !== undefined && Number(major) >= ISOLATED_GATEWAY_DOCKER;
}

/**
 * `docker network create --internal` with gateway mode `isolated`: containers on it have no route
 * out, and the host has no address on it. A plain internal bridge keeps the host's gateway
 * address (`172.x.y.1`), and a program that connects to it reaches whatever this machine listens
 * on at 0.0.0.0 (sshd, hostd, the sandbox service itself, admin pages); the proxy is a peer on
 * the network, so no gateway is needed.
 */
export function networkCreateArgs(name: string, instance: string, job?: string): string[] {
  return [
    "network",
    "create",
    "--internal",
    "--opt",
    `${GATEWAY_MODE_IPV4}=isolated`,
    "--opt",
    `${GATEWAY_MODE_IPV6}=isolated`,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL_INSTANCE}=${instance}`,
    ...(job === undefined ? [] : ["--label", `${LABEL_JOB}=${job}`]),
    name,
  ];
}

export function networkInspectArgs(name: string): string[] {
  return ["network", "inspect", "--format", "{{.Name}}", name];
}

/** Prints the network's IPv4 gateway mode (`isolated` when it was made by `networkCreateArgs`). */
export function networkGatewayModeArgs(name: string): string[] {
  return ["network", "inspect", "--format", `{{index .Options "${GATEWAY_MODE_IPV4}"}}`, name];
}

/** Prints the network's subnets, space-separated. */
export function networkSubnetsArgs(name: string): string[] {
  return ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", name];
}

/**
 * Which of `addresses` (this machine's own, `os.networkInterfaces()`) lie in one of `subnets`:
 * on Linux the bridge's own address shows there, so a non-empty answer means the network leads
 * to this machine whatever Docker was told.
 */
export function addressesInSubnets(
  subnets: readonly string[],
  addresses: readonly string[],
): string[] {
  const list = new BlockList();
  for (const subnet of subnets) {
    const [net, bits] = subnet.split("/");
    const family = isIP(net ?? "");
    if (family === 0 || bits === undefined || !/^\d{1,3}$/.test(bits)) continue;
    list.addSubnet(net as string, Number(bits), family === 6 ? "ipv6" : "ipv4");
  }
  return addresses.filter((a) => {
    const plain = a.split("%")[0] as string;
    const family = isIP(plain);
    return family !== 0 && list.check(plain, family === 6 ? "ipv6" : "ipv4");
  });
}

export function networkRemoveArgs(name: string): string[] {
  return ["network", "rm", name];
}

/** Puts the proxy on the internal network under `EGRESS_ALIAS`. */
export function networkConnectArgs(network: string, container: string): string[] {
  return ["network", "connect", "--alias", EGRESS_ALIAS, network, container];
}

/** `docker exec` that succeeds once the proxy accepts connections (inside its container). */
export function egressReadyArgs(name: string, port: number): string[] {
  const probe =
    `require("net").connect(${port}, "127.0.0.1")` +
    `.on("connect", () => process.exit(0)).on("error", () => process.exit(1))`;
  return ["exec", name, "node", "-e", probe];
}

/** `docker exec` printing the proxy's counters (`EGRESS_STATS_FILE`). */
export function egressStatsArgs(name: string): string[] {
  return ["exec", name, "cat", EGRESS_STATS_FILE];
}

/** What the proxy counts (`EGRESS_STATS_FILE`). */
export interface EgressStats {
  bytes_in: number;
  bytes_out: number;
  /** Connections open now. */
  open: number;
  /** Connections made in all. */
  total: number;
  refused: { address: number; port: number; cap: number };
  /** The byte cap was reached: everything was cut, and nothing more goes out. */
  limited: boolean;
}

/** The counters the proxy wrote, or `null` when the text is not them. */
export function parseEgressStats(text: string): EgressStats | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const refused = (typeof r.refused === "object" && r.refused !== null ? r.refused : {}) as Record<
    string,
    unknown
  >;
  return {
    bytes_in: n(r.bytes_in),
    bytes_out: n(r.bytes_out),
    open: n(r.open),
    total: n(r.total),
    refused: { address: n(refused.address), port: n(refused.port), cap: n(refused.cap) },
    limited: r.limited === true,
  };
}

/** The hardening every proxy container gets (its own program, not hers, but on the bridge). */
function proxyHardening(memoryMb: number, cpus: number): string[] {
  return [
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--network",
    "bridge",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=1m",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "none",
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    "64",
    "--init",
  ];
}

/**
 * `docker run -d` of the proxy: the node image, read-only, no capabilities, non-root, small.
 * It starts on the default bridge (the way out); `networkConnectArgs` then adds the internal
 * network. The allowlist travels in its environment, the program in `node -e`.
 */
export function egressProxyArgs(options: {
  name: string;
  instance: string;
  image: string;
  network: SandboxNetwork;
}): string[] {
  const { name, instance, image, network } = options;
  return [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL_INSTANCE}=${instance}`,
    "--label",
    `${LABEL_KIND}=egress`,
    ...proxyHardening(network.proxy_memory_mb, 0.5),
    "--env",
    `EGRESS_ALLOW=${network.allow.join(",")}`,
    "--env",
    `EGRESS_PORT=${network.proxy_port}`,
    image,
    "node",
    "-e",
    EGRESS_PROGRAM,
  ];
}

/** What one job's proxy lets through (`JobCreate.network`, after the machine's own checks). */
export interface JobEgress {
  mode: "open" | "allowlist";
  /** `allowlist` only: host names and `*.suffix` patterns. */
  allow: readonly string[];
  /** Refused in both modes. */
  denyPorts: readonly number[];
  maxConnections: number;
  /** In and out together; 0 = no cap. */
  maxBytes: number;
  /**
   * Addresses refused on top of the built-in table, as `address` or `address/prefix`: this
   * machine's own addresses and Docker's gateways, which are public on some machines (a global
   * IPv6 prefix) and would otherwise reach the services listening on it.
   */
  denyAddresses: readonly string[];
}

const ADDRESS_ENTRY = /^[0-9a-f:.]{2,45}(\/\d{1,3})?$/i;

/**
 * `docker run -d` of one job's own proxy (`miyoria-sbx-egress-<job>`): same hardening as the
 * shared one, 64 MiB and a quarter of a CPU, its counters in `EGRESS_STATS_FILE`.
 */
export function jobEgressProxyArgs(options: {
  name: string;
  instance: string;
  job: string;
  image: string;
  egress: JobEgress;
  port: number;
}): string[] {
  const { name, instance, job, image, egress, port } = options;
  const deny = egress.denyAddresses.filter((a) => ADDRESS_ENTRY.test(a));
  const env: Record<string, string> = {
    EGRESS_MODE: egress.mode,
    EGRESS_ALLOW: egress.allow.join(","),
    EGRESS_DENY_PORTS: egress.denyPorts
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
      .join(","),
    EGRESS_MAX_CONNECTIONS: String(Math.max(1, Math.floor(egress.maxConnections))),
    EGRESS_MAX_BYTES: String(Math.max(0, Math.floor(egress.maxBytes))),
    EGRESS_DENY_ADDRS: deny.join(","),
    EGRESS_STATS: EGRESS_STATS_FILE,
    EGRESS_PORT: String(port),
  };
  const args = [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL_INSTANCE}=${instance}`,
    "--label",
    `${LABEL_KIND}=egress`,
    "--label",
    `${LABEL_JOB}=${job}`,
    ...proxyHardening(64, 0.25),
  ];
  for (const [key, value] of Object.entries(env)) {
    if (/[\0\r\n]/.test(value)) throw new Error(`bad egress setting ${key}`);
    args.push("--env", `${key}=${value}`);
  }
  args.push(image, "node", "-e", EGRESS_PROGRAM);
  return args;
}

/**
 * The proxy. Plain JavaScript (`node -e`), no dependencies. Environment:
 *
 * - `EGRESS_MODE`: `allowlist` (default) or `open`;
 * - `EGRESS_ALLOW`: comma separated hosts and `*.suffix` patterns (`allowlist`);
 * - `EGRESS_PORTS`: ports a target may have in `allowlist`, default `80,443`;
 * - `EGRESS_DENY_PORTS`: ports refused in both modes (default `25,465,587` in `open`);
 * - `EGRESS_MAX_CONNECTIONS` (default 64), `EGRESS_MAX_BYTES` (in + out, default no cap);
 * - `EGRESS_DENY_ADDRS`: addresses or CIDRs refused on top of the built-in table;
 * - `EGRESS_STATS`: a file the counters are written to every second, when they changed;
 * - `EGRESS_PORT` (0 = any, printed on stdout);
 * - `EGRESS_ALLOW_PRIVATE=1`: tests only, turns the built-in name and address tables off (the
 *   deny list still holds) so a test can reach loopback.
 *
 * The address table is `isBlockedAddress` of `packages/workspace/web/src/net.ts` and more (the
 * test runs both on the same addresses): IPv4 private, loopback, link-local, CGNAT and tailnet,
 * benchmarking, documentation, multicast and reserved; IPv6 unspecified, loopback, IPv4-mapped,
 * -compatible and -translated, NAT64 (both prefixes), 6to4, Teredo and the rest of 2001::/23,
 * documentation, discard, ULA, link-local, site-local and multicast. An IPv6 form that carries an
 * IPv4 address is judged by that address. Anything that does not parse is refused.
 */
export const EGRESS_PROGRAM = String.raw`
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const dns = require("dns").promises;
const env = process.env;
const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const mode = env.EGRESS_MODE === "open" ? "open" : "allowlist";
const allow = list(env.EGRESS_ALLOW);
const ports = new Set(list(env.EGRESS_PORTS || "80,443").map(Number));
const denyPorts = new Set(list(env.EGRESS_DENY_PORTS !== undefined ? env.EGRESS_DENY_PORTS : mode === "open" ? "25,465,587" : "").map(Number));
const maxConnections = Number(env.EGRESS_MAX_CONNECTIONS) >= 1 ? Math.floor(Number(env.EGRESS_MAX_CONNECTIONS)) : 64;
const maxBytes = Number(env.EGRESS_MAX_BYTES) > 0 ? Number(env.EGRESS_MAX_BYTES) : Infinity;
const statsFile = env.EGRESS_STATS || "";
const allowPrivate = env.EGRESS_ALLOW_PRIVATE === "1";
const CONNECT_MS = 30000;
const IDLE_MS = 300000;
const LOOKUP_MS = 10000;
const LIMIT_TEXT = "the network traffic of this job is used up";

function v4(text) {
  const p = text.split(".");
  if (p.length !== 4) return null;
  const out = [];
  for (const s of p) {
    if (!/^(0|[1-9]\d{0,2})$/.test(s)) return null;
    const n = Number(s);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}
function v6(text) {
  if (text.includes("%") || !net.isIPv6(text)) return null;
  let head = text;
  let tail = [];
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const q = v4(text.slice(colon + 1));
    if (q === null) return null;
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    head = text.slice(0, colon + 1);
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const group = (s) => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const gap = head.indexOf("::");
  let g;
  if (gap === -1) g = group(head).concat(tail);
  else {
    const l = group(head.slice(0, gap));
    const r = group(head.slice(gap + 2)).concat(tail);
    const fill = 8 - l.length - r.length;
    if (fill < 1) return null;
    g = l.concat(new Array(fill).fill(0), r);
  }
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return null;
  return g;
}
function blocked4(a) {
  const o1 = a[0], o2 = a[1], o3 = a[2];
  return o1 === 0 || o1 === 10 || (o1 === 100 && o2 >= 64 && o2 <= 127) || o1 === 127 ||
    (o1 === 169 && o2 === 254) || (o1 === 172 && o2 >= 16 && o2 <= 31) ||
    (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) || (o1 === 192 && o2 === 88 && o3 === 99) ||
    (o1 === 192 && o2 === 168) || (o1 === 198 && (o2 === 18 || o2 === 19)) ||
    (o1 === 198 && o2 === 51 && o3 === 100) || (o1 === 203 && o2 === 0 && o3 === 113) || o1 >= 224;
}
// true: refused; false: a public IPv6 address; an array: the IPv4 address it carries.
function blocked6(w) {
  const emb = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const z4 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0;
  if (z4 && w[4] === 0 && w[5] === 0xffff) return emb(w[6], w[7]);
  if (z4 && w[4] === 0 && w[5] === 0) return true;
  if (z4 && w[4] === 0xffff && w[5] === 0) return emb(w[6], w[7]);
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) return emb(w[6], w[7]);
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true;
  if (w[0] === 0x2002) return emb(w[1], w[2]);
  if (w[0] === 0x2001 && w[1] < 0x200) return true;
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true;
  if (w[0] === 0x3fff && w[1] < 0x1000) return true;
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;
  if ((w[0] & 0xfe00) === 0xfc00) return true;
  if ((w[0] & 0xffc0) === 0xfe80) return true;
  if ((w[0] & 0xffc0) === 0xfec0) return true;
  if ((w[0] & 0xff00) === 0xff00) return true;
  return false;
}
function bytes6(g) {
  const b = [];
  for (const x of g) b.push(x >> 8, x & 255);
  return b;
}
const denyNets = list(env.EGRESS_DENY_ADDRS).map((entry) => {
  const parts = entry.split("/");
  const a4 = v4(parts[0]);
  const g = a4 === null ? v6(parts[0]) : null;
  const b = a4 !== null ? a4 : g !== null ? bytes6(g) : null;
  if (b === null) return null;
  const bits = parts.length === 1 ? b.length * 8 : Number(parts[1]);
  if (!(Number.isInteger(bits) && bits >= 0 && bits <= b.length * 8)) return null;
  return { b, bits };
}).filter(Boolean);
function inNet(b, n) {
  if (b.length !== n.b.length) return false;
  let bits = n.bits;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const m = bits >= 8 ? 255 : (255 << (8 - bits)) & 255;
    if ((b[i] & m) !== (n.b[i] & m)) return false;
  }
  return true;
}
function refusedAddress(addr) {
  let b4 = v4(addr);
  if (b4 === null) {
    const g = v6(addr);
    if (g === null) return true;
    const r = blocked6(g);
    if (r === true && !allowPrivate) return true;
    if (denyNets.some((n) => inNet(bytes6(g), n))) return true;
    if (!Array.isArray(r)) return false;
    b4 = r;
  }
  if (!allowPrivate && blocked4(b4)) return true;
  return denyNets.some((n) => inNet(b4, n));
}
const NAME = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const DENY_NAMES = new Set(["localhost", "metadata", "instance-data", "metadata.google.internal"]);
const DENY_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home", ".arpa"];
function hostOf(raw) {
  let h = String(raw || "").toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (net.isIP(h) !== 0) return h;
  if (h.length === 0 || h.length > 253 || !NAME.test(h)) return null;
  return h;
}
function nameRefused(h) {
  if (net.isIP(h) !== 0) return false;
  // A single label is resolved through the machine's search domains: the LAN's, not the internet's.
  return DENY_NAMES.has(h) || DENY_SUFFIXES.some((s) => h.endsWith(s)) || !h.includes(".");
}
function hostOk(h) {
  return allow.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

const stats = { bytes_in: 0, bytes_out: 0, open: 0, total: 0, refused: { address: 0, port: 0, cap: 0 }, limited: false };
const live = new Set();
const clients = new Set();
let closedIn = 0;
let closedOut = 0;
let pending = 0;
function used() {
  let i = closedIn;
  let o = closedOut;
  for (const s of live) { i += s.bytesRead; o += s.bytesWritten; }
  stats.bytes_in = i;
  stats.bytes_out = o;
  stats.open = live.size;
  return i + o;
}
function check() {
  if (stats.limited) return;
  if (used() <= maxBytes) return;
  stats.limited = true;
  for (const s of live) s.destroy();
  for (const c of clients) c.destroy();
  writeStats();
}
function track(s) {
  live.add(s);
  stats.total++;
  s.on("data", check);
  s.once("close", () => {
    if (live.delete(s)) { closedIn += s.bytesRead; closedOut += s.bytesWritten; }
    stats.open = live.size;
  });
  stats.open = live.size;
}
function full() {
  return pending + live.size >= maxConnections;
}
function refusal(host, port) {
  if (host === null) { stats.refused.address++; return "host not allowed"; }
  if (!(Number.isInteger(port) && port >= 1 && port <= 65535) || denyPorts.has(port) || (mode === "allowlist" && !ports.has(port))) {
    stats.refused.port++;
    return "port not allowed";
  }
  if ((mode === "allowlist" && !hostOk(host)) || (!allowPrivate && nameRefused(host))) {
    stats.refused.address++;
    return "host not allowed";
  }
  return null;
}
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]).finally(() => clearTimeout(timer));
}
// One lookup; every address it gives must pass, and only those addresses are connected to.
async function resolve(host) {
  const addrs = net.isIP(host) !== 0 ? [host] : (await withTimeout(dns.lookup(host, { all: true, verbatim: true }), LOOKUP_MS)).map((x) => x.address);
  if (addrs.length === 0) throw new Error("no address");
  if (addrs.some(refusedAddress)) throw new Error("address not allowed");
  // IPv4 first: the plain-HTTP path connects to the first address only (the bridge has no IPv6).
  return addrs.sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
}
function connectAny(addrs, port, onSocket, done) {
  const [first, ...rest] = addrs;
  const socket = net.connect({ host: first, port });
  onSocket(socket);
  socket.setTimeout(CONNECT_MS, () => socket.destroy(new Error("timeout")));
  const failed = () => {
    socket.destroy();
    if (rest.length > 0) connectAny(rest, port, onSocket, done); else done(null);
  };
  socket.once("error", failed);
  socket.once("connect", () => {
    socket.removeListener("error", failed);
    socket.on("error", () => socket.destroy());
    socket.setTimeout(IDLE_MS);
    done(socket);
  });
}
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"]);
function forwardHeaders(headers) {
  const named = String(headers.connection || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP.has(k) || k.startsWith("proxy-") || named.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

async function handle(req, res) {
  const deny = (code, text) => {
    // Once the head went out a status can no longer be sent: the only honest answer is to cut it.
    if (res.headersSent || res.writableEnded || res.destroyed) { res.destroy(); return; }
    res.writeHead(code, { "content-type": "text/plain", connection: "close" });
    res.end(text);
  };
  if (stats.limited) return deny(403, LIMIT_TEXT);
  let url;
  try { url = new URL(req.url); } catch { return deny(400, "absolute URL needed"); }
  if (url.protocol !== "http:") return deny(400, "only http:// URLs; https goes through CONNECT");
  const host = hostOf(url.hostname);
  const port = Number(url.port || 80);
  const why = refusal(host, port);
  if (why !== null) return deny(403, why);
  if (full()) { stats.refused.cap++; return deny(503, "too many connections"); }
  pending++;
  let counted = true;
  const release = () => { if (counted) { counted = false; pending--; } };
  let addrs;
  try { addrs = await resolve(host); } catch { release(); stats.refused.address++; return deny(403, "host not allowed"); }
  if (res.destroyed || stats.limited) { release(); return deny(403, LIMIT_TEXT); }
  const headers = forwardHeaders(req.headers);
  headers.host = url.host;
  const out = http.request({ host: addrs[0], port, path: url.pathname + url.search, method: req.method, headers, agent: false, setHost: false });
  clients.add(req.socket);
  const done = () => { release(); clients.delete(req.socket); };
  out.on("socket", (s) => {
    s.setTimeout(CONNECT_MS, () => s.destroy(new Error("timeout")));
    s.once("connect", () => { release(); track(s); s.setTimeout(IDLE_MS); });
    s.once("close", release);
  });
  out.on("response", (r) => {
    const head = forwardHeaders(r.headers);
    try { res.writeHead(r.statusCode || 502, head); } catch { out.destroy(); return deny(502, "upstream failed"); }
    r.on("error", () => res.destroy());
    r.on("aborted", () => res.destroy());
    r.on("data", check);
    r.pipe(res);
  });
  out.on("error", () => { done(); deny(502, "upstream failed"); });
  out.on("close", done);
  res.on("close", () => out.destroy());
  req.on("error", () => out.destroy());
  req.on("data", check);
  req.pipe(out);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(() => { try { res.destroy(); } catch {} });
});
server.on("connect", (req, client, head) => {
  client.on("error", () => client.destroy());
  const refuse = (line) => { if (!client.destroyed) client.end("HTTP/1.1 " + line + "\r\n\r\n"); };
  if (stats.limited) return refuse("403 Forbidden");
  const m = /^(.+):(\d{1,5})$/.exec(req.url || "");
  if (!m) return refuse("400 Bad Request");
  const host = hostOf(m[1]);
  const port = Number(m[2]);
  if (refusal(host, port) !== null) return refuse("403 Forbidden");
  if (full()) { stats.refused.cap++; return refuse("503 Service Unavailable"); }
  pending++;
  let counted = true;
  const release = () => { if (counted) { counted = false; pending--; } };
  let upstream = null;
  clients.add(client);
  client.once("close", () => { release(); clients.delete(client); if (upstream !== null) upstream.destroy(); });
  resolve(host).then((addrs) => {
    if (client.destroyed) return release();
    connectAny(addrs, port, (s) => { upstream = s; }, (socket) => {
      if (socket === null) { release(); return refuse("502 Bad Gateway"); }
      if (client.destroyed || stats.limited) { release(); socket.destroy(); return refuse("403 Forbidden"); }
      release();
      track(socket);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
      client.on("data", check);
      socket.on("close", () => client.destroy());
      client.setTimeout(IDLE_MS, () => client.destroy());
    });
  }, () => { release(); stats.refused.address++; refuse("403 Forbidden"); });
});
server.on("clientError", (_err, socket) => socket.destroy());
server.maxConnections = maxConnections * 4 + 16;
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 5000;

let lastStats = "";
function writeStats() {
  if (statsFile === "") return;
  used();
  const text = JSON.stringify(stats);
  if (text === lastStats) return;
  lastStats = text;
  fs.writeFile(statsFile + ".tmp", text, (err) => { if (!err) fs.rename(statsFile + ".tmp", statsFile, () => {}); });
}
setInterval(() => { check(); writeStats(); }, 1000);
// One bad socket must not take the job's only way out with it.
process.on("uncaughtException", (err) => { console.error("egress: " + (err && err.message)); });
server.listen(Number(env.EGRESS_PORT || 3128), "0.0.0.0", () => {
  writeStats();
  console.log("listening " + server.address().port);
});
`;
