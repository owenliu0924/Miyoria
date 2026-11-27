// Browser sessions: one `browser` job per person and name (docs/design/v6-agent-split.md P6), on
// a computer of the cluster through `SandboxClient`, never a browser on Core's machine. The job
// runs one proc, the driver, spoken to over JSON-RPC (`rpc.ts`); its traffic leaves through the
// job's egress proxy like any program's.
//
// Bounded, each for a harm it prevents: `max_sessions` together (each is a container of
// `memory_mb` on someone's computer: a few people must not take them all), `per_person` each
// (opening another name closes that person's least recently used one), `idle_minutes` and
// `lifetime_minutes` (a forgotten session does not hold a machine). The job's own idle and
// lifetime on the computer are a little longer, so Core closes it first and the downloads come
// back to the person's folder before it goes; a job that ends on its own (the computer went away,
// its owner changed the rules) ends the session, and the next call says so.
//
// Whose: a session belongs to the reach of the call that opened it (`all`, `own` or one person's
// folder, as `people.ts` decides), so a member never steps into her session or another member's,
// and its cookies and logins stay theirs. It is paid for by whoever opened it.

import { getLogger } from "@miyoria/runtime/kernel";
import {
  type Clock,
  newId,
  type SandboxClient,
  type SandboxFor,
  type SandboxJob,
  type SandboxProc,
  systemClock,
  type WorkPayer,
} from "@miyoria/types";
import {
  type CallWorkspace,
  type Manifest,
  receiveWorkspace,
  type TransferJob,
} from "../remote/transfer.js";
import type { Removed } from "../workspace-store.js";
import type { BrowseConfig } from "./config.js";
import { DRIVER, DRIVER_ARGV, PingResultSchema, STEP_ENV, stepWaitMs } from "./protocol.js";
import { RpcClient } from "./rpc.js";

const log = getLogger("sandbox.browse");

/** The session a call without a name uses. */
export const DEFAULT_BROWSE_SESSION = "main";
/** What a session may be called. */
export const BROWSE_SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** How long the driver may take to start Chromium. */
export const START_TIMEOUT_MS = 90_000;
/** How much longer the job lives on the computer than Core keeps the session. */
const JOB_GRACE_S = 300;
/** Threads count as processes, and Chromium starts many. */
const BROWSER_PIDS = 1024;
/** How long closing waits for the downloads to come back. */
const COLLECT_TIMEOUT_MS = 60_000;
const MAX_TOMBSTONES = 200;
const MAX_STDERR_LOG = 2000;

/** Whose a session is, and what of the workspace its downloads go to. */
export interface BrowseOwner {
  /** `all`, `own` or `person:<folder>`. */
  key: string;
  for: SandboxFor;
  payer: WorkPayer | null;
  /** Where the downloads come back to; `null`: the workspace is off (they stay in the job). */
  workspace: CallWorkspace | null;
}

export type BrowseErrorKind = "full" | "gone" | "start" | "invalid";

/** A refusal she can pass on (`message` is her words). */
export class BrowseError extends Error {
  override readonly name = "BrowseError";

  constructor(
    readonly kind: BrowseErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Why a session ended, in her words. */
export const BROWSE_END: Readonly<Record<string, string>> = {
  closed: "關掉了",
  idle: "太久沒用,自己關掉了",
  lifetime: "開太久了,自己關掉了",
  lease: "那台電腦和這邊斷線了",
  lost: "那台電腦不見了",
  disk: "用的空間超過上限",
  shutdown: "那台電腦的沙箱服務停了",
  host_policy: "那台電腦的主人改了設定,不再接這種工作",
  exited: "瀏覽器自己結束了",
  replaced: "開了新的工作階段,這個最久沒用的先關掉了",
  quota: "因為你這陣子找我跑的東西有點多,先關掉了",
  stopped: "系統正在關閉",
};

function endWords(reason: string): string {
  return BROWSE_END[reason] ?? `結束了(${reason})`;
}

/** What closing a session brought back. */
export interface Collected {
  /** The downloads came back into the workspace. */
  collected: boolean;
  removed: Removed[];
  conflicts: string[];
}

export class BrowseSession {
  readonly owner: BrowseOwner;
  readonly name: string;
  readonly job: SandboxJob;
  readonly openedAt: number;
  usedAt: number;
  /** Order of last use (the clock can give two uses the same millisecond). */
  useSeq = 0;
  /** What Core knows the job's `/workspace` holds (after the last collect). */
  manifest: Manifest = [];
  readonly rpc: RpcClient;
  readonly proc: SandboxProc;
  #queue: Promise<unknown> = Promise.resolve();
  #ended: string | null = null;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  lifeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: {
    owner: BrowseOwner;
    name: string;
    job: SandboxJob;
    proc: SandboxProc;
    rpc: RpcClient;
    now: number;
  }) {
    this.owner = o.owner;
    this.name = o.name;
    this.job = o.job;
    this.proc = o.proc;
    this.rpc = o.rpc;
    this.openedAt = o.now;
    this.usedAt = o.now;
  }

