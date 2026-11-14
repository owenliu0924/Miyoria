import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { systemClock } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { Db, legacySchema, type MemoryRecord, migrate, SqliteStore } from "../src/index.js";

/** A database as the build before provenance left it: migrations up to 0006, then old rows. */
function legacyDatabase(path: string): void {
  const db = new Db(new DatabaseSync(path), systemClock);
  const before = legacySchema.migrations.filter((m) => m.version <= 6);
  migrate(db, [{ ...legacySchema, migrations: before }]);
  db.close();
  const raw = new DatabaseSync(path);
  const insert = raw.prepare(
    "INSERT INTO memory_records (id, profile_id, kind, scope, scope_key, subjects, content, " +
      "tokens, importance, confidence, created_at, updated_at, source) " +
      "VALUES (?, 'p', ?, '{\"type\":\"global\"}', '{\"type\":\"global\"}', '[]', ?, ?, 0.5, 0.8, " +
      "1000000, 1000000, ?)",
  );
  insert.run("01LEGACYEXTRACTED0000000000", "fact", "Owen 喜歡拉麵", "owen 拉麵", null);
  insert.run("01LEGACYEPISODE000000000000", "episode", "昨晚一起打 Minecraft", "minecraft", null);
  insert.run(
    "01LEGACYTOLD00000000000000",
    "fact",
    "Owen 下週三要考試",
    "owen 考試",
    '{"account":{"platform":"discord","id":"2"},"name":"Owen"}',
  );
  raw.close();
}

describe("memory provenance migration", () => {
  it("marks old memories unknown, keeps told notes as told, and keeps them all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-prov-"));
    const path = join(dir, "old.db");
    try {
      legacyDatabase(path);
      const store = await SqliteStore.open(path);
      try {
        const get = async (id: string) => (await store.memories.get(id)) as MemoryRecord;
        const extracted = await get("01LEGACYEXTRACTED0000000000");
        const episode = await get("01LEGACYEPISODE000000000000");
        const told = await get("01LEGACYTOLD00000000000000");

        // Not guessed: nothing says whether she saw it, so it stays unknown, without evidence.
        expect(extracted.origin).toBe("unknown");
        expect(extracted.source_events).toEqual([]);
        expect(episode.origin).toBe("unknown");
        // Someone asked her to write it down: that is a fact about the row, not a guess.
        expect(told.origin).toBe("told");
        expect(told.source?.name).toBe("Owen");
        expect(told.source_events).toEqual([]);

        // Content, tokens and search still work: they stay usable.
        expect(extracted.content).toBe("Owen 喜歡拉麵");
        const hits = await store.memories.search({
          profile: "p",
          scopes: [{ type: "global" }],
          kinds: null,
          tokens: ["拉麵"],
          embedding: null,
          limit: 5,
        });
        expect(hits.map((h) => h.record.id)).toEqual(["01LEGACYEXTRACTED0000000000"]);

        // A rewrite keeps the mark, and new provenance round-trips.
        await store.memories.upsert({ ...extracted, importance: 0.9 });
        expect((await get(extracted.id)).origin).toBe("unknown");
        await store.memories.upsert({
          ...extracted,
          origin: "experienced",
          source_events: ["01EVENT"],
        });
        const again = await get(extracted.id);
        expect(again.origin).toBe("experienced");
        expect(again.source_events).toEqual(["01EVENT"]);
      } finally {
        await store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("a record written without provenance reads back as unknown", async () => {
    const store = await SqliteStore.open(":memory:");
    try {
      await store.memories.upsert({
        id: "01NOPROVENANCE00000000000",
        profile: "p",
        kind: "fact",
        scope: { type: "global" },
        subjects: [],
        content: "x",
        tokens: "x",
        embedding: null,
        importance: 0.5,
        confidence: 0.5,
        created_at: "2026-10-01T00:00:00.000000Z",
        updated_at: "2026-10-01T00:00:00.000000Z",
        last_accessed: null,
        access_count: 0,
        source_context: null,
        source: null,
        due: null,
        done: false,
        superseded_by: null,
      });
      const back = await store.memories.get("01NOPROVENANCE00000000000");
      expect(back?.origin).toBe("unknown");
      expect(back?.source_events).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
