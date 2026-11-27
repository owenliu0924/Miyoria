import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { actuatorsFor } from "@miyoria/gate/actions";
import {
  defineManifest,
  type EndpointSource,
  type EndpointsOption,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  sleep,
} from "@miyoria/runtime/kernel";
import { SettingsStoreKey, StoreKey } from "@miyoria/store";
import { FileReaderKey, type ProfileId, SandboxClientKey, WorkQuotaKey } from "@miyoria/types";
import { workspaceAttachCapability } from "./attach.js";
import { BrowseOffer, browseCapabilities } from "./browse/index.js";
import { type SandboxConfig, SandboxConfigSchema } from "./config.js";
import { SandboxFileReader } from "./files.js";
import { featuresOf, SandboxGate } from "./gate.js";
import { ProposedTools, ProposedToolsKey } from "./proposed.js";
import { AutoSandbox } from "./remote/auto.js";
import { HttpSandboxClient } from "./remote/client.js";
import { type SandboxJobs, sandboxJobsTables } from "./remote/jobs-store.js";
import { RemoteSandbox } from "./remote/remote-sandbox.js";
import { type DockerRunner, ProcessDockerRunner } from "./runner.js";
import { DockerSandbox } from "./sandbox.js";
import { type Sandbox, type SandboxHealth, SandboxKey } from "./types.js";
import { workspaceEditCapabilities } from "./workspace-edit.js";

export interface SandboxModuleOptions {
  /** Directory `root` resolves against (the directory of `miyoria.toml`). */
  baseDir: string;
  /** Docker CLI runner; default spawns `config.docker` (tests inject a fake). */
  runner?: (executable: string) => DockerRunner;
  /** Core's endpoint registry: the computers of the cluster that run the `sandbox` service. */
  endpoints?: EndpointsOption;
}

/** Where the key that hides payers from the computers is kept (`SettingsStore`). */
const PAYER_KEY = "sandbox:payer-key";

/** A registry with no computers, for `backend = "cluster"` without the cluster. */
const NO_ENDPOINTS: EndpointSource = {
  pick: () => null,
  candidates: () => [],
  failed: () => {},
  request: () => Promise.reject(new Error("no cluster")),
  watch: () => () => {},
};

/** A sandbox and its last health without checking. */
type Checked = Sandbox & {
  readonly lastHealth: SandboxHealth;
  health(options?: { signal?: AbortSignal; refresh?: boolean }): Promise<SandboxHealth>;
};

/**
 * Module `sandbox`: provides `SandboxKey` (the code sandbox and the profile's tools workspace)
 * and, with the settings store, `ProposedToolsKey`. Opt-in (`enabled = true`).
 *
 * `[modules.sandbox] backend` picks where runs go (docs/design/v6-sandbox.md §9.1): `local` is
 * Docker on this machine, as before; `cluster` the `sandbox` service of the computers of the
 * cluster (it also provides `SandboxClientKey`, for the browser and the extensions); `auto`
 * (the default) the cluster while a computer is ready, else this machine's Docker.
 *
 * The local backend: at start it checks Docker in the background, removes containers this
 * instance left behind, prunes old run and session workspaces, then fills the warm pool (only
 * with `pool_size` > 0). Without Docker it runs degraded until Docker comes back.
 *
 * The cluster backend: at start the sessions of a former run of Core still open on their
 * computers are found again (`sandbox_jobs`); the other jobs it left are closed.
 *
 * While the sandbox is available it registers `code.run`, `code.session`, `tool.propose`, on the
 * cluster `shell.run`, and one `sbx.<name>` per approved tool she wrote, in the app's actuator
 * registry (see `gate.ts`); they are withdrawn when it goes away (re-checked every `recheck_ms`
 * and whenever the computers change).
 */
export class SandboxModule implements Module {
  static readonly ID = "sandbox";
  readonly manifest = defineManifest(SandboxModule.ID, "Code sandbox", {
    icon: "terminal",
    category: "system",
    description: "Runs code she writes in disposable Docker containers, here or on the cluster",
    configSchema: SandboxConfigSchema,
  });
  #sandbox: Checked | null = null;
  #local: DockerSandbox | null = null;
  #remote: RemoteSandbox | null = null;
  #gate: SandboxGate | null = null;
  #removeStatus: (() => void) | null = null;
  #browse: BrowseOffer | null = null;
  #removeBrowseStatus: (() => void) | null = null;
  #unwatch: (() => void) | null = null;