  /** Why it ended, or `null` while it is open. */
  get ended(): string | null {
    return this.#ended;
  }

  markEnded(reason: string): void {
    if (this.#ended !== null) return;
    this.#ended = reason;
    this.rpc.close(endWords(reason));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.lifeTimer) clearTimeout(this.lifeTimer);
  }

  /** Runs `task` after everything queued before it (one step at a time in a browser). */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

export interface BrowseSessionsOptions {
  client: SandboxClient;
  config: BrowseConfig;
  clock?: Clock;
  /** How the downloads come back (P3's `receiveWorkspace`; tests swap it). */
  receive?: typeof receiveWorkspace;
  /**
   * The computers Core lets have members' work (`RemoteSandbox.memberHosts`): a member's
   * browser opens only there, since its downloads come back into their folder and a computer's
   * own word that it takes members is what a hostile one would say. Absent: no limit (tests).
   */
  memberHosts?: () => readonly string[];
}

/** Her words when no computer Core lets have members' work is there. */
export const BROWSE_MEMBERS_NOT_LISTED = "能跑程式的電腦現在都不接成員的工作;這次沒有開瀏覽器。";

/** Whether the job can hand its `/workspace` back (`RemoteJob` can). */
function canSync(job: SandboxJob): job is TransferJob {
  return typeof (job as Partial<TransferJob>).sync === "function";
}

/** One line of what the session is, for status and her `close` answer. */
export interface SessionLine {
  name: string;
  host: string;
  opened_at: number;
  used_at: number;
}

export class BrowseSessions {
  readonly #client: SandboxClient;
  readonly #config: BrowseConfig;
  readonly #clock: Clock;
  readonly #receive: typeof receiveWorkspace;
  readonly #sessions = new Map<string, BrowseSession>();
  /** Opens under way, by key: they count against the caps and are joined by the same call. */
  readonly #opening = new Map<string, Promise<BrowseSession>>();
  readonly #tombstones = new Map<string, string>();
  #uses = 0;
  #closed = false;

  constructor(o: BrowseSessionsOptions) {
    this.#client = o.client;
    this.#config = o.config;
    this.#clock = o.clock ?? systemClock;
    this.#receive = o.receive ?? receiveWorkspace;
    this.#memberHosts = o.memberHosts ?? null;
  }

  readonly #memberHosts: (() => readonly string[]) | null;

  static key(owner: string, name: string): string {
    return `${owner}\u0000${name}`;
  }

  /** How many are open (and opening) now. */
  get size(): number {
    return this.#sessions.size + this.#opening.size;
  }

  /** The open session of `owner` called `name`, or `null`. */
  get(owner: string, name: string): BrowseSession | null {
    const session = this.#sessions.get(BrowseSessions.key(owner, name)) ?? null;
    return session?.ended === null ? session : null;
  }

  /** Why `owner`'s `name` ended, when it did recently. */
  endedReason(owner: string, name: string): string | null {
    const reason = this.#tombstones.get(BrowseSessions.key(owner, name));
    return reason === undefined ? null : endWords(reason);
  }

