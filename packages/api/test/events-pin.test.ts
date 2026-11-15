// `GET /api/events`: the exact bytes the admin event stream writes for a bus envelope (the panel's
// event list and `miyoria tail` read them). The expected strings are today's wire form
// (`{id, ts, source, causation, correlation, event}`, `event` being `{type, data}`); they must not
// change while the bus's own envelope does.

import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { type ContextKey, customEvent, type Event, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";

const TOKEN = "test-token";
const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const T0 = Date.UTC(2026, 10, 15, 6, 0, 0, 123);

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  return { sup, base };
}

/** Reads SSE frames (comments skipped) until `count` events have arrived. */
async function frames(body: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const out: string[] = [];
  try {
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
        const frame = text.slice(0, end + 2);
        text = text.slice(end + 2);
        if (!frame.startsWith(":")) out.push(frame);
      }
    }
  } finally {
    await reader.cancel();
  }
  return out;
}

describe("the admin event stream", () => {
  it("writes a typed event and a custom one exactly as before", async () => {
    const { sup, base } = await harness();
    const res = await fetch(`${base}/api/events?topics=platform.*,agent.turn.completed,stage.*`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    if (res.body === null) throw new Error("no body");
    const typing: Event = {
      type: "platform_typing",
      data: { context: TEXT, account: { platform: "discord", id: "100" } },
    };
    const first = sup.bus.publish("discord", typing, { now: T0 });
    const done: Event = {
      type: "agent_turn_completed",
      data: { turn: "01JC0000000000000000000000", context: TEXT, text: '嗨\n"你好"' },
    };
    const second = sup.bus.publish("agent", done, {
      now: T0 + 1,
      correlation: "01JC0000000000000000000000",
      causation: first.id,
    });
    // Not asked for: filtered out by the stream.
    sup.bus.publish("core", customEvent("system.shutdown", {}), { now: T0 + 2 });
    const third = sup.bus.publish("stage", customEvent("stage.error", { message: "斷線" }), {
      now: T0 + 3,
      correlation: "01JC0000000000000000000000",
      causation: second.id,
    });
    const got = await frames(res.body, 3);
    const ts = (ms: number) => toTimestamp(ms);
    expect(got).toEqual([
      `id: ${first.id}\ndata: {"id":"${first.id}","ts":"${ts(T0)}","source":"discord","causation":null,"correlation":null,"event":{"type":"platform_typing","data":{"context":{"platform":"discord","scope":"g1","channel":"c1","kind":"channel"},"account":{"platform":"discord","id":"100"}}}}\n\n`,
      `id: ${second.id}\ndata: {"id":"${second.id}","ts":"${ts(T0 + 1)}","source":"agent","causation":"${first.id}","correlation":"01JC0000000000000000000000","event":{"type":"agent_turn_completed","data":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"g1","channel":"c1","kind":"channel"},"text":"嗨\\n\\"你好\\""}}}\n\n`,
      `id: ${third.id}\ndata: {"id":"${third.id}","ts":"${ts(T0 + 3)}","source":"stage","causation":"${second.id}","correlation":"01JC0000000000000000000000","event":{"type":"custom","data":{"topic":"stage.error","payload":{"message":"斷線"}}}}\n\n`,
    ]);
  });
});
