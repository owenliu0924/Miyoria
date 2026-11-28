// Her room (docs/design/her-room.md §2.3, §3.7): what a member says there is scoped as their
// Discord DM is, and the relation panel's "forget this one" deletes that one memory.

import type { MemoryScope } from "@miyoria/store";
import { roomContext } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { memoryConfig, scopeForNew, visibleScopes } from "../src/index.js";
import { acct, BACKENDS, closeAll, dmCtx, env, profile, t0 } from "./helpers.js";

const config = memoryConfig();
const OWEN = acct("2");

afterEach(closeAll);

describe("a memory learned in her room", () => {
  it("is scoped to the member's DM, the same scope as their Discord DM", () => {
    const room = roomContext(OWEN);
    for (const kind of ["fact", "episode", "self_note"] as const) {
      const here = scopeForNew(config, room, OWEN, kind, null);
      expect(here).toEqual({ type: "dm", account: OWEN });
      expect(scopeForNew(config, dmCtx("d1"), OWEN, kind, null)).toEqual(here);
    }
    // Recalled in the room, and in their Discord DM, never for another account.
    const dm: MemoryScope = { type: "dm", account: OWEN };
    expect(visibleScopes(room, [OWEN], [])).toContainEqual(dm);
    expect(visibleScopes(dmCtx("d1"), [OWEN], [])).toContainEqual(dm);
    expect(visibleScopes(roomContext(acct("3")), [acct("3")], [])).not.toContainEqual(dm);
  });
});

describe.each(BACKENDS)("forgetting one memory (%s store)", (backend) => {
  it("deletes only that record and makes cached lines stale", async () => {
    const e = await env(backend);
    const dm: MemoryScope = { type: "dm", account: OWEN };
    const ramen = await e.add("fact", dm, [], "Owen 喜歡拉麵", 0.6, t0());
    const cat = await e.add("fact", dm, [], "Owen 養了一隻貓", 0.6, t0());
    const before = e.engine.version;
    expect(await e.engine.forgetRecord(ramen)).toBe(true);
    expect(e.engine.version).toBeGreaterThan(before);
    expect(await e.rec(ramen)).toBeNull();
    expect((await e.rec(cat))?.content).toBe("Owen 養了一隻貓");
    // Asked again, or for an id that is not there: nothing to forget.
    expect(await e.engine.forgetRecord(ramen)).toBe(false);
    expect(await e.engine.forgetRecord("01NOSUCHRECORD000000000000")).toBe(false);
    expect((await e.all()).map((r) => r.id)).toEqual([cat]);
  });

  it("leaves another profile's record alone", async () => {
    const e = await env(backend);
    const id = await e.add("fact", { type: "global" }, [], "她喜歡下雨天", 0.6, t0());
    const record = await e.rec(id);
    if (record === null) throw new Error("not stored");
    await e.store.memories.upsert({ ...record, id: `${id}x`, profile: `${profile()}-other` });
    expect(await e.engine.forgetRecord(`${id}x`)).toBe(false);
    expect(await e.rec(`${id}x`)).not.toBeNull();
  });
});
