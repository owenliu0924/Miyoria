import {
  ActuatorRegistryKey,
  permit,
  SKILLS_USE,
  WORK_BELOW_BOND,
  WORK_BOND,
} from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import type { ToolEntry } from "@miyoria/llm/tools";
import {
  AuthorizerKey,
  type ContextKey,
  DirectivesKey,
  FloorKey,
  GameSecretsKey,
  type InputServices,
  type ServiceKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { delegateNode } from "../src/delegate-tools.js";
import { composeGuards, permissiveGuard } from "../src/guard.js";
import { LINE_REFUSALS, REFUSALS } from "../src/rules.js";
import { floorKind, serviceGuard } from "../src/service-guard.js";
import { ALLOW, type GuardContext, refuse, type Wake } from "../src/types.js";
import { addressed, CTX, SESSION } from "./harness.js";

// biome-ignore lint/suspicious/noExplicitAny: a key of any service, beside a fake of it.
function services(entries: [ServiceKey<any>, unknown][]): InputServices {
  const map = new Map<unknown, unknown>(entries);
  return { get: <T>(key: ServiceKey<T>) => map.get(key) as T | undefined };
}

const ctx = (wake: Wake = addressed()): GuardContext => ({
  session: SESSION,
  turn: "t1",
  wake,
  profile: "text",
  now: Date.UTC(2026, 10, 16, 12),
});

const call = (name: string, over: Partial<ToolEntry> = {}) => ({
  call: { id: "c1", name, arguments: "{}" },
  args: {},
  entry: {
    name,
    effect: "act",
    speed: "instant",
    tool: { permission: null },
    ...over,
  } as unknown as ToolEntry,
});

describe("the service guard", () => {
  it("lets everything through when no service is there", async () => {
    const g = serviceGuard({ services: services([]) });
    expect(await g.checkCall(call("look"), ctx())).toEqual(ALLOW);
    expect(await g.checkLine(CTX, "嗨", ctx())).toEqual(ALLOW);
  });

  it("refuses what the owner's directives forbid", async () => {
    const directives = {
      filterTools: <T extends { name: string }>(tools: readonly T[]) =>
        tools.filter((t) => t.name !== "play_game"),
    };
    const g = serviceGuard({ services: services([[DirectivesKey, directives]]) });
    expect(await g.checkCall(call("play_game"), ctx())).toEqual(
      refuse("directive", REFUSALS.directive),
    );
    expect(await g.checkCall(call("look"), ctx())).toEqual(ALLOW);
  });

  it("a tool with a permission needs someone allowed to ask", async () => {
    const authorizer = { allows: (account: { id: string }) => account.id === "u1" };
    const g = serviceGuard({ services: services([[AuthorizerKey, authorizer]]) });
    const needs = call("ban", { tool: { permission: "mod.ban" } } as Partial<ToolEntry>);
    expect(await g.checkCall(needs, ctx())).toEqual(ALLOW);
    expect(await g.checkCall(needs, ctx({ kind: "self", note: null }))).toEqual(
      refuse("permission", REFUSALS.permissionNobody),
    );
    const other: Wake = {
      kind: "addressed",
      reason: "mention",
      from: { account: { platform: "discord", id: "u2" }, name: "Amy" },
      message: { context: CTX, id: "m2" },
    };
    expect(await g.checkCall(needs, ctx(other))).toEqual(
      refuse("permission", REFUSALS.permissionAsker),
    );
  });

  describe("a work node through the gate's permit", () => {
    const OWNER = { platform: "discord", id: "u0" };
    const bonds: Record<string, number> = { u1: 15, u2: 14 };
    const authorizer = {
      allows: (account: { id: string }, node: string) =>
        account.id === "u0" || (node === WORK_BOND && account.id in bonds),
    };
    const social = {
      attitude: (account: { id: string }) =>
        account.id in bonds ? { affinity: bonds[account.id], blocked: false } : null,
    };
    const gate = {
      permit: (account: { platform: string; id: string }, node: string) =>
        permit(
          { authorizer: authorizer as never, social: social as never, minBond: 15 },
          account,
          node,
        ),
    };
    const g = serviceGuard({
      services: services([
        [AuthorizerKey, authorizer],
        [ActuatorRegistryKey, gate],
      ]),
    });
    const asker = (id: string): Wake => ({
      kind: "addressed",
      reason: "mention",
      from: { account: id === "u0" ? OWNER : { platform: "discord", id }, name: id },
      message: { context: CTX, id: "m1" },
    });
    const delegate = (kind: string) => ({
      ...call("delegate", {
        tool: { permission: null, permissionFor: delegateNode },
      } as unknown as Partial<ToolEntry>),
      args: { kind, goal: "做一份表" },
    });
    const skill = call("skill", { tool: { permission: SKILLS_USE } } as Partial<ToolEntry>);

    it("a bond at work_min_bond opens a worker and a skill", async () => {
      expect(await g.checkCall(delegate("worker"), ctx(asker("u1")))).toEqual(ALLOW);
      expect(await g.checkCall(skill, ctx(asker("u1")))).toEqual(ALLOW);
    });

    it("one below it is told so, with the gate's text", async () => {
      expect(await g.checkCall(delegate("worker"), ctx(asker("u2")))).toEqual(
        refuse("permission", WORK_BELOW_BOND),
      );
      expect(await g.checkCall(skill, ctx(asker("u2")))).toEqual(
        refuse("permission", WORK_BELOW_BOND),
      );
      // Someone with no way to the node at all is refused as before.
      expect(await g.checkCall(skill, ctx(asker("u9")))).toEqual(
        refuse("permission", REFUSALS.permissionAsker),
      );
    });

    it("her own run may do her own work, nothing else that needs a node", async () => {
      const own = ctx({ kind: "self", note: null });
      expect(await g.checkCall(skill, own)).toEqual(ALLOW);
      expect(await g.checkCall(delegate("worker"), own)).toEqual(ALLOW);
      const ban = call("ban", { tool: { permission: "mod.ban" } } as Partial<ToolEntry>);
      expect(await g.checkCall(ban, own)).toEqual(refuse("permission", REFUSALS.permissionNobody));
    });

    it("the owner holds every node", async () => {
      expect(await g.checkCall(delegate("worker"), ctx(asker("u0")))).toEqual(ALLOW);
      expect(await g.checkCall(skill, ctx(asker("u0")))).toEqual(ALLOW);
    });

    it("research and curator stay open to anyone", async () => {
      for (const kind of ["research", "curator", "Research"]) {
        expect(await g.checkCall(delegate(kind), ctx(asker("u2")))).toEqual(ALLOW);
        expect(await g.checkCall(delegate(kind), ctx(asker("u9")))).toEqual(ALLOW);
      }
      expect(delegateNode({ kind: " Worker " })).toBe("work.delegate");
      expect(delegateNode({ kind: "research" })).toBeNull();
      expect(delegateNode("worker")).toBeNull();
    });
  });

  it("paused: only looking; the budget gone: nothing outside or long", async () => {
    const paused = serviceGuard({ services: services([[ActuatorRegistryKey, { paused: true }]]) });
    expect((await paused.checkCall(call("play"), ctx())).allow).toBe(false);
    expect(await paused.checkCall(call("look", { effect: "read" }), ctx())).toEqual(ALLOW);
    const broke = serviceGuard({
      services: services([[LlmRouterKey, { budgetState: () => "exhausted" }]]),
    });
    expect(await broke.checkCall(call("search", { effect: "external" }), ctx())).toEqual(
      refuse("budget", REFUSALS.budget),
    );
    expect(await broke.checkCall(call("note"), ctx())).toEqual(ALLOW);
  });

  it("the Floor's caps decide a line, by what woke her", async () => {
    const asked: [string, ContextKey][] = [];
    const floor = {
      refuses: (kind: string, place: ContextKey) => {
        asked.push([kind, place]);
        return kind === "ambient" ? "你在這裡講太多了" : null;
      },
    };
    const g = serviceGuard({ services: services([[FloorKey, floor]]) });
    expect(await g.checkLine(CTX, "嗨", ctx())).toEqual(ALLOW);
    expect(await g.checkLine(CTX, "嗨", ctx({ kind: "glance", lines: 3 }))).toEqual(
      refuse("floor", "你在這裡講太多了"),
    );
    expect(asked.map(([kind]) => kind)).toEqual(["addressed", "ambient"]);
    expect(floorKind({ kind: "timer", note: "x" })).toBe("wish");
  });

  // Review 2026-11-27: a reminder someone asked for, due in a channel nobody spoke in for half
  // an hour, was refused as "nobody there" and never delivered.
  it("a reminder someone asked for is owed them: no Floor of hers refuses it", async () => {
    const asker = { account: { platform: "discord", id: "u1" }, name: "阿明" };
    const asked = { kind: "timer" as const, note: "提醒阿明倒垃圾", from: asker };
    expect(floorKind(asked)).toBe("result");
    const kinds: string[] = [];
    const floor = {
      refuses: (kind: string) => {
        kinds.push(kind);
        return kind === "wish" ? "現在沒有真人在場,不對空氣說話" : null;
      },
    };
    const g = serviceGuard({ services: services([[FloorKey, floor]]) });
    expect(await g.checkLine(CTX, "阿明,該倒垃圾囉", ctx(asked))).toEqual(ALLOW);
    expect(await g.checkLine(CTX, "早安", ctx({ kind: "timer", note: "早安" }))).toEqual(
      refuse("floor", "現在沒有真人在場,不對空氣說話"),
    );
    expect(kinds).toEqual(["result", "wish"]);
  });

  it("a line in another place claims that place's Floor as a start of hers", async () => {
    const asked: [string, ContextKey][] = [];
    const floor = {
      refuses: (kind: string, place: ContextKey) => {
        asked.push([kind, place]);
        return null;
      },
    };
    const g = serviceGuard({ services: services([[FloorKey, floor]]) });
    const elsewhere: ContextKey = { ...CTX, channel: "elsewhere" };
    expect(await g.checkLine(elsewhere, "嗨", ctx())).toEqual(ALLOW);
    expect(await g.checkLine(elsewhere, "嗨", ctx({ kind: "glance", lines: 2 }))).toEqual(ALLOW);
    expect(asked).toEqual([
      ["notable", elsewhere],
      ["wish", elsewhere],
    ]);
  });

  it("a line that gives a game's secret away is refused, with the plain answer to say instead", async () => {
    const asked: [ContextKey, string][] = [];
    const secrets = {
      leak: (place: ContextKey, text: string) => {
        asked.push([place, text]);
        return text.includes("按鈕") ? { word: "按鈕", instead: "很接近了!" } : null;
      },
    };
    const g = serviceGuard({ services: services([[GameSecretsKey, secrets]]) });
    expect(await g.checkLine(CTX, "很接近了,想想電梯按鈕", ctx())).toEqual(
      refuse("game_secret", LINE_REFUSALS.gameSecret("按鈕"), "很接近了!"),
    );
    expect(await g.checkLine(CTX, "很接近了!", ctx())).toEqual(ALLOW);
    expect(asked.map(([place]) => place)).toEqual([CTX, CTX]);
    const none = { leak: () => ({ word: "傘", instead: null }) };
    const quiet = serviceGuard({ services: services([[GameSecretsKey, none]]) });
    expect(await quiet.checkLine(CTX, "帶傘", ctx())).toEqual(
      refuse("game_secret", LINE_REFUSALS.gameSecret("傘")),
    );
  });

  it("a line the output review would change is refused, not rewritten", async () => {
    const g = serviceGuard({ services: services([]) });
    expect(await g.checkLine(CTX, "@everyone 來看", ctx())).toEqual(
      refuse("unsafe_output", LINE_REFUSALS.unsafe),
    );
  });
});

describe("composed guards", () => {
  it("the first refusal answers", async () => {
    const no = {
      checkCall: async () => refuse("a", "不行"),
      checkLine: async () => refuse("b", "不行"),
    };
    const g = composeGuards(permissiveGuard, no, {
      checkCall: async () => refuse("c", "也不行"),
      checkLine: async () => ALLOW,
    });
    expect(await g.checkCall(call("x"), ctx())).toEqual(refuse("a", "不行"));
    expect(await g.checkLine(CTX, "嗨", ctx())).toEqual(refuse("b", "不行"));
    expect(g.screenResult?.("結果", ctx())).toBe("結果");
  });
});