  constructor(
    readonly profile: ProfileId,
    readonly options: SandboxModuleOptions,
  ) {}

  /** The payer key: kept in the settings store so ids stay the same across restarts. */
  async #payerKey(ctx: ModuleContext): Promise<Uint8Array> {
    const store = ctx.services.get(SettingsStoreKey);
    try {
      const kept = await store?.get(this.profile, PAYER_KEY);
      if (typeof kept === "string" && /^[0-9a-f]{64}$/.test(kept)) return Buffer.from(kept, "hex");
      const key = randomBytes(32);
      await store?.set(this.profile, PAYER_KEY, key.toString("hex"));
      return key;
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "cannot keep the sandbox payer key");
      return randomBytes(32);
    }
  }

  #jobs(ctx: ModuleContext): SandboxJobs | null {
    try {
      return ctx.services.get(StoreKey)?.plugin(sandboxJobsTables) ?? null;
    } catch (error) {
      ctx.log.warn(
        { err: errorMessage(error) },
        "no sandbox_jobs table; sessions do not survive a restart",
      );
      return null;
    }
  }

  async #remoteBackend(ctx: ModuleContext, config: SandboxConfig, local: DockerSandbox) {
    const source =
      this.options.endpoints?.(ctx.services) ??
      (config.backend === "cluster" ? NO_ENDPOINTS : null);
    if (source === null) return null;
    const jobs = this.#jobs(ctx);
    const quota = () => ctx.services.get(WorkQuotaKey) ?? null;
    const client = new HttpSandboxClient({
      endpoints: source,
      config,
      clock: ctx.clock,
      payerKey: await this.#payerKey(ctx),
      jobs,
      quota,
    });
    return new RemoteSandbox(config, {
      client,
      workspace: local.workspace,
      tools: local.tools,
      clock: ctx.clock,
      publisher: ctx.publisher,
      quota,
      jobs,
    });
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(SandboxConfigSchema);
    const runner = (this.options.runner ?? ((exe) => new ProcessDockerRunner(exe)))(config.docker);
    const publisher = ctx.publisher;
    // The local backend owns her workspace and tools; the cluster's shares them.
    const local = new DockerSandbox(config, {
      root: resolve(this.options.baseDir, config.root),
      profile: this.profile,
      runner,
      clock: ctx.clock,
      publisher,
    });
    this.#local = local;
    const remote =
      config.backend === "local" ? null : await this.#remoteBackend(ctx, config, local);
    this.#remote = remote;
    const sandbox: Checked =
      remote === null
        ? local
        : config.backend === "cluster"
          ? remote
          : new AutoSandbox(local, remote);
    const useLocal = sandbox !== remote;
    this.#sandbox = sandbox;
    ctx.provide(SandboxKey, sandbox);
    if (remote !== null) ctx.provide(SandboxClientKey, remote.client);
    if (config.files.enabled) {
      ctx.provide(
        FileReaderKey,
        new SandboxFileReader({ sandbox, config: config.files, clock: ctx.clock }),
      );
    }
    const store = ctx.services.get(SettingsStoreKey);
    let tools: ProposedTools | null = null;
    if (store) {
      tools = new ProposedTools({
        store,
        profile: this.profile,
        sandbox,
        clock: ctx.clock,
        publisher,
        maxTools: config.max_proposed_tools,
        maxCodeBytes: config.caps.max_code_bytes,
      });
      ctx.provide(ProposedToolsKey, tools);
    } else {
      ctx.log.warn("no settings store; proposed tools are unavailable");
    }

    const registry = actuatorsFor(ctx);
    const people = {
      maxBytes: config.workspace.person_max_mb * 1024 * 1024,
      maxFiles: config.workspace.person_max_files,
    };
    const gate = new SandboxGate(registry, {
      sandbox,
      tools,
      resultChars: config.result_chars,
      toolTimeoutMs: config.tool_timeout_ms,
      readChars: config.workspace.read_chars,
      keepOutputs: config.workspace.keep_outputs,
      people,
      exportMaxBytes: config.workspace.export_max_kb * 1024,
      maxTimeoutMs: config.max_timeout_ms,
      sessionIdleMinutes: config.sessions.idle_minutes,
      sessionLifetimeMinutes: config.sessions.lifetime_minutes,
      // Host-side file tools: offered with the workspace, whether or not any sandbox answers.
      extraWorkspace: (o) => [
        ...workspaceEditCapabilities(o),
        workspaceAttachCapability({
          workspace: o.workspace,
          people: o.people ?? people,
          maxBytes: config.workspace.max_file_kb * 1024,
          allowedHosts: config.files.allowed_hosts,
          downloadTimeoutMs: config.files.download_timeout_ms,
        }),
      ],
      ...(remote === null
        ? {}
        : {
            machineLines: () =>
              remote.client.machines().map((m) => {
                const policy = m.info?.policy;
                const who =
                  policy === undefined ? "" : policy.members ? ",接成員的工作" : ",只接她和主人的";
                return `沙箱電腦 ${m.host}:${m.ready ? "準備好了" : (m.reason ?? "還在檢查")}${who}${m.jobs > 0 ? `,開著 ${m.jobs} 個工作` : ""}`;
              }),
          }),
    });
    this.#gate = gate;
    gate.offerWorkspace();
    this.#removeStatus = registry.addStatus(SandboxModule.ID, () =>
      gate.statusLines(sandbox.lastHealth),
    );
    // The browser follows its own availability (a computer with the browser image), so it is
    // offered apart from the gate and updated after every check.
    const browse =
      remote === null
        ? null
        : new BrowseOffer(
            registry,
            browseCapabilities({
              client: remote.client,
              // Read from the call's services: the host provides the work quota later.
              quota: null,
              workspace: local.workspace,
              people,
              config: config.browser,
              resultChars: config.result_chars,
              clock: ctx.clock,
            }),
          );
    this.#browse = browse;
    if (browse !== null) {
      this.#removeBrowseStatus = registry.addStatus(`${SandboxModule.ID}.browse`, () => [
        browse.statusLine(),
      ]);
    }
    // Proposals and reviews (her own, the owners' API) change which tools are offered.
    const toolEvents = ctx.subscribe(["sandbox.tool.*"]);
    ctx.spawn("tools", async () => {
      for await (const _ of toolEvents) await gate.refreshTools();
    });

    const recheck = async (signal: AbortSignal) => {
      const health = await sandbox.health({ signal, refresh: true });
      await gate.setAvailable(health.available);
      browse?.update({ available: health.available, features: featuresOf(sandbox) });
      return health;
    };
    if (remote !== null) {
      // The computers changed (one came, went, got ready): offer or withdraw right away.
      let pending = false;
      this.#unwatch = remote.client.watch(() => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          recheck(AbortSignal.timeout(30_000)).catch((error: unknown) => {
            ctx.log.debug({ err: errorMessage(error) }, "sandbox recheck failed");
          });
        });
      });
    }

    ctx.spawn("startup", async (signal) => {
      // Leftovers of an earlier process go first, then the warm pool starts (once Docker answers).
      let reaped = false;
      const reapOnce = async () => {
        if (reaped || !useLocal || !local.lastHealth.available) return;
        await local.reap(signal);
        reaped = true;
        local.warm();
      };
      try {
        if (remote !== null) await remote.restore();
        await recheck(signal);
        await reapOnce();
        if (useLocal) await local.prune();
      } catch (error) {
        if (!signal.aborted)
          ctx.log.warn({ err: errorMessage(error) }, "sandbox startup checks failed");
      }
      // Offer the capabilities only while the sandbox answers.
      while (!signal.aborted) {
        try {
          await sleep(config.recheck_ms, signal);
          await recheck(signal);
          await reapOnce();
        } catch (error) {
          if (signal.aborted) return;
          ctx.log.warn({ err: errorMessage(error) }, "sandbox health check failed");
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.#unwatch?.();
    this.#unwatch = null;
    this.#removeStatus?.();
    this.#removeStatus = null;
    this.#gate?.close();
    this.#gate = null;
    this.#removeBrowseStatus?.();
    this.#removeBrowseStatus = null;
    // Sessions bring their downloads back and close their jobs through the client, so first.
    await this.#browse?.close().catch(() => undefined);
    this.#browse = null;
    const local = this.#local;
    const remote = this.#remote;
    this.#sandbox = null;
    this.#local = null;
    this.#remote = null;
    await Promise.all([local?.close(), remote?.close()]);
  }

  async health(): Promise<Health> {
    const sandbox = this.#sandbox;
    if (!sandbox) return { status: "unhealthy", reason: "not running" };
    const health = sandbox.lastHealth;
    const what = sandbox === this.#local ? "docker" : "the sandbox";
    if (health.checked_at === null) return { status: "degraded", reason: `checking ${what}` };
    if (!health.available) {
      return { status: "degraded", reason: `${what} unavailable: ${health.error ?? "unknown"}` };
    }
    return HEALTHY;
  }
}
