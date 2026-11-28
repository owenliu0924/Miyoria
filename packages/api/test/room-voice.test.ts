// Her voice in the room (docs/design/her-room.md §3.8): a WAV of one line of hers in this
// account's room, within 30 minutes and not too long; made once and kept for a second tab; at most
// `voice_lines_per_hour`; and the room's state saying why it cannot be heard.

import { HerVoiceKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { HerLine } from "../src/room/channel.js";
import { ROOM_TEXT } from "../src/room/texts.js";
import { lineVoice, VOICE_LINE_MS, voiceState } from "../src/room/voice.js";
import { ALICE, BOB, makeRig, refusal } from "./room-rig.js";

const LINE = "01JF0000000000000000000001";
const LONG = "01JF0000000000000000000002";

function voiceRig(config: Record<string, unknown> = {}) {
  const rig = makeRig({ voice_max_chars: 10, ...config });
  const spoken: { text: string; emotion: string | null }[] = [];
  const available: { now: { ok: true } | { ok: false; why: "off" | "lent" | "failing" } } = {
    now: { ok: true },
  };
  rig.services.set(HerVoiceKey, {
    available: () => available.now,
    speak: async (text: string, emotion: string | null) => {
      spoken.push({ text, emotion });
      return { sampleRate: 24_000, samples: new Int16Array([0, 1000, -1000, 32767]) };
    },
  });
  const line = (id: string, text: string, at = rig.clock.t): HerLine => ({
    id,
    at,
    text,
    turn: "turn-1",
    emotion: "happy",
    artifacts: [],
    files: [],
  });
  const alice = rig.room.channel.hub(ALICE);
  alice.lines.set(LINE, line(LINE, "你好呀"));
  alice.lines.set(LONG, line(LONG, "這一行比十個字還要長很多"));
  const voice = (id: string, hub = alice) =>
    lineVoice(rig.state as never, rig.room, hub, id, undefined);
  return { ...rig, spoken, available, voice, alice };
}

describe("her voice for a line", () => {
  it("is a 16-bit PCM WAV with a 44-byte header", async () => {
    const r = voiceRig();
    const res = await r.voice(LINE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    const wav = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-length")).toBe(String(wav.byteLength));
    expect(wav.byteLength).toBe(44 + 4 * 2);
    const text = (at: number, n: number) => String.fromCharCode(...wav.slice(at, at + n));
    const v = new DataView(wav.buffer);
    expect(text(0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(24_000);
    expect(v.getUint32(28, true)).toBe(48_000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 1000, -1000, 32767]);
    // Said with her face of that line.
    expect(r.spoken).toEqual([{ text: "你好呀", emotion: "happy" }]);
  });

  it("is made once for two tabs", async () => {
    const r = voiceRig();
    const one = new Uint8Array(await (await r.voice(LINE)).arrayBuffer());
    const two = new Uint8Array(await (await r.voice(LINE)).arrayBuffer());
    expect(two).toEqual(one);
    expect(r.spoken).toHaveLength(1);
  });

  it("is a 404 for a line not of this room, too old or too long", async () => {
    const r = voiceRig();
    const bob = r.room.channel.hub(BOB);
    for (const [id, hub] of [
      [LINE, bob],
      ["01JF0000000000000000000009", r.alice],
      [LONG, r.alice],
    ] as const) {
      const error = await refusal(() => r.voice(id, hub));
      expect([error.status, error.message]).toEqual([404, ROOM_TEXT.notFound]);
    }
    r.clock.t += VOICE_LINE_MS;
    expect((await r.voice(LINE)).status).toBe(200);
    r.clock.t += 1;
    expect((await refusal(() => r.voice(LINE))).status).toBe(404);
    expect(r.spoken).toHaveLength(1);
  });

  it("allows voice_lines_per_hour lines an hour, a cached one free", async () => {
    const r = voiceRig({ voice_lines_per_hour: 2 });
    for (let i = 3; i <= 5; i++) {
      const id = `01JF000000000000000000000${i}`;
      r.alice.lines.set(id, { ...(r.alice.lines.get(LINE) as HerLine), id, text: `第${i}行` });
    }
    await r.voice("01JF0000000000000000000003");
    await r.voice("01JF0000000000000000000003");
    r.clock.t += 60_000;
    await r.voice("01JF0000000000000000000004");
    const error = await refusal(() => r.voice("01JF0000000000000000000005"));
    expect([error.status, error.message]).toEqual([429, ROOM_TEXT.voiceHour]);
    expect(error.headers["retry-after"]).toBe(String(59 * 60));
    expect(voiceState(r.state as never, r.room, ALICE)).toEqual({
      available: false,
      reason: "這小時聽太多了",
    });
    // A line already made is still served.
    expect((await r.voice("01JF0000000000000000000004")).status).toBe(200);
    // Bob's hour is his own.
    expect(voiceState(r.state as never, r.room, BOB)).toEqual({ available: true, reason: null });
    expect(r.spoken).toHaveLength(2);
  });

  it("says why it cannot be heard", async () => {
    const r = voiceRig();
    const state = () => voiceState(r.state as never, r.room, ALICE);
    expect(state()).toEqual({ available: true, reason: null });
    r.available.now = { ok: false, why: "lent" };
    expect(state()).toEqual({ available: false, reason: "聲音借給唱歌了,唱完就好" });
    let error = await refusal(() => r.voice(LINE));
    expect([error.status, error.message]).toEqual([503, ROOM_TEXT.voiceLent]);
    r.available.now = { ok: false, why: "failing" };
    expect(state()).toEqual({ available: false, reason: "她的聲音暫時出不來" });
    r.available.now = { ok: false, why: "off" };
    expect(state()).toEqual({ available: false, reason: ROOM_TEXT.voiceOff });
    r.available.now = { ok: true };
    r.services.delete(HerVoiceKey);
    expect(state()).toEqual({ available: false, reason: "她的聲音現在沒有開" });
    error = await refusal(() => r.voice(LINE));
    expect([error.status, error.message]).toEqual([503, ROOM_TEXT.voiceOff]);
    const off = voiceRig({ voice: false });
    expect(voiceState(off.state as never, off.room, ALICE)).toEqual({
      available: false,
      reason: ROOM_TEXT.voiceOff,
    });
    expect(r.spoken).toEqual([]);
  });

  it("turns a failed synthesis into her voice failing", async () => {
    const r = voiceRig();
    r.services.set(HerVoiceKey, {
      available: () => ({ ok: true }),
      speak: async () => {
        throw new Error("worker down");
      },
    });
    const error = await refusal(() => r.voice(LINE));
    expect([error.status, error.message]).toEqual([503, ROOM_TEXT.voiceFailing]);
    // The slot is given back: the next one is tried again.
    expect((await refusal(() => r.voice(LINE))).message).toBe(ROOM_TEXT.voiceFailing);
  });
});