  /** `owner`'s open sessions, least recently used first. */
  list(owner: string): SessionLine[] {
    return [...this.#sessions.values()]
      .filter((s) => s.owner.key === owner && s.ended === null)
      .sort((a, b) => a.useSeq - b.useSeq)
      .map((s) => ({ name: s.name, host: s.job.host, opened_at: s.openedAt, used_at: s.usedAt }));
  }

  /** Every open session, for the status lines. */
  all(): SessionLine[] {
    return [...this.#sessions.values()]
      .filter((s) => s.ended === null)
      .map((s) => ({ name: s.name, host: s.job.host, opened_at: s.openedAt, used_at: s.usedAt }));
  }

  /**
   * The session of `owner` called `name`, opened when there is none. `replaced`: the name of
   * theirs closed to make room (their `per_person` was reached). Throws `BrowseError` (`full`,
   * `start`) or what `SandboxClient.open` throws (no computer takes it).
   */
  async open(
    owner: BrowseOwner,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ session: BrowseSession; created: boolean; replaced: string | null }> {
    if (this.#closed) throw new BrowseError("gone", "瀏覽器正在關閉,這次沒有打開。");
    const key = BrowseSessions.key(owner.key, name);
    const open = this.get(owner.key, name);
    if (open !== null) return { session: open, created: false, replaced: null };
    const opening = this.#opening.get(key);
    if (opening !== undefined) return { session: await opening, created: false, replaced: null };

    let replaced: string | null = null;
    const theirs = this.list(owner.key);
    const theirsOpening = [...this.#opening.keys()].filter((k) =>
      k.startsWith(`${owner.key}\u0000`),
    ).length;
    if (theirs.length + theirsOpening >= this.#config.per_person) {
      const oldest = theirs[0];
      if (oldest === undefined) {
        throw new BrowseError("full", "你的瀏覽器工作階段正在開,等它開好再開下一個。");
      }
      const victim = this.get(owner.key, oldest.name);
      if (victim !== null) await this.close(victim, "replaced");
      replaced = oldest.name;
    }
    if (this.size >= this.#config.max_sessions) {
      throw new BrowseError(
        "full",
        this.#config.max_sessions === 0
          ? "主人沒有開放瀏覽器工作階段。"
          : `瀏覽器現在同時開著 ${this.size} 個(上限),都在用;稍後再試。`,
      );
    }
    const started = this.#start(owner, name, signal);
    this.#opening.set(key, started);
    try {
      const session = await started;
      this.#tombstones.delete(key);
      return { session, created: true, replaced };
    } finally {
      this.#opening.delete(key);
    }
  }

  async #start(owner: BrowseOwner, name: string, signal?: AbortSignal): Promise<BrowseSession> {
    const c = this.#config;
    const hosts =
      owner.for === "member" && this.#memberHosts !== null ? [...this.#memberHosts()] : null;
    if (hosts !== null && hosts.length === 0)
      throw new BrowseError("start", BROWSE_MEMBERS_NOT_LISTED);
    const job = await this.#client.open(
      {
        kind: "browser",
        image: "browser",
        for: owner.for,
        ...(hosts === null ? {} : { hosts }),
        payer: owner.payer,
        label: `browse ${name}`,
        limits: { cpus: c.cpus, memory_mb: c.memory_mb, pids: BROWSER_PIDS },
        lifetime_s: Math.round(c.lifetime_minutes * 60) + JOB_GRACE_S,
        idle_s: Math.round(c.idle_minutes * 60) + JOB_GRACE_S,
      },
      signal === undefined ? {} : { signal },
    );
    let proc: SandboxProc;
    let rpc: RpcClient;
    try {
      proc = await job.proc(newId().toLowerCase(), {
        argv: [...DRIVER_ARGV],
        cwd: "/workspace",
        env: { [STEP_ENV]: String(c.step_timeout_ms) },
      });
      rpc = new RpcClient(proc.stdin, proc.stdout);
      let logged = 0;
      proc.stderr.on("data", (chunk: Buffer) => {
        if (logged >= MAX_STDERR_LOG) return;
        const text = chunk.toString("utf8").slice(0, MAX_STDERR_LOG - logged);
        logged += text.length;
        log.debug({ job: job.id, text }, "browser driver stderr");
      });
      const ping = PingResultSchema.safeParse(
        await rpc.call(
          DRIVER.ping,
          {},
          { timeoutMs: START_TIMEOUT_MS, ...(signal ? { signal } : {}) },
        ),
      );
      if (!ping.success) throw new Error("the browser driver answered something else");
      log.info(
        { job: job.id, host: job.host, browser: ping.data.browser, session: name },
        "a browser session opened",
      );
    } catch (error) {
      await job.close().catch(() => undefined);
      if (signal?.aborted) throw error;
      log.warn({ job: job.id, err: (error as Error).message }, "the browser did not start");
      throw new BrowseError(
        "start",
        "瀏覽器在那台電腦上沒有啟動成功(可能是映像檔壞了或記憶體不夠);這次沒有打開。",
      );
    }
    const session = new BrowseSession({
      owner,
      name,
      job,
      proc,
      rpc,
      now: this.#clock.now(),
    });
    const key = BrowseSessions.key(owner.key, name);
    this.#sessions.set(key, session);
    session.lifeTimer = setTimeout(
      () => void this.close(session, "lifetime"),
      c.lifetime_minutes * 60_000,
    );
    session.lifeTimer.unref?.();
    this.#touch(session);
    void job.ended.then(({ reason }) => this.#gone(session, reason));
    // The proc ends with its job too: the job's reason says more than "it exited".
    void proc.exited.then(async () => {
      const grace = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000).unref?.());
      const ended = await Promise.race([job.ended, grace]);
      this.#gone(session, ended?.reason ?? "exited");
    });
    return session;
  }

