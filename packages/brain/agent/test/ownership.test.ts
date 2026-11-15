// Turn ownership in the running module (docs/design/v2-architecture.md §3.9): the cancellation
// table, `agent.turn.outcome`, `TurnFocusViewKey`, quoting the focus, text streamed line by
// line, notices and saved prompts.

import { MockProvider } from "@miyoria/llm/llm";
import {
  type Envelope,
  type TurnFocus,
  TurnFocusViewKey,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedPromptsKey } from "../src/index.js";
import {
  channel,
  Harness,
  incoming,
  mention,
  noCheck,
  SlowProvider,
  stopHarnesses,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

function payloads<T>(events: Envelope[], topic: string): T[] {
  return events.flatMap((e) => (e.type === topic ? [e.data as T] : []));
}

const outcomes = (events: Envelope[]) =>
  payloads<TurnOutcomeRecord>(events, "agent.turn.outcome").map((r) => r.outcome);

describe("cancellation table", () => {
  it("the_focus_person_restarts_a_text_turn_at_most_once", async () => {
    const slow = new SlowProvider(3000);
    const h = await Harness.create("always", noCheck(), slow);
    const c = channel("c");
    h.say(mention(c, "Owen", "DeepSeek 幫我看一下這段"));
    // Turn at 0.8 s, generating until 3.8 s.
    await wait(1500);
    h.say(incoming(c, "Owen", "其實是另一段才對"));
    // Restarted: the new turn starts at 2.3 s; the next addition only waits.
    await wait(1500);
    h.say(incoming(c, "Owen", "還有另一件事想問妳"));
    await wait(15_000);
    expect(slow.calls).toBe(3);
    expect(h.sink.texts()).toEqual(["reply 2", "reply 3"]);
    expect(slow.requests[1]?.messages[1]?.content).toBe(
      "Owen: DeepSeek 幫我看一下這段\nOwen: 其實是另一段才對",
    );
    const events = h.drain();
    expect(outcomes(events)).toEqual([
      { type: "cancelled", cause: "input", by: "Owen" },
      { type: "sent", parts: 1 },
      { type: "sent", parts: 1 },
    ]);
    const records = payloads<TurnOutcomeRecord>(events, "agent.turn.outcome");
    expect(records.map((r) => r.restarts)).toEqual([0, 1, 0]);
    expect(records[1]?.latency_ms).toBeGreaterThan(0);
    expect(h.sink.cancelled.length).toBe(1);
  });

  it("other_people_and_short_replies_never_cancel", async () => {
    const slow = new SlowProvider(3000);
    const h = await Harness.create("always", noCheck(), slow);
    const c = channel("c");
    h.say(mention(c, "Owen", "DeepSeek 妳覺得這個設計怎樣"));
    await wait(1500);
    h.say(incoming(c, "Owen", "嗯嗯"));
    h.say(incoming(c, "阿明", "我也想聽聽看她的意見"));
    await wait(15_000);
    expect(h.sink.cancelled).toEqual([]);
    expect(slow.calls).toBe(2);
    // The first reply went out; the rest became the next turn (阿明 is its focus now). She
    // answered Owen, so 阿明 speaking after her is not a reply to her (2026-11-10).
    expect(h.sink.texts()).toEqual(["reply 1", "reply 2"]);
    const focus = payloads<TurnFocus>(h.drain(), "agent.turn.focus");
    const second = focus.filter((f) => f.phase === "generating")[1];
    expect(second?.reason).toBe("ambient");
    expect(second?.addressed_by).toEqual([]);
    expect(second?.background.length).toBe(1);
  });
});

describe("focus view and output", () => {
  it("voice_barge_in_can_ask_whom_the_turn_is_for", async () => {
    const slow = new SlowProvider(3000);
    const h = await Harness.create("always", noCheck(), slow);
    const view = h.sup.services.require(TurnFocusViewKey);
    const c = channel("c");
    h.say(incoming(c, "阿明", "今天好熱"));
    h.say(mention(c, "Owen", "DeepSeek 要不要吃冰"));
    await wait(1500);
    const current = view.current(c);
    expect(current?.phase).toBe("generating");
    expect(current?.reason).toBe("addressed");
    expect(current?.addressed_by).toEqual(["Owen"]);
    expect(current?.addressed_accounts).toEqual([{ platform: "test", id: "Owen" }]);
    expect(current?.focus.length).toBe(1);
    expect(current?.background.length).toBe(1);
    await wait(5000);
    expect(view.current(c)).toBeNull();
    expect(view.all()).toEqual([]);
  });

  it("text_goes_out_line_by_line_and_quotes_the_message_that_called_her", async () => {
    const mock = new MockProvider("chat").reply("好啊\n等我一下喔");
    const h = await Harness.create("always", noCheck(), mock);
    const c = channel("c");
    h.say(incoming(c, "阿明", "我先講一句"));
    const called = mention(c, "Owen", "DeepSeek 等等一起玩?");
    h.say(called);
    await wait(3000);
    const sends = h.sink.actions.flatMap((a) =>
      a.payload.type === "send_message"
        ? [[a.payload.message.text, a.payload.message.reply_to]]
        : [],
    );
    expect(sends).toEqual([
      ["好啊", called.id],
      ["等我一下喔", null],
    ]);
    expect(outcomes(h.drain())).toEqual([{ type: "sent", parts: 2 }]);
    // The compressed prompt of the turn is kept for the panel.
    const saved = h.sup.services.require(SavedPromptsKey).recent(c);
    expect(saved.length).toBe(1);
    expect(saved[0]?.prompt_tokens).toBe(10);
    // A real question reasons by its own tier (`[llm.reasoning] chat_question`).
    expect(saved[0]?.reasoning).toBe("low");
    expect(saved[0]?.blocks.some((b) => b.key === "people")).toBe(true);
    expect(saved[0]?.messages.at(-1)?.text).toContain("Owen 問你:DeepSeek 等等一起玩?");
  });
});
