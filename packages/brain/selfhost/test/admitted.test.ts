// What other modules ask her to say, on the new runner: what the Arbiter admits (a game's
// narration, a song's announcement, a notice) is a run of the place's lane under the turn the
// Arbiter booked, never queued behind a run; `chat.start` wakes her where it was asked.

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { sleep } from "@miyoria/runtime/kernel";
import {
  type ArbiterDecision,
  type ContextKey,
  Events,
  FloorKey,
  type Impulse,
  ImpulseHostKey,
  type ImpulseInput,
  type JsonValue,
  newImpulse,
  Principals,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  account,
  channel,
  Rig,
  type RigOptions,
  says,
  stopRigs,
  textOf,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };

function member(id: string, self = false): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: self, muted: false, deafened: false };
}

const VOICE = {
  default_mode: "normal",
  debounce_ms: 150,
  direct_debounce_ms: 80,
  turn_debounce_ms: 20,
  max_debounce_ms: 1_500,
  speculate: false,
  live_context_ms: 50,
};

async function voiceRig(o: RigOptions = {}): Promise<Rig> {
  const rig = await Rig.create({ ...o, config: { ...o.config, voice: VOICE } });
  rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
    context: VC,
    participants: [member("owen"), member("amy"), member("her", true)],
  });
  await sleep(20);
  return rig;
}

function impulse(input: Partial<ImpulseInput> & Pick<ImpulseInput, "source">): Impulse {
  return newImpulse(
    { context: C1, ttlMs: 60_000, why: input.source, hint: "", reason: input.source, ...input },
    Date.now(),
  );
}

function desk(rig: Rig) {
  const host = rig.sup.services.get(ImpulseHostKey);
  if (host === undefined) throw new Error("no impulse host");
  return host;
}

/** `[text, turn]` of every `speak` action. */
function speeches(rig: Rig): [string, string | null][] {
  return rig.sink.actions.flatMap((a) =>
    a.payload.type === "speak" ? [[a.payload.text, a.turn] as [string, string | null]] : [],
  );
}

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);