  #touch(session: BrowseSession): void {
    session.usedAt = this.#clock.now();
    session.useSeq = ++this.#uses;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => void this.close(session, "idle"),
      this.#config.idle_minutes * 60_000,
    );
    session.idleTimer.unref?.();
  }

  /** The job or the driver went away without Core closing it: the session is over. */
  #gone(session: BrowseSession, reason: string): void {
    if (session.ended !== null) return;
    session.markEnded(reason);
    this.#forget(session, reason);
    log.info({ job: session.job.id, reason }, "a browser session ended");
    void session.job.close().catch(() => undefined);
  }

  #forget(session: BrowseSession, reason: string): void {
    const key = BrowseSessions.key(session.owner.key, session.name);
    if (this.#sessions.get(key) === session) this.#sessions.delete(key);
    this.#tombstones.delete(key);
    this.#tombstones.set(key, reason);
    for (const old of this.#tombstones.keys()) {
      if (this.#tombstones.size <= MAX_TOMBSTONES) break;
      this.#tombstones.delete(old);
    }
  }

  /**
   * One step in `session`, after the ones before it. Throws `BrowseError("gone")` when the
   * session is over, `RpcError` / `RpcClosedError` from the driver.
   */
  call(
    session: BrowseSession,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return session.serial(async () => {
      if (session.ended !== null) {
        throw new BrowseError(
          "gone",
          `瀏覽器工作階段「${session.name}」${endWords(session.ended)}。`,
        );
      }
      this.#touch(session);
      try {
        return await session.rpc.call(method, params, {
          timeoutMs: stepWaitMs(this.#config.step_timeout_ms),
          ...(signal === undefined ? {} : { signal }),
        });
      } finally {
        this.#touch(session);
      }
    });
  }

  /**
   * What the job saved in `/workspace` (the downloads) comes into the owner's folder now. Nothing
   * happens without a workspace or a job that can hand it back.
   */
  collect(session: BrowseSession, signal?: AbortSignal): Promise<Collected> {
    return session.serial(() => this.#collect(session, signal));
  }

  async #collect(session: BrowseSession, signal?: AbortSignal): Promise<Collected> {
    const ws = session.owner.workspace;
    const job = session.job;
    if (ws === null || !canSync(job) || session.ended !== null) {
      return { collected: false, removed: [], conflicts: [] };
    }
    const bounded = AbortSignal.timeout(COLLECT_TIMEOUT_MS);
    const back = await this.#receive(
      job,
      ws,
      session.manifest,
      signal === undefined ? bounded : AbortSignal.any([signal, bounded]),
    );
    session.manifest = back.manifest;
    return { collected: true, removed: back.removed, conflicts: back.conflicts };
  }

  /** Closes `session`: its downloads come back first, then the job goes. */
  async close(session: BrowseSession, reason = "closed"): Promise<Collected> {
    if (session.ended !== null) return { collected: false, removed: [], conflicts: [] };
    // Always asked, not only after a reported download: one may finish after its step answered.
    const result = await this.collect(session).catch((error: unknown) => {
      log.warn(
        { job: session.job.id, err: (error as Error).message },
        "downloads did not come back",
      );
      return { collected: false, removed: [], conflicts: [] } satisfies Collected;
    });
    session.markEnded(reason);
    this.#forget(session, reason);
    await session.proc.kill().catch(() => undefined);
    await session.job.close().catch(() => undefined);
    log.info({ job: session.job.id, reason }, "a browser session closed");
    return result;
  }

  /** Closes every session (module stop). */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions.values()].map((s) => this.close(s, "stopped")));
  }
}
