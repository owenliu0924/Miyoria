// `Sandbox` on the computers of the cluster (docs/design/v6-sandbox.md §9): the gate, her tools,
// the file reader and `workspace_run` call it exactly as they call the local Docker backend.
//
// - A fresh run is a `run` job: opened, the call's folder sent in (when it mounts the workspace),
//   one exec, the changes back, closed.
// - A session is a `session` job that keeps the caller's folder at `/workspace`: before each exec
//   what changed on Core's side goes in, after it what the program changed comes back. Its execs
//   wait in Core, one at a time. Sessions are hers by name, each person's under a name of theirs
//   (`sessionView`, as before), `sessions.max` in all and `sessions.per_person` for each person.
// - Before a run starts, its payer over their CPU seconds gets the fixed sentence and nothing
//   runs (§8.3); during it the client stops it (`quota`).
// - What Core knows of each job is in `sandbox_jobs`: after a restart the sessions are found
//   again where they are still open.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import {
  type Clock,
  Events,
  newId,
  type Publish,
  systemClock,
  type WorkPayer,
  type WorkQuota,
} from "@miyoria/types";
import type { SandboxConfig } from "../config.js";
import { networkMode } from "../config.js";
import { Semaphore } from "../semaphore.js";
import {
  FRESH,
  type KilledReason,
  type Language,
  type RunFor,
  type RunLanguage,
  type RunRequest,
  RunRequestSchema,
  type RunResult,
  type Sandbox,
  SandboxError,
  type SandboxErrorKind,
  type SandboxFeatures,
  type SandboxHealth,
  SessionClosedError,
  type SessionCloseReason,
  type SessionInfo,
} from "../types.js";
import type { ToolsWorkspace } from "../workspace.js";
import type { Removed, WorkspaceLimits } from "../workspace-store.js";
import type { CountedWorkspace } from "../workspace-totals.js";
import { type HttpSandboxClient, SandboxClientError } from "./client.js";
import { closeReason, JobEndedError, type RemoteJob } from "./job.js";
import { decodePayer, type SandboxJobRow, type SandboxJobs } from "./jobs-store.js";
import {
  type CallWorkspace,
  type Manifest,
  pushChanges,
  receiveWorkspace,
  sendWorkspace,
} from "./transfer.js";
import { SandboxHttpError } from "./wire.js";

const log = getLogger("sandbox.remote");
const MIB = 1024 * 1024;
const MAX_TOMBSTONES = 32;

export interface RemoteSandboxOptions {
  client: HttpSandboxClient;
  /** The workspace (shared with the local backend under `auto`); `null` when it is off. */
  workspace: CountedWorkspace | null;
  tools: ToolsWorkspace;
  clock?: Clock;
  publisher?: Publish;
  /** Each person's CPU seconds (`WorkQuotaKey`), looked up at each run. */
  quota?: () => WorkQuota | null;
  jobs?: SandboxJobs | null;
}

interface Session {
  name: string;
  language: RunLanguage;
  /** What of the workspace it holds: `all`, `own`, `person:<folder>`. */
  scope: string;
  payer: WorkPayer | null;
  job: RemoteJob | null;
  manifest: Manifest | null;
  created_at: number;
  last_used_at: number;
  runs: number;
  lock: Semaphore;
  closed: SessionCloseReason | null;
}

/** A run request checked, its defaults filled. */
type Validated = Omit<RunRequest, "timeout_ms" | "session"> & {
  timeout_ms: number;
  session: string;
};

/** The fixed sentence of a payer at their limit (§8.3); no model is asked. */
export function quotaSentence(which: "hour" | "day", until: number, now: number): string {
  const ms = Math.max(0, until - now);
  return which === "hour"
    ? `你這個小時找我跑的程式有點多,大概 ${Math.max(1, Math.ceil(ms / 60_000))} 分鐘後再來。`
    : `你今天找我跑的程式有點多了,大概 ${Math.max(1, Math.ceil(ms / 3_600_000))} 個小時後再來。`;
}

