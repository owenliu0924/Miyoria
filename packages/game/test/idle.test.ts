// The idle filler and the empty-decision goal drop of the director (design doc P1).

import { Supervisor } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  LlmRouterKey,
  parseModelRef,
} from "@miyoria/llm";
import type { ContextKey, Event, JsonObject, JsonValue } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_TOPIC,
  GameControlKey,
  GameHandleKey,
  GameModule,
  type GameStatus,
  GOAL_TOPIC,
} from "../src/index.js";
import { FakeExecutor, FakeExecutors, MINECRAFT_GOALS } from "./fake-executor.js";

const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "text1", kind: "channel" };

/** Replies from a script (the last one repeats); records every request. */
class Script implements ChatProvider {
  readonly name = "script";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly replies: string[]) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const text = (this.replies.length > 1 ? this.replies.shift() : this.replies[0]) ?? "{}";
    return (async function* () {
      yield { type: "text_delta" as const, text };
      yield { type: "done" as const, finish_reason: "stop", usage: null };
    })();
  }

  /** The user message of the last request. */
  lastPrompt(): string {
    return contentText(this.requests.at(-1)?.messages.at(-1)?.content ?? "");
  }
}

function decide(goal: string, action: JsonValue, want: JsonValue = null): string {
  return JSON.stringify({ goal, goal_status: "working", want, action, commentary: null });
}

function outcome(progressed: boolean, inventory: JsonObject | null = null, note = ""): JsonValue {
  return { outcome: { progressed, gained: {}, lost: {}, inventory, note } };
}

async function secs(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n * 1000);
  await vi.advanceTimersByTimeAsync(5);
}

class H {
  readonly sup = new Supervisor();
  readonly exec: FakeExecutor;
  readonly payloads: { topic: string; payload: JsonValue }[] = [];

  private constructor(readonly llm: Script) {
    this.exec = new FakeExecutor(
      (e) => this.sup.bus.publish("ext.miyoria.minecraft", e),
      Date.now,
      {
        goals: [
          ...MINECRAFT_GOALS,
          { name: "hunt", description: "打獵", parameters: null, budget_s: 120 },
          { name: "shelter", description: "躲起來過夜", parameters: null, budget_s: 540 },
          { name: "recover", description: "回去撿東西", parameters: null, budget_s: 120 },
          { name: "idle", description: "找點事做", parameters: null, budget_s: 120 },
        ],
      },
    );
    const sub = this.sup.bus.subscribe("*");
    void (async () => {
      for await (const env of sub as AsyncIterable<{ event: Event }>) {
        const e = env.event;
        if (e.type === "custom")
          this.payloads.push({ topic: e.data.topic, payload: e.data.payload });
      }
    })();
  }

  static async create(replies: string[], config: JsonValue = null): Promise<H> {
    const h = new H(new Script(replies));
    const router = new LlmRouter(
      new Map([[h.llm.name, h.llm]]),
      new Map([["game", [parseModelRef(`${h.llm.name}:m`)]]]),
    );
    new FakeExecutors(h.exec).provide(h.sup.services);
    h.sup.services.provide("app", LlmRouterKey, router);
    await h.sup.register(new GameModule("DeepSeek醬", ""), config, true);
    await h.sup.startAll();
    return h;
  }

  async start(): Promise<void> {
    await this.sup.services
      .require(GameControlKey)
      .start("minecraft", TEXT, { platform: "discord", id: "1" }, "here");
    await vi.advanceTimersByTimeAsync(5);
  }

  async event(
    kind: string,
    text: string,
    important = false,
    extra: JsonObject = {},
  ): Promise<void> {
    this.sup.bus.publish("test", {
      type: "custom",
      data: {
        topic: `game.minecraft.${kind}`,
        payload: { type: kind, data: { text, ...extra }, important },
      },
    });
    await vi.advanceTimersByTimeAsync(5);
  }

  status(): GameStatus | null {
    return this.sup.services.require(GameHandleKey).status();
  }

  names(): string[] {
    return this.exec.names();
  }

  of(topic: string): JsonObject[] {
    return this.payloads.filter((p) => p.topic === topic).map((p) => p.payload as JsonObject);
  }

  async stop(): Promise<void> {
    const done = this.sup.stopAll();
    await vi.advanceTimersByTimeAsync(10);
    await done;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 8, 16, 8, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

const NOTHING = JSON.stringify({
  goal: null,
  goal_status: "working",
  want: null,
  action: null,
  commentary: null,
});

describe("idle fill (design doc P1)", () => {
  it("starts idle once her body has been free a while and a decision chose nothing", async () => {
    const h = await H.create([NOTHING]);
    await h.start();
    // The first decision chose nothing; the body has not been free 8 s yet.
    expect(h.names()).toEqual([]);
    await secs(8);
    expect(h.names()).toEqual(["idle"]);
    expect(h.status()?.goal?.text).toBe("閒著先找點事做");
    expect(h.of(DECISION_TOPIC).some((t) => JSON.stringify(t.trigger) === '["閒著"]')).toBe(true);
    await h.stop();
  });

  it("a decision with an action replaces the idle goal", async () => {
    const h = await H.create([
      NOTHING,
      decide("拿木鎬", { name: "obtain", args: { item: "wooden_pickaxe" } }),
    ]);
    await h.start();
    await secs(8);
    expect(h.names()).toEqual(["idle"]);
    await secs(20);
    expect(h.names()).toEqual(["idle", "obtain"]);
    expect(h.status()?.goal?.text).toBe("拿木鎬");
    await h.stop();
  });

  it("is off with idle_action null", async () => {
    const h = await H.create([NOTHING], { idle_action: null });
    await h.start();
    await secs(30);
    expect(h.names()).toEqual([]);
    await h.stop();
  });

  it("drops her own goal that keeps getting no next step", async () => {
    const h = await H.create(
      [
        decide("找樹", { name: "explore", args: {} }),
        JSON.stringify({
          goal: "找樹",
          goal_status: "working",
          want: null,
          action: null,
          commentary: null,
        }),
      ],
      { idle_action: null, method_repeat_limit: 0 },
    );
    await h.start();
    h.exec.done("探索了一下", h.exec.last().id, outcome(false));
    await vi.advanceTimersByTimeAsync(5);
    await secs(60);
    expect(h.of(GOAL_TOPIC)).toEqual([
      expect.objectContaining({ goal: "找樹", status: "failed", code: "no_progress" }),
    ]);
    await h.stop();
  });
});
