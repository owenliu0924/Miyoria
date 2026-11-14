// The facts module as the one writer of the raw record from the bus: every chat line once, her
// decisions and how each turn ended, "do not remember this", and the people she meets. On a real
// supervisor and an in-memory store.

import { type Module, Supervisor } from "@miyoria/runtime/kernel";
import { openStore, type Store } from "@miyoria/store";
import {
  type ContextKey,
  customEvent,
  EventLogKey,
  HandleDirectoryKey,
  type JsonValue,
  MESSAGE_EXCLUDED_TOPIC,
  PlatformSinks,
  PlatformSinksKey,
  TURN_OUTCOME_TOPIC,
  type TurnOutcomeRecord,
  toTimestamp,
  v2Event,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { FactsModule } from "../src/module.js";

const CONFIG = { flush_ms: 5 };
const discord: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const running: Supervisor[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

async function run(module: Module): Promise<{ supervisor: Supervisor; store: Store }> {
  const store = await openStore("memory://");
  stores.push(store);
  const supervisor = new Supervisor();
  supervisor.services.provide("kernel", PlatformSinksKey, new PlatformSinks());
  await supervisor.register(module, CONFIG as unknown as JsonValue, true);
  await supervisor.startAll();
  running.push(supervisor);
  return { supervisor, store };
}

async function facts(): Promise<{ supervisor: Supervisor; store: Store }> {
  const store = await openStore("memory://");
  stores.push(store);
  const supervisor = new Supervisor();
  supervisor.services.provide("kernel", PlatformSinksKey, new PlatformSinks());
  await supervisor.register(new FactsModule(store, "p"), CONFIG as unknown as JsonValue, true);
  await supervisor.startAll();
  running.push(supervisor);
  return { supervisor, store };
}

describe("the raw record", () => {
  it("records_messages_people_spoken_lines_and_decisions", async () => {
    const { supervisor, store } = await facts();
    const bus = supervisor.bus;
    const ts = toTimestamp(Date.parse("2026-01-01T00:00:00Z"));
    const her = { platform: "discord", id: "her" };
    const owen = { platform: "discord", id: "owen" };
    const msg = (account: typeof her, text: string) => ({
      id: { context: discord, id: text },
      author: { account, display_name: account.id, is_bot: false },
      text,
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts,
    });
    bus.publish("platform.discord.bot", {
      type: "platform_ready",
      data: { platform: "discord", self_account: her },
    });
    bus.publish(
      "platform.discord.bot",
      { type: "platform_message_created", data: msg(owen, "hi") },
      { correlation: "T1" },
    );
    bus.publish("platform.discord.bot", {
      type: "platform_message_created",
      data: msg(her, "hello"),
    });
    bus.publish("voice", {
      type: "voice_playback",
      data: { context: discord, turn: "T2", state: "started", text: "說出口的話" },
    });
    const trace = { turn: "T1", context: discord, respond: true, score: 0.9, reasons: ["mention"] };
    bus.publish("agent", { type: "agent_decision", data: trace });
    await waitFor(async () => (await store.messages.recent("p", discord, 10)).length === 3);
    const log = await store.messages.recent("p", discord, 10);
    expect(log.map((e) => [e.text, e.is_self, e.turn])).toEqual([
      ["hi", false, "T1"],
      ["hello", true, null],
      ["說出口的話", true, "T2"],
    ]);
    await waitFor(async () => (await store.decisions.recent("p", null, 5)).length === 1);
    expect((await store.decisions.recent("p", discord, 5)).map((d) => d.trace)).toEqual([trace]);
    // Stored once: the decision is the facts line itself, under its bus topic.
    expect(await store.events?.query({ types: ["agent.decision", "facts.decision"] })).toHaveLength(
      1,
    );
    expect((await store.people.personByAccount(owen)) !== null).toBe(true);
    expect(await store.people.personByAccount(her)).toBeNull();
  });

  it("stores_each_line_once_and_redacts_one_she_was_asked_not_to_remember", async () => {
    const { supervisor, store } = await facts();
    const bus = supervisor.bus;
    const owen = { platform: "discord", id: "owen" };
    const msg = (id: string, text: string) => ({
      id: { context: discord, id },
      author: { account: owen, display_name: "Owen", is_bot: false },
      text,
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: toTimestamp(Date.parse("2026-01-01T00:00:00Z")),
    });
    // Both connections deliver the first message.
    bus.publish("platform.discord.bot", {
      type: "platform_message_created",
      data: msg("m1", "貓"),
    });
    bus.publish("platform.discord.self", {
      type: "platform_message_created",
      data: msg("m1", "貓"),
    });
    bus.publish("platform.discord.bot", {
      type: "platform_message_created",
      data: msg("m2", "麵"),
    });
    await waitFor(async () => (await store.messages.recent("p", discord, 10)).length === 2);
    expect(
      await store.events?.query({ key: "msg:discord:m1", types: ["platform.message.created"] }),
    ).toHaveLength(1);
    bus.publish(
      "agent",
      customEvent(MESSAGE_EXCLUDED_TOPIC, {
        context: discord,
        message: { context: discord, id: "m1" },
        author: owen,
        requested_by: owen,
        at: "2026-01-01T00:01:00Z",
      }),
    );
    await waitFor(async () => (await store.messages.recent("p", discord, 10)).length === 1);
    expect((await store.messages.recent("p", discord, 10)).map((e) => e.text)).toEqual(["麵"]);
    const [line] =
      (await store.events?.query({ key: "msg:discord:m1", types: ["platform.message.created"] })) ??
      [];
    expect(line?.envelope).toMatchObject({ data: { redacted: true }, key: "msg:discord:m1" });
  });

  it("records_how_each_turn_ended_so_a_reply_that_was_never_sent_can_be_found", async () => {
    const { supervisor, store } = await facts();
    const outcome = (turn: string, kind: TurnOutcomeRecord["outcome"]): TurnOutcomeRecord => ({
      turn,
      context: discord,
      reason: "addressed",
      outcome: kind,
      addressed_by: ["Owen"],
      focus: [],
      restarts: 1,
      reasoning: null,
      latency_ms: null,
      at: toTimestamp(Date.parse("2026-01-01T00:00:00Z")),
    });
    const cancelled = outcome("T1", { type: "cancelled", cause: "input", by: "Owen" });
    supervisor.bus.publish("agent", v2Event(TURN_OUTCOME_TOPIC, cancelled));
    supervisor.bus.publish(
      "agent",
      v2Event(TURN_OUTCOME_TOPIC, outcome("T2", { type: "sent", parts: 1 })),
    );
    await waitFor(
      async () => ((await store.decisions.recentOutcomes?.("p", discord, 5)) ?? []).length === 2,
    );
    const got = (await store.decisions.recentOutcomes?.("p", discord, 5)) ?? [];
    expect(got.map((o) => o.turn).sort()).toEqual(["T1", "T2"]);
    expect(got.find((o) => o.turn === "T1")).toEqual(cancelled);
    // Stored once, under its bus topic.
    expect(
      await store.events?.query({ types: ["agent.turn.outcome", "facts.result"] }),
    ).toHaveLength(2);
  });

  it("fixes_her_name_for_a_person_the_first_time_she_sees_them", async () => {
    const { supervisor, store } = await facts();
    const { StoredHandleDirectory } = await import("@miyoria/store");
    const handles = new StoredHandleDirectory(store.settings);
    supervisor.services.provide("kernel", HandleDirectoryKey, handles);
    const ts = toTimestamp(Date.parse("2026-01-01T00:00:00Z"));
    const say = (id: string, name: string, text: string) =>
      supervisor.bus.publish("platform.discord.bot", {
        type: "platform_message_created",
        data: {
          id: { context: discord, id: text },
          author: { account: { platform: "discord", id }, display_name: name, is_bot: false },
          text,
          mentions_self: false,
          reply_to_self: false,
          attachments: [],
          ts,
        },
      });
    say("1", "Owen", "hi");
    say("2", "Owen", "me too");
    await waitFor(() => handles.list().length === 2);
    expect(handles.list().map((e) => e.handle)).toEqual(["Owen", "Owen#2"]);
    // The person is recorded on the row, so `ofPerson` answers.
    const person = await store.people.personByAccount({ platform: "discord", id: "1" });
    expect(handles.ofPerson(person?.id ?? "")).toBe("Owen");
  });

  it("writes to a message log when the store has no chat events", async () => {
    const lines: string[] = [];
    const { supervisor } = await run(
      new FactsModule(
        {
          messages: {
            append: async (e) => {
              lines.push(e.text);
            },
            recent: async () => [],
            authoredSince: async () => [],
            purge: async () => 0,
          },
        },
        "p",
      ),
    );
    supervisor.bus.publish("platform.discord.bot", {
      type: "platform_message_created",
      data: {
        id: { context: discord, id: "m1" },
        author: { account: { platform: "discord", id: "1" }, display_name: "Owen", is_bot: false },
        text: "嗨",
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: toTimestamp(Date.now()),
      },
    });
    await waitFor(() => lines.length === 1);
    expect(lines).toEqual(["嗨"]);
  });

  it("records_each_llm_call_through_the_logs_buffer", async () => {
    const { supervisor, store } = await facts();
    const call = {
      call_id: "c1",
      log_day: "2026-03-10",
      requested_at: "2026-03-10T00:00:00.000Z",
      purpose: "chat",
      chain: "chat",
      kind: "chat",
      module: "agent",
      label: "reply",
      model: "m:big",
      provider: "m",
      status: "ok",
      error_kind: null,
      finish_reason: "stop",
      reasoning: "off",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        cached_prompt_tokens: 0,
        reasoning_tokens: null,
      },
      cost_usd: 0.25,
      duration_ms: 900,
      first_token_ms: 200,
      fallbacks: [],
      retries: 0,
      tools: [],
    };
    const env = supervisor.bus.publish("llm", customEvent("llm.call", call), { correlation: "T1" });
    // Not a call: left out.
    supervisor.bus.publish("llm", customEvent("llm.call", { call_id: "c2" }));
    const stored = async () => (await store.events?.query({ types: ["llm.call"] })) ?? [];
    await waitFor(async () => (await stored()).length === 1);
    const [e] = await stored();
    expect(e?.envelope).toMatchObject({
      id: env.id,
      at: env.ts,
      type: "llm.call",
      source: "llm",
      turn: "T1",
      session: null,
      person_id: null,
      scope: "owner",
      tier: "short",
      data: call,
    });
    expect(store.llmCalls?.totalsSince(env.ts)).toEqual([
      {
        model: "m:big",
        calls: 1,
        prompt_tokens: 10,
        completion_tokens: 5,
        cached_prompt_tokens: 0,
        cost_usd: 0.25,
      },
    ]);
    // Not a line of the log.
    expect(
      supervisor.services
        .get(EventLogKey)
        ?.recent(10)
        .some((l) => l.id === env.id),
    ).toBe(false);
  });
});