/** What a run with `network` gets on a computer of the cluster. */
function networkOf(
  network: RunRequest["network"],
  config: SandboxConfig,
): { mode: "open" | "allowlist" | "none"; allow?: string[] } {
  if (network === undefined || network === "none") return { mode: "none" };
  if (network === "open") {
    const mode = networkMode(config.network);
    return mode === "allowlist" ? { mode, allow: [...config.network.allow] } : { mode };
  }
  return { mode: "allowlist", allow: network.allow.map((h) => h.toLowerCase()) };
}

/** The scope key of a run: whose folder, or her whole workspace without people's, or all of it. */
function scopeOf(r: { workspace_folder?: string | undefined; for?: string | undefined }): string {
  if (r.workspace_folder !== undefined) return `person:${r.workspace_folder}`;
  return r.for === "owner" ? "all" : "own";
}

/**
 * Whom a run is for: a person's folder is a member's run whatever the caller said, so their
 * files only go to a computer whose owner takes members' work.
 */
function whom(r: { workspace_folder?: string | undefined; for?: RunFor | undefined }): RunFor {
  return r.workspace_folder !== undefined ? "member" : (r.for ?? "self");
}

function sandboxError(error: unknown): unknown {
  if (error instanceof SandboxError) return error;
  if (error instanceof SandboxClientError) {
    const kind: SandboxErrorKind =
      error.code === "no_machine"
        ? "unavailable"
        : error.code === "unavailable"
          ? "unavailable"
          : error.code;
    return new SandboxError(kind, error.message, { cause: error });
  }
  if (error instanceof SandboxHttpError) {
    const kind: SandboxErrorKind =
      error.code === "busy"
        ? "busy"
        : error.code === "limit"
          ? "limit"
          : error.code === "bad_request" || error.code === "too_large"
            ? "invalid_request"
            : error.code === "unavailable"
              ? "unavailable"
              : "docker_failed";
    return new SandboxError(kind, `the sandbox computer refused: ${error.message}`, {
      cause: error,
    });
  }
  return error;
}

