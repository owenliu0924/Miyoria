// What Core remembers of the jobs it opened on the computers of the cluster (the `sandbox` store
// plugin, `sandbox_jobs`, docs/design/v6-sandbox.md §9.3), so a restart of Core finds its
// sessions again instead of leaving them to their lease. Plain SQL on the store's connection:
// the Drizzle definition the migration is checked against is in the store's `schema-sql.ts`.

import type { Db, StorePlugin } from "@miyoria/store";
import type { SandboxJobKind, WorkPayer } from "@miyoria/types";
import type { PackedEntry } from "../tar-io.js";
import { sandboxSchema } from "./jobs-migrations.js";

export interface SandboxJobRow {
  id: string;
  /** The computer and the service that holds the job. */
  host: string;
  service: string;
  kind: SandboxJobKind;
  /** A session's real name (`sessionView`), a plugin's id. */
  name: string | null;
  /** What of the workspace the job holds: `all`, `own` or `person:<folder>`; `null`: none. */
  folder: string | null;
  /** Who pays (`encodePayer`); `null`: nobody. */
  payer: string | null;
  for: string;
  state: "open" | "ended";
  ended_reason: string | null;
  /** What the job's `/workspace` holds as Core last knew it. */
  manifest: PackedEntry[] | null;
  /** CPU already charged to the payer, milliseconds. */
  cpu_ms: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

/** The rows of `sandbox_jobs` (times are epoch milliseconds). */
export interface SandboxJobs {
  open(): SandboxJobRow[];
  get(id: string): SandboxJobRow | null;
  insert(row: SandboxJobRow): void;
  update(
    id: string,
    patch: Partial<Pick<SandboxJobRow, "manifest" | "cpu_ms" | "expires_at" | "updated_at">>,
  ): void;
  end(id: string, reason: string, at: number): void;
  /** Ended rows older than `before` go. */
  prune(before: number): number;
}

/** The payer column: the person's key, with `exempt` kept beside it. */
export function encodePayer(payer: WorkPayer | null): string | null {
  if (payer === null) return null;
  return JSON.stringify(
    payer.exempt === true ? { person: payer.person, exempt: true } : { person: payer.person },
  );
}

export function decodePayer(text: string): WorkPayer | null {
  try {
    const parsed = JSON.parse(text) as { person?: unknown; exempt?: unknown };
    if (typeof parsed.person !== "string") return null;
    return parsed.exempt === true
      ? { person: parsed.person, exempt: true }
      : { person: parsed.person };
  } catch {
    return { person: text };
  }
}

function manifestOf(text: unknown): PackedEntry[] | null {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as PackedEntry[]) : null;
  } catch {
    return null;
  }
}

function rowOf(r: Record<string, unknown>): SandboxJobRow {
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    host: String(r.host),
    service: String(r.service),
    kind: String(r.kind) as SandboxJobKind,
    name: text(r.name),
    folder: text(r.folder),
    payer: text(r.payer),
    for: String(r.for),
    state: r.state === "ended" ? "ended" : "open",
    ended_reason: text(r.ended_reason),
    manifest: manifestOf(r.manifest),
    cpu_ms: Number(r.cpu_ms ?? 0),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    expires_at: Number(r.expires_at),
  };
}

export class SandboxJobsTable implements SandboxJobs {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  open(): SandboxJobRow[] {
    return this.#db
      .all("SELECT * FROM sandbox_jobs WHERE state = 'open' ORDER BY created_at")
      .map((r) => rowOf(r));
  }

  get(id: string): SandboxJobRow | null {
    const r = this.#db.get("SELECT * FROM sandbox_jobs WHERE id = $id", { id });
    return r === undefined ? null : rowOf(r);
  }

  insert(row: SandboxJobRow): void {
    this.#db.run(
      `INSERT INTO sandbox_jobs (id, host, service, kind, name, folder, payer, "for", state,
         ended_reason, manifest, cpu_ms, created_at, updated_at, expires_at)
       VALUES ($id, $host, $service, $kind, $name, $folder, $payer, $for, $state,
         $ended_reason, $manifest, $cpu_ms, $created_at, $updated_at, $expires_at)`,
      {
        id: row.id,
        host: row.host,
        service: row.service,
        kind: row.kind,
        name: row.name,
        folder: row.folder,
        payer: row.payer,
        for: row.for,
        state: row.state,
        ended_reason: row.ended_reason,
        manifest: row.manifest === null ? null : JSON.stringify(row.manifest),
        cpu_ms: Math.round(row.cpu_ms),
        created_at: Math.round(row.created_at),
        updated_at: Math.round(row.updated_at),
        expires_at: Math.round(row.expires_at),
      },
    );
  }

  update(
    id: string,
    patch: Partial<Pick<SandboxJobRow, "manifest" | "cpu_ms" | "expires_at" | "updated_at">>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id };
    if (patch.manifest !== undefined) {
      sets.push("manifest = $manifest");
      params.manifest = patch.manifest === null ? null : JSON.stringify(patch.manifest);
    }
    for (const key of ["cpu_ms", "expires_at", "updated_at"] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${key} = $${key}`);
      params[key] = Math.round(value);
    }
    if (sets.length === 0) return;
    this.#db.run(`UPDATE sandbox_jobs SET ${sets.join(", ")} WHERE id = $id`, params);
  }

  end(id: string, reason: string, at: number): void {
    this.#db.run(
      "UPDATE sandbox_jobs SET state = 'ended', ended_reason = $reason, updated_at = $at WHERE id = $id AND state = 'open'",
      { id, reason, at: Math.round(at) },
    );
  }

  prune(before: number): number {
    return this.#db.run("DELETE FROM sandbox_jobs WHERE state = 'ended' AND updated_at < $before", {
      before: Math.round(before),
    });
  }
}

/** The `sandbox` plugin: `store.plugin(sandboxJobsTables)`. */
export const sandboxJobsTables: StorePlugin<SandboxJobsTable> = {
  schema: sandboxSchema,
  open: ({ db }) => new SandboxJobsTable(db),
};

/** The rows in memory (no store, and tests). */
export class MemorySandboxJobs implements SandboxJobs {
  readonly #rows = new Map<string, SandboxJobRow>();

  open(): SandboxJobRow[] {
    return [...this.#rows.values()]
      .filter((r) => r.state === "open")
      .sort((a, b) => a.created_at - b.created_at)
      .map((r) => ({ ...r }));
  }

  get(id: string): SandboxJobRow | null {
    const row = this.#rows.get(id);
    return row === undefined ? null : { ...row };
  }

  insert(row: SandboxJobRow): void {
    this.#rows.set(row.id, { ...row });
  }

  update(
    id: string,
    patch: Partial<Pick<SandboxJobRow, "manifest" | "cpu_ms" | "expires_at" | "updated_at">>,
  ): void {
    const row = this.#rows.get(id);
    if (row) Object.assign(row, patch);
  }

  end(id: string, reason: string, at: number): void {
    const row = this.#rows.get(id);
    if (row && row.state === "open") {
      row.state = "ended";
      row.ended_reason = reason;
      row.updated_at = at;
    }
  }

  prune(before: number): number {
    let n = 0;
    for (const [id, row] of this.#rows) {
      if (row.state === "ended" && row.updated_at < before) {
        this.#rows.delete(id);
        n++;
      }
    }
    return n;
  }
}
