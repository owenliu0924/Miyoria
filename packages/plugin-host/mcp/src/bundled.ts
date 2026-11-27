// MCP servers an extension brings in its manifest (`[[mcp_servers]]`). They are connected while
// the extension is enabled, and a stdio one is started by the extension launcher where the
// extension itself runs (this machine, or the same sandbox job), with the extension's own
// environment: never Core's, and its credentials only by the same rule (`ext-host/src/env.ts`).
//
// The server is called `<extension>-<name>` (`miyoria_osu-queue`). The owner tunes it like any
// other server with an `[mcp.servers."<that name>"]` table without `command` / `url`: its tool
// filters, permission, `risk`, `trust_read_only_hint`, timeouts, `enabled`.

import { getLogger } from "@miyoria/runtime/kernel";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { defaultRunIn } from "../../ext-host/src/config.js";
import { extensionEnvReport, extensionSecrets } from "../../ext-host/src/env.js";
import { specEnv } from "../../ext-host/src/extension.js";
import type { CatalogMcpServer, ExtensionCatalog } from "../../ext-host/src/host.js";
import type { ExtensionLauncher, LaunchSpec } from "../../ext-host/src/launch.js";
import { ChildTransport } from "./child-transport.js";
import { ServerConfig } from "./config.js";

const log = getLogger("mcp.bundled");

/** A bundled server, ready for a `ServerRunner`. */
export interface BundledServer {
  name: string;
  config: ServerConfig;
  from: CatalogMcpServer;
  /** stdio: started by the launcher (`connect`); http: connected to its `url` as usual. */
  launch: boolean;
  connect(launcher: ExtensionLauncher, signal: AbortSignal): Promise<Transport>;
}

/** `<extension>-<name>`, in the characters a server name may have. */
export function bundledServerName(extension: string, name: string): string {
  return `${extension}-${name}`.replace(/[^A-Za-z0-9_-]/gu, "_");
}

/** What the launcher is asked to start for `server` (environment resolved from `source`). */
export function bundledLaunchSpec(
  server: CatalogMcpServer,
  source: NodeJS.ProcessEnv = process.env,
): LaunchSpec {
  const owner = server.owner;
  const m = owner.manifest;
  const env = extensionEnvReport(m.id, specEnv(owner), source).env;
  return {
    extension: m.id,
    dir: server.dir,
    runtime: "binary",
    program: server.spec.command ?? "",
    args: [...server.spec.args],
    cwd: server.dir,
    // Literal values of the manifest on top; the protocol variables are the extension's, not
    // this server's business, so they go.
    env: Object.fromEntries(
      Object.entries({ ...env, ...server.spec.env }).filter(
        ([k]) => k !== "MIYORIA_RPC" && k !== "MIYORIA_EXTENSION_ID",
      ),
    ),
    network: [...owner.granted.network],
    secrets: extensionSecrets(owner.secrets ?? [], source),
    runIn: owner.runIn ?? defaultRunIn(m.kind, owner.granted),
  };
}

/** The bundled servers of `catalog`, with the owner's settings for each applied. */
export function bundledServers(
  catalog: ExtensionCatalog,
  configured: ReadonlyMap<string, ServerConfig>,
): BundledServer[] {
  const out: BundledServer[] = [];
  const seen = new Set<string>();
  for (const from of catalog.mcpServers()) {
    const name = bundledServerName(from.extension, from.spec.name);
    const tuned = configured.get(name);
    if (seen.has(name) || (tuned && (tuned.command !== null || tuned.url !== null))) {
      log.warn({ server: name }, "a bundled MCP server's name is taken; it is not connected");
      continue;
    }
    seen.add(name);
    const base = tuned ? tuned.toData() : {};
    const config = new ServerConfig({
      ...base,
      transport: from.spec.command !== null ? "stdio" : "http",
      command: from.spec.command,
      args: [...from.spec.args],
      env: { ...from.spec.env },
      env_pass: [],
      cwd: from.dir,
      url: from.spec.url,
      headers: {},
      ...(tuned?.risk == null && from.spec.risk !== null ? { risk: from.spec.risk } : {}),
    });
    const launch = from.spec.command !== null;
    out.push({
      name,
      config,
      from,
      launch,
      async connect(launcher, signal) {
        const spec = bundledLaunchSpec(from);
        const child = launcher.launchInSame
          ? await launcher.launchInSame(from.extension, spec, signal)
          : await launcher.launch(spec, signal);
        child.stderr.on("data", (chunk: Buffer | string) => {
          for (const line of chunk.toString().split(/\r?\n/u)) {
            if (line !== "") log.debug({ server: name }, `stderr: ${line}`);
          }
        });
        return new ChildTransport(child);
      },
    });
  }
  return out;
}
