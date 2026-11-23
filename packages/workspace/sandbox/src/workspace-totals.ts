// Her whole workspace with its counts kept, so a write near the caps stays fast: the files and
// their sizes come from one walk, refreshed now and then (`refreshMs`), and every write through
// the tools, every person's run (`replaceFolder`) and every remove keeps them up to date in
// between. A person's folder is then counted from the kept list, not by walking everyone's files
// again (`PersonWorkspace` lists its folder through `list`). What a program changed in a run of
// the whole workspace is not known here: the sandbox calls `invalidate` after one, and the next
// count walks again.

import { normalizeRelativePath } from "./paths.js";
import { PEOPLE_DIR, PERSON_FOLDER } from "./people.js";
import {
  PersistentWorkspace,
  type Removed,
  type WorkspaceEntry,
  type WorkspaceLimits,
  type WorkspaceUsage,
} from "./workspace-store.js";

/** How long one walk's counts are used at most (ms). */
export const TOTALS_REFRESH_MS = 5 * 60_000;

interface Totals {
  at: number;
  usage: WorkspaceUsage;
  /** Every listed file by its path. */
  files: Map<string, WorkspaceEntry>;
}

export interface CountedOptions {
  refreshMs?: number;
  now?: () => number;
}

/** `people/<folder>`, or a path under it, of a plain person's folder; else `null`. */
function personBase(prefix: string | undefined): string | null {
  const base = (prefix ?? "").replace(/\/+$/, "");
  const [top, folder] = base.split("/");
  if (top !== PEOPLE_DIR || folder === undefined || !PERSON_FOLDER.test(folder)) return null;
  try {
    return normalizeRelativePath(base) === base ? base : null;
  } catch {
    return null;
  }
}

export class CountedWorkspace extends PersistentWorkspace {
  readonly #refreshMs: number;
  readonly #now: () => number;
  #totals: Totals | null = null;
  #walking: Promise<Totals> | null = null;
  /** Bumped by every change, so a walk that raced one is not kept. */
  #generation = 0;

  constructor(
    dir: string,
    limits: WorkspaceLimits,
    ledgerFile?: string,
    options: CountedOptions = {},
  ) {
    super(dir, limits, ledgerFile);
    this.#refreshMs = options.refreshMs ?? TOTALS_REFRESH_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Forgets the counts: the next one walks the workspace. */
  invalidate(): void {
    this.#generation += 1;
    this.#totals = null;
  }

  async #counted(): Promise<Totals> {
    const kept = this.#totals;
    if (kept !== null && this.#now() - kept.at < this.#refreshMs) return kept;
    this.#walking ??= this.#walk().finally(() => {
      this.#walking = null;
    });
    return this.#walking;
  }

  async #walk(): Promise<Totals> {
    const generation = this.#generation;
    const at = this.#now();
    const usage = await super.usage();
    const listed = await super.list();
    const totals: Totals = {
      at,
      usage: { ...usage, overflow: usage.overflow || listed.truncated },
      files: new Map(listed.entries.map((e) => [e.path, e])),
    };
    if (generation === this.#generation) this.#totals = totals;
    return totals;
  }

  override async usage(): Promise<WorkspaceUsage> {
    return { ...(await this.#counted()).usage };
  }

  /** A person's folder from the kept list; anything else as the workspace lists it. */
  override async list(prefix?: string): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    const base = personBase(prefix);
    if (base === null) return super.list(prefix);
    const totals = await this.#counted();
    if (totals.usage.overflow) return super.list(prefix);
    const entries: WorkspaceEntry[] = [];
    for (const e of totals.files.values()) {
      if (e.path === base || e.path.startsWith(`${base}/`)) entries.push({ ...e });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { entries, truncated: false };
  }

  override async write(
    path: string,
    text: string,
    options?: { append?: boolean },
  ): Promise<WorkspaceEntry> {
    const entry = await super.write(path, text, options);
    this.#generation += 1;
    const totals = this.#totals;
    if (totals !== null) {
      const old = totals.files.get(entry.path);
      totals.files.set(entry.path, { ...entry });
      totals.usage.files += old === undefined ? 1 : 0;
      totals.usage.bytes += entry.size - (old?.size ?? 0);
    }
    return entry;
  }

  override async remove(path: string): Promise<boolean> {
    try {
      return await super.remove(path);
    } finally {
      this.invalidate();
    }
  }

  override async enforce(before?: ReadonlyMap<string, string>): Promise<Removed[]> {
    try {
      return await super.enforce(before);
    } finally {
      this.invalidate();
    }
  }

  /**
   * After a run of one person's folder (`people/<folder>`): its files are now `entries` (paths in
   * the folder), the rest of the counts stay.
   */
  replaceFolder(prefix: string, entries: readonly WorkspaceEntry[], truncated: boolean): void {
    this.#generation += 1;
    const totals = this.#totals;
    const base = personBase(prefix);
    if (totals === null) return;
    if (base === null || truncated) {
      this.#totals = null;
      return;
    }
    for (const [path, e] of totals.files) {
      if (path === base || path.startsWith(`${base}/`)) {
        totals.files.delete(path);
        totals.usage.files -= 1;
        totals.usage.bytes -= e.size;
      }
    }
    for (const e of entries) {
      const path = `${base}/${e.path}`;
      totals.files.set(path, { path, size: e.size });
      totals.usage.files += 1;
      totals.usage.bytes += e.size;
    }
  }
}