export class RemoteSandbox implements Sandbox {
  readonly tools: ToolsWorkspace;
  readonly workspace: CountedWorkspace | null;
  readonly features: SandboxFeatures;
  readonly #client: HttpSandboxClient;
  readonly #config: SandboxConfig;
  readonly #clock: Clock;
  readonly #publish: Publish;
  readonly #quota: () => WorkQuota | null;
  readonly #jobs: SandboxJobs | null;
  readonly #sessions = new Map<string, Session>();
  readonly #tombstones = new Map<string, SessionCloseReason>();
  readonly #closing = new AbortController();
  readonly #inFlight = new Set<Promise<unknown>>();
  #health: SandboxHealth = {
    available: false,
    server_version: null,
    error: null,
    checked_at: null,
  };
  #healthCheck: Promise<SandboxHealth> | null = null;

  constructor(config: SandboxConfig, o: RemoteSandboxOptions) {
    this.#config = config;
    this.#client = o.client;
    this.tools = o.tools;
    this.workspace = o.workspace;
    this.#clock = o.clock ?? systemClock;
    this.#publish = o.publisher ?? (() => {});
    this.#quota = o.quota ?? (() => null);
    this.#jobs = o.jobs ?? null;
    this.features = {
      where: "cluster",
      shell: true,
      network: networkMode(config.network),
      sessionWorkspace: o.workspace !== null,
    };
  }

  get client(): HttpSandboxClient {
    return this.#client;
  }

  get networkAllow(): readonly string[] {
    return networkMode(this.#config.network) === "allowlist" ? this.#config.network.allow : [];
  }

  get lastHealth(): SandboxHealth {
    return this.#health;
  }

  health(options: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<SandboxHealth> {
    const age =
      this.#health.checked_at === null
        ? Number.POSITIVE_INFINITY
        : this.#clock.now() - this.#health.checked_at;
    if (!options.refresh && age <= this.#config.health_ttl_ms) return Promise.resolve(this.#health);
    this.#healthCheck ??= (async () => {
      await this.#client.refresh({
        force: options.refresh === true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const machines = this.#client.machines();
      const ready = machines.filter((m) => m.ready);
      const available = ready.length > 0;
      this.#health = {
        available,
        server_version: available
          ? ready.map((m) => `${m.host} ${m.info?.service_version ?? "?"}`).join(", ")
          : null,
        error: available
          ? null
          : machines.length === 0
            ? "沒有任何電腦提供沙箱服務"
            : machines.map((m) => `${m.host}:${m.reason ?? "沙箱還沒準備好"}`).join(";"),
        checked_at: this.#clock.now(),
      };
      return this.#health;
    })().finally(() => {
      this.#healthCheck = null;
    });
    return this.#healthCheck;
  }

  /** The caps of one person's folder (`[modules.sandbox.workspace] person_*`). */
  #personLimits(root: CountedWorkspace): WorkspaceLimits {
    const ws = this.#config.workspace;
    return {
      maxBytes: Math.min(ws.person_max_mb * MIB, root.limits.maxBytes),
      maxFiles: Math.min(ws.person_max_files, root.limits.maxFiles),
      maxFileBytes: root.limits.maxFileBytes,
    };
  }

  /** The workspace a scope key reaches, or `null` when the workspace is off. */
  #callWorkspace(scope: string): CallWorkspace | null {
    const root = this.workspace;
    if (root === null) return null;
    if (scope.startsWith("person:")) {
      const folder = scope.slice("person:".length);
      return {
        root,
        scope: { kind: "person", folder },
        folder,
        limits: this.#personLimits(root),
      };
    }
    return {
      root,
      scope: scope === "all" ? { kind: "all" } : { kind: "own" },
      folder: null,
      limits: root.limits,
    };
  }

  #validate(request: RunRequest): Validated {
    const parsed = RunRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new SandboxError("invalid_request", `invalid run request: ${parsed.error.message}`);
    }
    const r = parsed.data;
    const caps = this.#config.caps;
    if (Buffer.byteLength(r.code, "utf8") > caps.max_code_bytes) {
      throw new SandboxError("invalid_request", `code is over ${caps.max_code_bytes} bytes`);
    }
    if (Buffer.byteLength(r.stdin ?? "", "utf8") > caps.max_stdin_bytes) {
      throw new SandboxError("invalid_request", `stdin is over ${caps.max_stdin_bytes} bytes`);
    }
    if ((r.files?.length ?? 0) > caps.max_files_in) {
      throw new SandboxError("invalid_request", `at most ${caps.max_files_in} input files`);
    }
    const timeout = r.timeout_ms ?? this.#config.default_timeout_ms;
    if (timeout > this.#config.max_timeout_ms) {
      throw new SandboxError(
        "invalid_request",
        `timeout_ms is over the maximum of ${this.#config.max_timeout_ms}`,
      );
    }
    const session = r.session ?? FRESH;
    if (session !== FRESH && r.mount_tools) {
      throw new SandboxError("invalid_request", "sessions do not mount /tools; use a fresh run");
    }
    if (r.workspace_folder !== undefined && r.mount_workspace !== true && session === FRESH) {
      throw new SandboxError("invalid_request", "workspace_folder needs mount_workspace");
    }
    if (r.mount_workspace && this.workspace === null) {
      throw new SandboxError("invalid_request", "the workspace is turned off");
    }
    return { ...(r as RunRequest), timeout_ms: timeout, session };
  }

  /** Refuses a run whose payer is at their limit, with the sentence for them. */
  #checkQuota(payer: WorkPayer | null): void {
    const quota = this.#quota();
    if (quota === null || payer === null) return;
    const now = this.#clock.now();
    const cap = quota.capped(payer, now);
    if (cap === null) return;
    throw new SandboxError("quota", quotaSentence(cap.which, cap.until, now));
  }

  async run(request: RunRequest, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    if (this.#closing.signal.aborted) throw new SandboxError("closed", "the sandbox is shut down");
    const r = this.#validate(request);
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.#closing.signal])
      : this.#closing.signal;
    const payer = r.payer ?? null;
    this.#checkQuota(payer);
    const task = (async () => {
      try {
        return r.session === FRESH
          ? await this.#runFresh(r, payer, signal)
          : await this.#runInSession(r, payer, signal);
      } catch (error) {
        throw sandboxError(error);
      }
    })();
    this.#inFlight.add(task);
    try {
      return await task;
    } finally {
      this.#inFlight.delete(task);
    }
  }

  #available(forWho: "self" | "owner" | "member"): void {
    const available = this.#client.available(forWho);
    if (available.ok) return;
    throw new SandboxError(
      available.code === "no_machine" ? "unavailable" : available.code,
      available.reason,
    );
  }

  /** The exec of a run, its result in `RunResult` form. */
  async #exec(
    job: RemoteJob,
    r: Validated,
    signal: AbortSignal,
  ): Promise<Omit<RunResult, "session">> {
    const runId = newId();
    const result = await job.exec(
      {
        program: { language: r.language, code: r.code },
        ...(r.stdin === undefined ? {} : { stdin: r.stdin }),
        ...(r.files === undefined ? {} : { files: r.files }),
        // Programs keep the `/work` they always had; a shell starts in the person's files.
        cwd: r.language === "shell" ? "/workspace" : "/work",
        timeout_ms: r.timeout_ms,
        collectFiles: true,
      },
      { signal },
    );
    return {
      run_id: runId,
      language: r.language,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdout_truncated: result.stdout_truncated,
      stderr_truncated: result.stderr_truncated,
      files_out: result.files_out,
      files_out_truncated: result.files_out_truncated,
      duration_ms: result.duration_ms,
      killed_reason: result.killed_reason as KilledReason | null,
      host: job.host,
      cpu_ms: result.cpu_ms,
    };
  }

  /** Publishes `sandbox.run.finished` (no code, no output). */
  #done(result: RunResult): RunResult {
    // `shell` is not in the event's language list yet; those runs are not announced.
    if (result.language !== "shell") {
      this.#publish(Events.SandboxRunFinished, {
        run_id: result.run_id,
        language: result.language as Language,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        killed_reason: result.killed_reason,
        files_out: result.files_out.length,
        session: result.session?.name ?? null,
        host: result.host ?? null,
        ...(result.cpu_ms === undefined ? {} : { cpu_ms: result.cpu_ms }),
      });
    }
    return result;
  }

  async #runFresh(r: Validated, payer: WorkPayer | null, signal: AbortSignal): Promise<RunResult> {
    const forWho = whom(r);
    this.#available(forWho);
    const ws = r.mount_workspace ? this.#callWorkspace(scopeOf(r)) : null;
    const job = await this.#client.open(
      {
        kind: "run",
        image: "default",
        for: forWho,
        payer,
        network: networkOf(r.network, this.#config),
        mounts: { tools: r.mount_tools === true },
        limits: { disk_mb: this.#config.sessions.disk_mb },
      },
      { signal, folder: ws === null ? null : scopeOf(r) },
    );
    try {
      if (r.mount_tools) await job.upload("tools", { dir: await this.tools.ensure() }, { signal });
      let manifest: Manifest = [];
      if (ws !== null) manifest = await sendWorkspace(job, ws, signal);
      const executed = await this.#exec(job, r, signal);
      let removed: Removed[] | undefined;
      let conflicts: string[] = [];
      if (ws !== null && job.endedReason === null) {
        const back = await receiveWorkspace(job, ws, manifest, signal);
        removed = back.removed;
        conflicts = back.conflicts;
      }
      return this.#done({
        ...executed,
        session: null,
        ...(removed === undefined ? {} : { workspace_removed: removed }),
        ...(conflicts.length === 0 ? {} : { workspace_conflicts: conflicts }),
      });
    } finally {
      await job.close();
    }
  }

  // ---- Sessions ----------------------------------------------------------------------------

  #tombstone(name: string, reason: SessionCloseReason): void {
    this.#tombstones.delete(name);
    this.#tombstones.set(name, reason);
    for (const old of this.#tombstones.keys()) {
      if (this.#tombstones.size <= MAX_TOMBSTONES) break;
      this.#tombstones.delete(old);
    }
  }

  /** Marks a session over: no new runs. `tombstone`: she is told when she next uses the name. */
  #markEnded(session: Session, reason: SessionCloseReason, tombstone: boolean): void {
    if (session.closed !== null) return;
    session.closed = reason;
    if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
    if (tombstone) this.#tombstone(session.name, reason);
    log.info({ session: session.name, reason, runs: session.runs }, "sandbox session closed");
    this.#publish(Events.SandboxSessionClosed, {
      name: session.name,
      reason,
      runs: session.runs,
      host: session.job?.host ?? null,
      ...(session.job === null ? {} : { cpu_ms: session.job.charged }),
    });
  }

  /** The session ended on its computer (idle, lifetime, lost): she is told once. */
  #watch(session: Session, job: RemoteJob): void {
    void job.ended.then(({ reason }) => {
      if (session.job !== job || session.closed !== null) return;
      this.#markEnded(session, closeReason(reason), true);
    });
  }

  #sessionFor(name: string, r: Validated, payer: WorkPayer | null): Session {
    const scope = scopeOf(r);
    let session = this.#sessions.get(name);
    if (session) {
      if (session.scope !== scope) {
        throw new SandboxError(
          "invalid_request",
          `session \`${name}\` holds other files (it was opened for someone else); use another name`,
        );
      }
      return session;
    }
    const gone = this.#tombstones.get(name);
    if (gone !== undefined) {
      this.#tombstones.delete(name);
      throw new SessionClosedError(name, gone);
    }
    const cfg = this.#config.sessions;
    if (cfg.max === 0) throw new SandboxError("limit", "sessions are turned off");
    if (this.#sessions.size >= cfg.max) {
      throw new SandboxError("limit", `at most ${cfg.max} sessions at once; close one first`);
    }
    if (scope.startsWith("person:")) {
      const mine = [...this.#sessions.values()].filter((s) => s.scope === scope).length;
      if (mine >= cfg.per_person) {
        throw new SandboxError(
          "limit",
          `at most ${cfg.per_person} sessions per person at once; close one first`,
        );
      }
    }
    const now = this.#clock.now();
    session = {
      name,
      language: r.language,
      scope,
      payer,
      job: null,
      manifest: null,
      created_at: now,
      last_used_at: now,
      runs: 0,
      lock: new Semaphore(1, this.#config.max_queued),
      closed: null,
    };
    this.#sessions.set(name, session);
    return session;
  }

  async #runInSession(
    r: Validated,
    payer: WorkPayer | null,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const name = r.session;
    const session = this.#sessionFor(name, r, payer);
    let unlock: (() => void) | null;
    try {
      unlock = await session.lock.acquire(signal);
    } catch (error) {
      if (session.closed !== null) throw new SessionClosedError(name, session.closed);
      throw new SandboxError("closed", "the run was cancelled while waiting", { cause: error });
    }
    if (unlock === null) {
      throw new SandboxError("busy", `session \`${name}\` has too many runs waiting`);
    }
    try {
      return await this.#sessionRun(session, r, payer, signal);
    } finally {
      unlock();
    }
  }

  async #sessionRun(
    session: Session,
    r: Validated,
    payer: WorkPayer | null,
    signal: AbortSignal,
  ): Promise<RunResult> {
    if (session.closed !== null) throw new SessionClosedError(session.name, session.closed);
    const ws = this.#callWorkspace(session.scope);
    let created = false;
    let job = session.job;
    if (job === null) {
      const forWho = whom(r);
      this.#available(forWho);
      try {
        job = await this.#client.open(
          {
            kind: "session",
            image: "default",
            for: forWho,
            payer,
            label: session.name,
            network: networkOf(r.network, this.#config),
          },
          { signal, folder: ws === null ? null : session.scope, name: session.name },
        );
      } catch (error) {
        // Never opened: the name is free again, nobody needs to be told.
        if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
        throw error;
      }
      session.job = job;
      this.#watch(session, job);
      created = true;
      log.info({ session: session.name, host: job.host }, "sandbox session started");
      // `shell` is not in the event's language list yet; those sessions are not announced.
      if (session.language !== "shell") {
        this.#publish(Events.SandboxSessionStarted, {
          name: session.name,
          language: session.language,
          host: job.host,
        });
      }
    }
    try {
      if (ws !== null) {
        session.manifest =
          session.manifest === null
            ? await sendWorkspace(job, ws, signal)
            : await pushChanges(job, ws, session.manifest, signal);
      }
      const executed = await this.#exec(job, r, signal);
      let removed: Removed[] | undefined;
      let conflicts: string[] = [];
      if (ws !== null && job.endedReason === null && session.manifest !== null) {
        const back = await receiveWorkspace(job, ws, session.manifest, signal);
        session.manifest = back.manifest;
        removed = back.removed;
        conflicts = back.conflicts;
        try {
          this.#jobs?.update(job.id, {
            manifest: back.manifest,
            updated_at: this.#clock.now(),
          });
        } catch (error) {
          log.debug({ err: errorMessage(error) }, "cannot remember a session's files");
        }
      }
      session.runs++;
      session.last_used_at = this.#clock.now();
      let closed: SessionCloseReason | null = null;
      if (job.endedReason !== null) {
        closed = closeReason(job.endedReason);
        this.#markEnded(session, closed, false);
      }
      return this.#done({
        ...executed,
        session: { name: session.name, created, closed },
        ...(removed === undefined ? {} : { workspace_removed: removed }),
        ...(conflicts.length === 0 ? {} : { workspace_conflicts: conflicts }),
      });
    } catch (error) {
      if (error instanceof JobEndedError || job.endedReason !== null) {
        const reason = closeReason(job.endedReason ?? "lost");
        this.#markEnded(session, reason, false);
        throw new SessionClosedError(session.name, reason);
      }
      throw error;
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const cfg = this.#config.sessions;
    return [...this.#sessions.values()]
      .sort((a, b) => a.created_at - b.created_at)
      .map((s) => ({
        name: s.name,
        language: s.language,
        created_at: s.created_at,
        last_used_at: s.last_used_at,
        runs: s.runs,
        disk_bytes:
          s.job?.view.usage.disk_bytes ?? (s.manifest ?? []).reduce((n, e) => n + e.size, 0),
        expires_at:
          s.job?.view.expires_at ??
          Math.min(
            s.last_used_at + cfg.idle_minutes * 60_000,
            s.created_at + cfg.lifetime_minutes * 60_000,
          ),
        busy: s.lock.waiting > 0 || (s.job?.busy ?? false),
      }));
  }

  async closeSession(name: string): Promise<boolean> {
    const session = this.#sessions.get(name);
    this.#tombstones.delete(name);
    if (!session) return false;
    const job = session.job;
    this.#markEnded(session, "closed", false);
    await job?.close();
    return true;
  }

  /**
   * After a restart of Core: her sessions still open on their computers come back (their files
   * as Core last knew them); the jobs nobody will use again are closed.
   */
  async restore(): Promise<number> {
    const store = this.#jobs;
    if (store === null) return 0;
    let rows: SandboxJobRow[];
    try {
      rows = store.open();
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read the open sandbox jobs");
      return 0;
    }
    const sessions = rows.filter((r) => r.kind === "session" && r.name !== null);
    await this.#client.dropLeftovers(rows.filter((r) => !sessions.includes(r)));
    let restored = 0;
    for (const row of sessions) {
      const name = row.name as string;
      const payer = row.payer === null ? null : decodePayer(row.payer);
      const job = await this.#client.reattach(row, payer);
      if (job === null) {
        this.#tombstone(name, "lost");
        continue;
      }
      const session: Session = {
        name,
        language: "shell",
        scope: row.folder ?? "own",
        payer,
        job,
        manifest: row.manifest,
        created_at: row.created_at,
        last_used_at: row.updated_at,
        runs: 0,
        lock: new Semaphore(1, this.#config.max_queued),
        closed: null,
      };
      this.#sessions.set(name, session);
      this.#watch(session, job);
      restored++;
    }
    if (restored > 0) log.info({ sessions: restored }, "sandbox sessions found again");
    return restored;
  }

  /** Stops new runs and waits for the running ones; the sessions stay open to their lease. */
  async close(): Promise<void> {
    this.#closing.abort(new SandboxError("closed", "the sandbox is shut down"));
    await Promise.allSettled([...this.#inFlight]);
    this.#client.close();
  }
}
