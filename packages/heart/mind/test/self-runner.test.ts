// With `[modules.agent] runner = "self"` her Plan still keeps her goals and her day plan, but its
// impulses start nothing: no proposal reaches the board.

import { ActuatorRegistry, ActuatorRegistryKey, defineCapability } from "@miyoria/gate/actions";
import { LlmRouter, LlmRouterKey, parseModelRef } from "@miyoria/llm/llm";
import { getLogger, ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type NewProposal,
  Principals,
  ProposalBoardKey,
  type Reminder,
  ReminderDeskKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GoalBook,
  Journal,
  MindLoop,
  mindConfig,
  REMINDER_PREFIX,
  type ReminderBackend,
  type ReminderInput,
  ruleDigest,
} from "../src/index.js";
import { ScriptedProvider } from "./fakes.js";
import { rig, stopRigs, TEXT } from "./helpers.js";

async function plan(proposes: boolean): Promise<{ proposals: NewProposal[]; loop: MindLoop }> {
  const services = new ServiceRegistry();
  const proposals: NewProposal[] = [];
  services.provide("app", ProposalBoardKey, {
    propose: async (p) => {
      proposals.push(structuredClone(p));
      return { id: p.id ?? "x", state: "taken", detail: "", turn: "t1" };
    },
    open: () => [],
  });
  const registry = new ActuatorRegistry({ services, builtins: false, publish: () => {} });
  registry.register(
    defineCapability({
      name: "game.start",
      summary: "開遊戲",
      risk: "low",
      args: z.looseObject({}),
      permission: null,
      async execute() {
        return "ok";
      },
    }),
  );
  services.provide("app", ActuatorRegistryKey, registry);
  const provider = new ScriptedProvider(() =>
    JSON.stringify({
      thought: "好無聊,想玩遊戲。",
      impulses: [{ kind: "act", capability: "game.start", args: {}, why: "好無聊" }],
    }),
  );
  services.provide(
    "app",
    LlmRouterKey,
    new LlmRouter(new Map([["p", provider]]), new Map([["mind", [parseModelRef("p:mind")]]])),
  );
  const clock = { now: () => Date.now() };
  const loop = new MindLoop({
    config: mindConfig(),
    profile: "p",
    name: "DeepSeek-chan",
    persona: () => "你是住在深海的鯨魚娘。",
    services,
    clock,
    publish: () => {},
    log: getLogger("test"),
    journal: new Journal(null, "p", 50, () => {}, {
      batch: 50,
      digestsKeep: 10,
      condense: async (t) => ruleDigest(t),
    }),
    goals: new GoalBook({ store: null, profile: "p", clock, maxDays: 14, defaultDays: 3 }),
    store: null,
    proposes,
  });
  await loop.plan([{ kind: "manual", detail: "", context: null }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { proposals, loop };
}

/** The new runner's schedules, as `remind_me` sees them. */
class Schedules implements ReminderBackend {
  readonly offsetMinutes = 480;
  readonly set_: ReminderInput[] = [];
  now(): number {
    return Date.now();
  }
  list(): Reminder[] {
    return this.set_.map((input, i) => ({
      id: `s${i}`,
      key: `RS000${i}`,
      what: input.what,
      due: toTimestamp(input.due),
      daily: input.daily,
      context: input.context,
      person: input.person,
      for_account: input.for_account,
      fired: 0,
      created_at: toTimestamp(Date.now()),
    }));
  }
  of(): Reminder[] {
    return this.list();
  }
  get(): Reminder | null {
    return null;
  }
  cancel(): boolean {
    return false;
  }
  set(input: ReminderInput): Reminder {
    this.set_.push(input);
    return this.list().at(-1) as Reminder;
  }
}

describe("remind_me on the new runner", () => {
  afterEach(async () => {
    await stopRigs();
  });

  it("keeps the same tool and keeps its timers in the new runner's schedules", async () => {
    const schedules = new Schedules();
    const r = await rig(new ScriptedProvider(() => "{}"), {
      module: { selfRunner: { reminders: () => schedules } },
    });
    expect(r.registry.get("self.remind")?.tool?.name).toBe("remind_me");
    const set = await r.registry.invoke({
      principal: Principals.self(TEXT),
      capability: "self.remind",
      args: { what: "看一下烤箱", in_minutes: 20 },
      why: null,
      turn: null,
    });
    expect(set.status).toBe("done");
    expect(schedules.set_.map((s) => [s.what, s.context])).toEqual([["看一下烤箱", TEXT]]);
    expect((await r.store.list("p", REMINDER_PREFIX)).size).toBe(0);
    expect(
      r.sup.services
        .require(ReminderDeskKey)
        .list()
        .map((x) => x.what),
    ).toEqual(["看一下烤箱"]);
  });
});

describe("runner = self", () => {
  it("her Plan's impulses reach no board; the journal says why", async () => {
    const { proposals, loop } = await plan(false);
    expect(proposals).toEqual([]);
    const intents = loop.thoughts()[0]?.intents ?? [];
    expect(intents.map((i) => [i.capability, i.status, i.detail])).toEqual([
      ["game.start", "dropped", "the new runner decides on its own"],
    ]);
  });

  it("runner = mainline: as today, they are proposed", async () => {
    const { proposals } = await plan(true);
    expect(proposals.map((p) => p.capability)).toEqual(["game.start"]);
  });
});
