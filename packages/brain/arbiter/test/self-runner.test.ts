// With `[modules.agent] runner = "self"` her own starts are the new runner's initiative: the
// Arbiter opens nothing of them, writes no greeting, proposes no followup and claims no greeting
// or overdue promise. What is not hers (a game's narration) goes on as before.

import { EventLogService } from "@miyoria/memory/facts";
import { Supervisor } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ArbiterKey,
  type Attitude,
  type ContextKey,
  EventLogKey,
  Events,
  type Followup,
  type FollowupSource,
  FollowupSourceKey,
  ImpulseHostKey,
  type NewProposal,
  newImpulse,
  ProposalBoardKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArbiterModule } from "../src/index.js";
import { acct, FakeHost, MIN, T0, textCtx, voiceCtx } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

const friend: Attitude = {
  person: "person-a",
  affinity: 60,
  trust: 50,
  familiarity: 50,
  blocked: false,
  label: "朋友",
  call_name: null,
};

class Followups implements FollowupSource {
  done: string[] = [];
  async due(): Promise<Followup[]> {
    return [
      {
        id: "f1",
        profile: "p",
        person: null,
        context: textCtx("c1"),
        about: "問他報告",
        due: toTimestamp(T0),
      },
    ];
  }
  async markDone(id: string): Promise<void> {
    this.done.push(id);
  }
}

async function rig(selfStarts: boolean) {
  const sup = new Supervisor();
  const log = new EventLogService({ profile: "p", store: null });
  const proposals: NewProposal[] = [];
  const followups = new Followups();
  const host = new FakeHost();
  sup.services.provide("app", EventLogKey, log);
  sup.services.provide("app", SocialSignalsKey, {
    attitude: (a: AccountRef) => (a.id === "a" ? friend : null),
  });
  sup.services.provide("app", FollowupSourceKey, followups);
  sup.services.provide("app", ImpulseHostKey, host);
  sup.services.provide("app", ProposalBoardKey, {
    propose: async (p) => {
      proposals.push(p);
      return { id: "x", state: "open", detail: "", turn: null };
    },
    open: () => [],
  });
  await sup.register(new ArbiterModule("p", { selfStarts }), { tick_secs: 1 }, true);
  await sup.startAll();
  return { sup, log, proposals, followups, host };
}

function message(ctx: ContextKey, who: string) {
  return {
    id: { context: ctx, id: `${who}-${T0}` },
    author: { account: acct(who), display_name: who, is_bot: false },
    text: "hi",
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0),
  };
}

function observation(source: string, key: string) {
  return {
    source,
    silent: false,
    salience: "notable" as const,
    attention_key: key,
    revision: 1,
    summary: key,
    addressed_to_her: false,
    from: null,
    context: source.startsWith("game.") ? voiceCtx("v1") : textCtx("c1"),
  };
}

describe("runner = self: her own starts are not the Arbiter's", () => {
  it("refuses her own impulses, opens a game's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const r = await rig(false);
    const arbiter = r.sup.services.require(ArbiterKey);
    for (const source of ["plan", "agenda", "world", "followup"] as const) {
      const d = await arbiter.submit(
        newImpulse({ source, context: textCtx("c1"), ttlMs: MIN, why: "想聊天" }, T0),
      );
      expect(d).toMatchObject({ verdict: "rejected", reason: "denied" });
    }
    const game = await arbiter.submit(
      newImpulse({ source: "game", context: voiceCtx("v1"), ttlMs: MIN, why: "解說" }, T0),
    );
    expect(game.verdict).toBe("accepted");
    expect(r.host.opened.map((i) => i.source)).toEqual(["game"]);
    await r.sup.stopAll();
  });

  it("writes no greeting, proposes no followup, claims no promise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const r = await rig(false);
    r.sup.bus.publish("t", Events.PlatformReady, { platform: "test", self_account: acct("me") });
    r.sup.bus.publish("t", Events.PlatformMessageCreated, message(textCtx("c1"), "a"));
    r.log.observe(observation("mainline.commitment", "commitment:c1"));
    r.log.observe(observation("game.minecraft", "game:craft:stone_pickaxe"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(r.log.recent(50).filter((e) => e.source === "world.greeting")).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.followups.done).toEqual([]);
    expect(r.host.opened.map((i) => i.attention?.key)).toEqual(["game:craft:stone_pickaxe"]);
    await r.sup.stopAll();
  });

  it("the default is today's: a greeting, a followup proposal, a claimed promise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const r = await rig(true);
    r.sup.bus.publish("t", Events.PlatformReady, { platform: "test", self_account: acct("me") });
    r.sup.bus.publish("t", Events.PlatformMessageCreated, message(textCtx("c1"), "a"));
    r.log.observe(observation("mainline.commitment", "commitment:c1"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(r.log.recent(50).filter((e) => e.source === "world.greeting")).toHaveLength(1);
    expect(r.proposals.map((p) => p.what)).toEqual(["問他報告"]);
    expect(r.host.opened.map((i) => i.attention?.key)).toContain("commitment:c1");
    await r.sup.stopAll();
  });
});
