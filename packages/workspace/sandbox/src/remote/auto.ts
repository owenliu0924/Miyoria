// `backend = "auto"` (docs/design/v6-sandbox.md §9.1): a computer of the cluster when one is
// ready, Docker on Core's own machine otherwise, so a setup without a sandbox service keeps
// working as it did. Both share her workspace and her tools. A session stays with the backend
// that opened it.

import type { DockerSandbox } from "../sandbox.js";
import {
  FRESH,
  type RunRequest,
  type RunResult,
  type Sandbox,
  SandboxError,
  type SandboxFeatures,
  type SandboxHealth,
  type SessionInfo,
} from "../types.js";
import type { RemoteSandbox } from "./remote-sandbox.js";

/** What the local backend offers. */
export function localFeatures(local: Pick<Sandbox, "networkAllow">): SandboxFeatures {
  return {
    where: "local",
    shell: false,
    network: local.networkAllow.length > 0 ? "allowlist" : "none",
    sessionWorkspace: false,
  };
}

/** Refusals of the cluster that the machine's own Docker can stand in for. */
const FALL_BACK = new Set(["unavailable", "not_accepting", "busy"]);

export class AutoSandbox implements Sandbox {
  readonly #local: DockerSandbox;
  readonly #remote: RemoteSandbox;

  constructor(local: DockerSandbox, remote: RemoteSandbox) {
    this.#local = local;
    this.#remote = remote;
  }

  get tools(): DockerSandbox["tools"] {
    return this.#local.tools;
  }

  get workspace(): DockerSandbox["workspace"] {
    return this.#local.workspace;
  }

  /** The cluster's while a computer is ready, else this machine's. */
  get features(): SandboxFeatures {
    return this.#remote.lastHealth.available ? this.#remote.features : localFeatures(this.#local);
  }

  get networkAllow(): readonly string[] {
    return this.#remote.lastHealth.available ? this.#remote.networkAllow : this.#local.networkAllow;
  }

  get lastHealth(): SandboxHealth {
    return this.#merge(this.#remote.lastHealth, this.#local.lastHealth);
  }

  #merge(remote: SandboxHealth, local: SandboxHealth): SandboxHealth {
    if (remote.available) return remote;
    if (local.available) return local;
    const checked =
      remote.checked_at === null || local.checked_at === null
        ? null
        : Math.max(remote.checked_at, local.checked_at);
    return {
      available: false,
      server_version: null,
      error: `叢集:${remote.error ?? "還在檢查"};這台的 Docker:${local.error ?? "還在檢查"}`,
      checked_at: checked,
    };
  }

  async health(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<SandboxHealth> {
    const [remote, local] = await Promise.all([
      this.#remote.health(options),
      this.#local.health(options),
    ]);
    return this.#merge(remote, local);
  }

  async #inRemote(name: string): Promise<boolean> {
    return (await this.#remote.listSessions()).some((s) => s.name === name);
  }

  async #inLocal(name: string): Promise<boolean> {
    return (await this.#local.listSessions()).some((s) => s.name === name);
  }

  /** The request as the local backend takes it: a session there never holds the workspace. */
  #forLocal(request: RunRequest): RunRequest {
    if (request.mount_workspace === true || request.workspace_folder === undefined) return request;
    const { workspace_folder: _, ...rest } = request;
    return rest;
  }

  async run(request: RunRequest, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const session = request.session ?? FRESH;
    if (session !== FRESH && (await this.#inLocal(session))) {
      return this.#local.run(this.#forLocal(request), options);
    }
    const remoteHas = session !== FRESH && (await this.#inRemote(session));
    if (remoteHas || this.#remote.lastHealth.available) {
      try {
        return await this.#remote.run(request, options);
      } catch (error) {
        const local = this.#local.lastHealth.available;
        if (
          remoteHas ||
          !local ||
          request.language === "shell" ||
          !(error instanceof SandboxError) ||
          !FALL_BACK.has(error.kind)
        ) {
          throw error;
        }
      }
    }
    return this.#local.run(this.#forLocal(request), options);
  }

  async listSessions(): Promise<SessionInfo[]> {
    const [remote, local] = await Promise.all([
      this.#remote.listSessions(),
      this.#local.listSessions(),
    ]);
    return [...local, ...remote].sort((a, b) => a.created_at - b.created_at);
  }

  async closeSession(name: string): Promise<boolean> {
    return (await this.#remote.closeSession(name)) || (await this.#local.closeSession(name));
  }
}