describe("what the Arbiter admits", () => {
  it("a song's announcement runs in the voice channel she is in, as the turn it booked", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push(says("要開始唱囉!"));
    // The singer names the server's text channel; she is in voice there.
    rig.sup.bus.publish(
      "sing",
      Events.ArbiterImpulse,
      impulse({
        source: "song",
        context: C1,
        hint: "你要開始唱〈小星星〉了(owen 點的)。用一句話開場,說完就開始。",
        reason: "song_start",
      }) as unknown as JsonValue,
    );
    await until(() => speeches(rig).length === 1, 3_000, "her opening line");
    const [[text, turn] = ["", null]] = speeches(rig);
    expect(text).toBe("要開始唱囉!");
    const accepted = rig
      .of<ArbiterDecision>(Events.ArbiterDecided.type)
      .find((d) => d.source === "song" && d.verdict === "accepted");
    expect(accepted?.turn).toBe(turn);
    const last = String(rig.model.requests[0]?.messages.at(-1)?.content ?? "");
    expect(last).toContain("唱歌的事:你要開始唱〈小星星〉了");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(outcomes(rig)[0]).toMatchObject({ turn, context: VC, reason: "initiative" });
  });

  it("a game's urgent line holds the Floor as urgent; another claim meanwhile is busy", async () => {
    const rig = await voiceRig({ arbiter: {} });
    rig.model.push({ events: says("哇啊!"), delay: 400 });
    const first = await desk(rig).open(
      impulse({ source: "game", context: VC, hint: "剛剛死掉了!馬上用一兩句話反應。" }),
    );
    expect(first.status).toBe("started");
    const turn = first.status === "started" ? first.turn : null;
    await until(() => rig.model.requests.length === 1, 3_000, "the run");
    expect(rig.sup.services.get(FloorKey)?.holder(VC)).toMatchObject({ turn, kind: "urgent" });
    const second = await desk(rig).open(
      impulse({ source: "game", context: VC, hint: "又受傷了", attention: null }),
    );
    expect(second).toMatchObject({ status: "busy" });
    expect(textOf(rig.model.requests[0])).toContain("你正在玩的遊戲:剛剛死掉了!");
    await until(() => speeches(rig).length === 1, 3_000, "her line");
    expect(speeches(rig)[0]).toEqual(["哇啊!", turn]);
  });

  it("a notice is a result run with what came of it, told once", async () => {
    const rig = await Rig.create();
    rig.sup.bus.publish("actions", Events.AgentNotice, {
      id: "n1",
      at: toTimestamp(Date.now()),
      source: "actions",
      task: "t1",
      turn: null,
      context: C1,
      ok: true,
      code: null,
      text: "幫 amy 訂好位子了",
      expires_at: toTimestamp(Date.now() + 60_000),
    });
    await sleep(20);
    rig.model.push(says("訂好囉"));
    const run = await desk(rig).open(impulse({ source: "notice", context: C1, reason: "notice" }));
    expect(run.status).toBe("started");
    await until(() => rig.sink.texts().length === 1, 3_000, "her line");
    const request = textOf(rig.model.requests[0]);
    expect(request).toContain("剛回來的結果");
    expect(request).toContain("- 成功:幫 amy 訂好位子了");
    expect(request).toContain("通知,代號 t1");
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    // Nothing left to tell: the Arbiter hears it was said.
    const again = await desk(rig).open(
      impulse({ source: "notice", context: C1, reason: "notice" }),
    );
    expect(again).toMatchObject({ status: "refused", reason: "repeat" });
  });

  it("her own run that has said nothing gives way; chat.start wakes her where it was asked", async () => {
    let registry: ActuatorRegistry | null = null;
    const rig = await Rig.create({
      provide: (sup, tools) => {
        registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
          builtins: false,
        });
        sup.services.provide("app", ActuatorRegistryKey, registry);
      },
    });
    const actuators = registry as unknown as ActuatorRegistry;
    rig.model.push({ events: says("我想說…"), delay: 800 }, says("這局好險"));
    const started = await actuators.invoke({
      principal: Principals.panel("test", C1),
      capability: "chat.start",
      args: {},
      why: "想聊聊今天的天氣",
      turn: null,
    });
    expect(started.status).toBe("done");
    await until(() => rig.model.requests.length === 1, 3_000, "her own run");
    expect(textOf(rig.model.requests[0])).toContain("你想在這裡主動開口聊聊:想聊聊今天的天氣");
    const run = await desk(rig).open(
      impulse({ source: "game", context: C1, hint: "贏了這一局", claim: "notable" }),
    );
    expect(run.status).toBe("started");
    await until(() => rig.sink.texts().length === 1, 3_000, "the game's line");
    expect(rig.sink.texts()).toEqual(["這局好險"]);
    await until(() => outcomes(rig).length === 2, 3_000, "both outcomes");
    const cut = outcomes(rig).find((o) => o.outcome.type === "cancelled");
    expect(cut?.outcome).toMatchObject({ cause: "superseded" });
  });

  it("chat.start refuses a channel she does not talk in", async () => {
    let registry: ActuatorRegistry | null = null;
    const rig = await Rig.create({
      mode: "mention-only",
      provide: (sup, tools) => {
        registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
          builtins: false,
        });
        sup.services.provide("app", ActuatorRegistryKey, registry);
      },
    });
    const outcome = await (registry as unknown as ActuatorRegistry).invoke({
      principal: Principals.panel("test", C1),
      capability: "chat.start",
      args: {},
      why: null,
      turn: null,
    });
    expect(outcome).toMatchObject({ status: "failed" });
    await sleep(100);
    expect(rig.model.requests).toEqual([]);
  });
});
