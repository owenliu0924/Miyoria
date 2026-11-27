// `sandbox_jobs` on a real SQLite file in memory: the migration applies alone (it only adds a
// table), and the rows go in, change and end as the client and the sandbox use them.

import { openPluginDatabase } from "@miyoria/store";
import { describe, expect, it } from "vitest";
import { sandboxSchema } from "../../src/remote/jobs-migrations.js";
import {
  decodePayer,
  encodePayer,
  type SandboxJobRow,
  SandboxJobsTable,
} from "../../src/remote/jobs-store.js";

function row(over: Partial<SandboxJobRow> = {}): SandboxJobRow {
  return {
    id: "01jabcdefghjkmnpqrstvwxyz0",
    host: "friend-pc",
    service: "sandbox",
    kind: "session",
    name: "main",
    folder: "person:amy",
    payer: encodePayer({ person: "person-amy" }),
    for: "member",
    state: "open",
    ended_reason: null,
    manifest: null,
    cpu_ms: 0,
    created_at: 1000,
    updated_at: 1000,
    expires_at: 9000,
    ...over,
  };
}

describe("sandbox_jobs", () => {
  it("keeps_the_open_jobs_and_what_changed", () => {
    const db = openPluginDatabase(":memory:", [sandboxSchema]);
    try {
      const table = new SandboxJobsTable(db);
      table.insert(row());
      table.insert(row({ id: "01jabcdefghjkmnpqrstvwxyz1", kind: "run", name: null }));
      table.update("01jabcdefghjkmnpqrstvwxyz0", {
        manifest: [{ path: "a.txt", size: 1, sha256: "ab", mtime_ms: 1000 }],
        cpu_ms: 1234,
        updated_at: 2000,
      });
      table.end("01jabcdefghjkmnpqrstvwxyz1", "closed", 3000);
      expect(table.open().map((r) => r.id)).toEqual(["01jabcdefghjkmnpqrstvwxyz0"]);
      const kept = table.get("01jabcdefghjkmnpqrstvwxyz0");
      expect(kept).toMatchObject({ cpu_ms: 1234, updated_at: 2000, folder: "person:amy" });
      expect(kept?.manifest).toEqual([{ path: "a.txt", size: 1, sha256: "ab", mtime_ms: 1000 }]);
      expect(decodePayer(kept?.payer as string)).toEqual({ person: "person-amy" });
      expect(table.get("01jabcdefghjkmnpqrstvwxyz1")).toMatchObject({
        state: "ended",
        ended_reason: "closed",
      });
      expect(table.prune(4000)).toBe(1);
      expect(table.get("01jabcdefghjkmnpqrstvwxyz1")).toBeNull();
      // The table's own rules hold.
      expect(() =>
        table.insert(row({ id: "01jabcdefghjkmnpqrstvwxyz2", kind: "vm" as never })),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("keeps_an_owner_exempt", () => {
    expect(decodePayer(encodePayer({ person: "owner-1", exempt: true }) as string)).toEqual({
      person: "owner-1",
      exempt: true,
    });
    expect(encodePayer(null)).toBeNull();
  });
});
