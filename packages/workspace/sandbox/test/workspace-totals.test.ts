// The whole workspace's kept counts: a write near the caps does not walk everyone's files, and
// the counts stay what a walk would find.

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxConfigSchema } from "../src/config.js";
import { PersonWorkspace } from "../src/people.js";
import { PersistentWorkspace } from "../src/workspace-store.js";
import { CountedWorkspace } from "../src/workspace-totals.js";

const LIMITS = { maxBytes: 64 * 1024 * 1024, maxFiles: 5000, maxFileBytes: 1024 * 1024 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-ws-totals-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function others(n: number): Promise<void> {
  const folder = join(dir, "people", "discord-300");
  await mkdir(folder, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(folder, `f${i}.txt`), "x".repeat(10));
}

describe("kept counts", () => {
  it("a person's writes count their folder from the kept list, without walking again", async () => {
    await others(300);
    const root = new CountedWorkspace(dir, LIMITS);
    const walks = vi.spyOn(PersistentWorkspace.prototype, "usage");
    const lists = vi.spyOn(PersistentWorkspace.prototype, "list");
    const me = new PersonWorkspace(root, "discord-200", { maxBytes: 1024 * 1024, maxFiles: 50 });
    for (let i = 0; i < 20; i++) await me.write(`n${i}.md`, `note ${i}`);
    await me.write("n0.md", "longer note 0");
    // One walk for all of them.
    expect(walks).toHaveBeenCalledTimes(1);
    expect(lists.mock.calls.filter((c) => c[0] === undefined)).toHaveLength(1);
    expect((await me.usage()).files).toBe(20);
    walks.mockRestore();
    lists.mockRestore();
    // What a fresh walk finds.
    const fresh = await new PersistentWorkspace(dir, LIMITS).usage();
    expect(await root.usage()).toEqual(fresh);
    expect(fresh.files).toBe(320);
  });

  it("still refuses at a person's cap and at the whole total", async () => {
    await others(8);
    const root = new CountedWorkspace(dir, { ...LIMITS, maxFiles: 12 });
    const me = new PersonWorkspace(root, "discord-200", { maxBytes: 1024 * 1024, maxFiles: 3 });
    for (let i = 0; i < 3; i++) await me.write(`n${i}.md`, "x");
    await expect(me.write("n3.md", "x")).rejects.toMatchObject({ kind: "limit" });
    const her = new PersonWorkspace(root, "discord-400", { maxBytes: 1024 * 1024, maxFiles: 3 });
    await her.write("a.md", "x");
    await expect(her.write("b.md", "x")).rejects.toMatchObject({ kind: "limit" });
    expect((await root.usage()).files).toBe(12);
    // A removal walks again, and frees the room.
    await me.remove("n0.md");
    await her.write("b.md", "x");
    expect((await root.usage()).files).toBe(12);
  });

  it("walks again after its refresh time, and when told the files changed", async () => {
    let now = 0;
    const root = new CountedWorkspace(dir, LIMITS, undefined, { now: () => now, refreshMs: 1000 });
    expect((await root.usage()).files).toBe(0);
    await others(2);
    expect((await root.usage()).files).toBe(0);
    now += 1000;
    expect((await root.usage()).files).toBe(2);
    await writeFile(join(dir, "people", "discord-300", "f9.txt"), "x");
    root.invalidate();
    expect((await root.usage()).files).toBe(3);
    root.replaceFolder("people/discord-300", [{ path: "only.txt", size: 4 }], false);
    expect(await root.usage()).toMatchObject({ files: 1, bytes: 4 });
    expect((await root.list("people/discord-300")).entries).toEqual([
      { path: "people/discord-300/only.txt", size: 4 },
    ]);
  });
});

describe("the workspace's defaults", () => {
  it("fit 100 people at the per-person caps", () => {
    const ws = SandboxConfigSchema.parse({}).workspace;
    expect(ws.max_files).toBeGreaterThanOrEqual(100 * ws.person_max_files);
    expect(ws.max_mb).toBeGreaterThanOrEqual(100 * ws.person_max_mb);
    expect(ws).toMatchObject({ max_files: 200_000, max_mb: 32_768 });
  });
});
