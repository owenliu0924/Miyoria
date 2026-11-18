// The karaoke page's logic without a browser's audio: the clock, the lane's geometry, the latency
// measurement and where it is kept, the words, and the track from detections to what is sent.

import { describe, expect, it } from "vitest";
import type { KaraokeResult, KaraokeSongView } from "@miyoria/contracts/api";
import { decodeTrack, fromBase64, scoreSinging, TRACK_HZ } from "@miyoria/play/karaoke/score";
import { heardContextTime, SongClock } from "./clock";
import { lyricAt, midiRange, midiToY, NOW_AT, RANGE_MIN, timeToX, visibleNotes } from "./lane";
import {
  BLUETOOTH_MS,
  clampLatency,
  deviceKey,
  detectOnsets,
  estimateLatency,
  LAST_DEVICE,
  lastDevice,
  latencyFor,
  type Level,
  likelyBluetooth,
  loadLatency,
  measureLatency,
  median,
  noiseFloor,
  saveLatency,
} from "./latency";
import { hzToMidi, mcleodDetector, voicedMidi } from "./pitch";
import { commentPollMs } from "./Result";
import { clock, coreScored, partLines, rhythmLine, stabilityLine, type Scored } from "./result-text";
import { filterSongs, retryText } from "./SongList";
import { stageWord } from "./stages";
import { browserName, missingSupport } from "./support";
import { finishTake, liveTrackSource, provisionalScore, Take } from "./take";

describe("the song clock", () => {
  it("reads song time from the context's clock, holds still while paused and goes on after", () => {
    const c = new SongClock();
    expect(c.songTime(5)).toBe(0);
    c.start(10, 0);
    expect(c.playing).toBe(true);
    expect(c.songTime(9.5)).toBeCloseTo(-0.5);
    expect(c.songTime(12)).toBeCloseTo(2);
    expect(c.pause(13)).toBeCloseTo(3);
    expect(c.playing).toBe(false);
    expect(c.songTime(20)).toBeCloseTo(3);
    c.resume(20);
    expect(c.songTime(21.5)).toBeCloseTo(4.5);
  });

  it("places a late detection by when it was captured, and nowhere while nothing played", () => {
    const c = new SongClock();
    c.start(10, 30);
    c.pause(13);
    c.resume(20);
    expect(c.songTimeAt(9)).toBeNull();
    expect(c.songTimeAt(12.5)).toBeCloseTo(32.5);
    expect(c.songTimeAt(15)).toBeNull();
    expect(c.songTimeAt(20.5)).toBeCloseTo(33.5);
    // A restart forgets the stretches before it.
    c.start(40, 0);
    expect(c.songTimeAt(12)).toBeNull();
    expect(c.songTimeAt(41)).toBeCloseTo(1);
  });

  it("hears the output timestamp carried forward, else the context time less the output latency", () => {
    const ctx = {
      currentTime: 10,
      outputLatency: 0.04,
      getOutputTimestamp: () => ({ contextTime: 9.95, performanceTime: 1000 }),
    };
    expect(heardContextTime(ctx, 1010)).toBeCloseTo(9.96);
    expect(heardContextTime({ currentTime: 10, outputLatency: 0.04 }, 0)).toBeCloseTo(9.96);
    expect(heardContextTime({ currentTime: 10, baseLatency: 0.01 }, 0)).toBeCloseTo(9.99);
    // A timestamp of nothing yet (before the output started) falls back.
    const empty = { ...ctx, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) };
    expect(heardContextTime(empty, 5)).toBeCloseTo(9.96);
  });
});

describe("the lane", () => {
  const view = { width: 800, height: 200, now: 20, span: 8, lo: 50, hi: 70 };

  it("puts now at a quarter of the width and runs time to the right", () => {
    expect(timeToX(20, view)).toBe(800 * NOW_AT);
    expect(timeToX(26, view)).toBe(800);
    expect(timeToX(18, view)).toBe(0);
    expect(midiToY(50, view)).toBe(200);
    expect(midiToY(70, view)).toBe(0);
    expect(midiToY(60, view)).toBe(100);
  });

  it("keeps the notes that reach into the lane", () => {
    const notes = [
      { start: 10, end: 17.9, midi: 60 },
      { start: 17.5, end: 18.5, midi: 61 },
      { start: 25.9, end: 27, midi: 62 },
      { start: 26.1, end: 27, midi: 63 },
    ];
    expect(visibleNotes(notes, view).map((n) => n.midi)).toEqual([61, 62]);
  });

  it("takes the song's range with a margin, at least the smallest range", () => {
    const curve = [null, 60, 61, 62, null, 64];
    // 59 to 64 with three either side is 11: grown to 14 around it.
    expect(midiRange(curve, [{ midi: 59.4 }])).toEqual({ lo: 55, hi: 69 });
    const wide = midiRange([48, 72], []);
    expect(wide).toEqual({ lo: 45, hi: 75 });
    const flat = midiRange([60, 60, 60]);
    expect(flat.hi - flat.lo).toBe(RANGE_MIN);
    expect(midiRange([])).toEqual({ lo: 53, hi: 67 });
  });

  it("shows the line being sung and the next one", () => {
    const lines = [
      { start: 5, end: 9, text: "a" },
      { start: 10, end: null, text: "b" },
      { start: 30, end: 34, text: "c" },
    ];
    expect(lyricAt(lines, 1)).toEqual({ current: null, next: 0 });
    expect(lyricAt(lines, 6)).toEqual({ current: 0, next: 1 });
    expect(lyricAt(lines, 20)).toEqual({ current: 1, next: 2 });
    expect(lyricAt(lines, 31)).toEqual({ current: 2, next: null });
    expect(lyricAt(lines, 40)).toEqual({ current: null, next: null });
    expect(lyricAt([], 3)).toEqual({ current: null, next: null });
  });
});

describe("the latency", () => {
  const beeps = [2, 2.75, 3.5, 4.25, 5, 5.75, 6.5, 7.25];

  /** 10 ms levels: the room at 0.001, a clap `delay` after each beep that lasts 80 ms. */
  function series(delay: number, skip: number[] = []): Level[] {
    const out: Level[] = [];
    for (let t = 1.5; t < 8.5; t += 0.01) {
      const loud = beeps.some((b, i) => !skip.includes(i) && t >= b + delay && t < b + delay + 0.08);
      out.push({ t, rms: loud ? 0.08 : 0.001 + 0.0002 * Math.sin(t * 50) });
    }
    return out;
  }

  it("finds each clap's rising edge above the room", () => {
    const floor = noiseFloor(series(0.15).filter((l) => l.t < 1.9).map((l) => l.rms));
    expect(floor).toBeLessThan(0.002);
    const onsets = detectOnsets(series(0.15), floor);
    expect(onsets).toHaveLength(8);
    for (const [i, o] of onsets.entries()) expect(o - (beeps[i] as number)).toBeCloseTo(0.15, 1);
  });

  it("takes the median delay over the answered beeps, and gives up with too few", () => {
    const m = measureLatency(beeps, detectOnsets(series(0.12, [3]), 0.0012));
    expect(m?.matched).toBe(7);
    expect(Math.abs((m?.latency_ms ?? 0) - 120)).toBeLessThanOrEqual(10);
    expect(measureLatency(beeps, detectOnsets(series(0.12, [0, 1, 2, 3, 4]), 0.0012))).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("warns above 250 ms (likely Bluetooth)", () => {
    expect(likelyBluetooth(BLUETOOTH_MS)).toBe(false);
    expect(likelyBluetooth(BLUETOOTH_MS + 1)).toBe(true);
  });

  it("guesses from the browser before measuring, marked not calibrated", () => {
    expect(estimateLatency({ baseLatency: 0.01, outputLatency: 0.03 })).toBe(60);
    expect(estimateLatency({})).toBe(20);
    expect(latencyFor(null, 60)).toEqual({ latency_ms: 60, calibrated: false });
    const kept = { latency_ms: 140, measured: true, floor: 0.001, at: "" };
    expect(latencyFor(kept, 60)).toEqual({ latency_ms: 140, calibrated: true });
    expect(latencyFor({ ...kept, measured: false }, 60)).toEqual({ latency_ms: 140, calibrated: false });
    expect(clampLatency(1200)).toBe(800);
    expect(clampLatency(-900)).toBe(-200);
  });

  it("keeps it per microphone with the default output", () => {
    expect(deviceKey({ deviceId: "d1", groupId: "g1" })).toBe("miyoria.karaoke.latency:g1|default");
    expect(deviceKey({ deviceId: "d1", groupId: "" })).toBe("miyoria.karaoke.latency:d1|default");
    expect(deviceKey(null)).toBe("miyoria.karaoke.latency:default|default");
    const key = deviceKey({ groupId: "g2" });
    saveLatency(key, { latency_ms: 180, measured: true, floor: 0.002, at: "2026-11-18T00:00:00Z" });
    expect(loadLatency(key)).toEqual({ latency_ms: 180, measured: true, floor: 0.002, at: "2026-11-18T00:00:00Z" });
    expect(lastDevice()).toBe(key);
    expect(window.localStorage.getItem(LAST_DEVICE)).toBe(key);
    window.localStorage.setItem(key, "{not json");
    expect(loadLatency(key)).toBeNull();
  });

  it("does without the storage when it throws", () => {
    const broken = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    expect(loadLatency("k", broken)).toBeNull();
    expect(() => saveLatency("k", { latency_ms: 1, measured: false, floor: null, at: "" }, broken)).not.toThrow();
    expect(lastDevice(broken)).toBeNull();
    const getterThrows = () => ({
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(loadLatency("k", getterThrows)).toBeNull();
  });
});

describe("pitch", () => {
  it("turns hertz into MIDI and keeps only clear voices above the room", () => {
    expect(hzToMidi(440)).toBeCloseTo(69);
    expect(hzToMidi(220)).toBeCloseTo(57);
    expect(voicedMidi({ hz: 440, clarity: 0.95 }, 0.05, 0.01)).toBeCloseTo(69);
    expect(voicedMidi({ hz: 440, clarity: 0.85 }, 0.05, 0.01)).toBeNull();
    expect(voicedMidi({ hz: 440, clarity: 0.95 }, 0.015, 0.01)).toBeNull();
    expect(voicedMidi({ hz: 30, clarity: 0.99 }, 0.05, 0.01)).toBeNull();
  });

  it("McLeod's method finds a sung A3", () => {
    const sr = 48_000;
    const frame = new Float32Array(2048);
    for (let i = 0; i < frame.length; i++) {
      frame[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.1 * Math.sin((2 * Math.PI * 440 * i) / sr);
    }
    const d = mcleodDetector(2048);
    expect(d.name).toBe("mcleod");
    const est = d.detect(frame, sr);
    expect(est.clarity).toBeGreaterThan(0.9);
    expect(hzToMidi(est.hz)).toBeCloseTo(57, 0);
  });
});

describe("words", () => {
  it("names the worker's stages", () => {
    expect(stageWord("queued")).toBe("排隊中");
    expect(stageWord("resolve")).toBe("下載中");
    expect(stageWord("download")).toBe("下載中");
    expect(stageWord("separate")).toBe("分離人聲");
    expect(stageWord("lead")).toBe("分出主唱");
    expect(stageWord("reference")).toBe("抓旋律");
    expect(stageWord("encode")).toBe("做伴唱帶");
    expect(stageWord("lyrics")).toBe("找歌詞");
    expect(stageWord("gpu_wait")).toBe("準備中");
    expect(stageWord(null)).toBe("準備中");
  });

  const scored = (over: Partial<Scored> = {}): Scored => ({
    total: 71.3,
    pitch: { score: 42.1, max: 60, hit: 0.72 },
    stability: { score: 11, max: 15, wobble_cents: 18.4, held: 6 },
    rhythm: {
      score: 9,
      max: 15,
      calibrated: true,
      measured: true,
      offset_ms: 82,
      spread_ms: 40,
      onsets: 30,
      found: 25,
      feel: "late",
    },
    expression: { score: 6, max: 10, vibrato_s: 6.24, long_tones: 3, scoops: 0, falls: 2 },
    phrases: [],
    facts: {
      coverage: 0.9,
      best: null,
      weakest: null,
      octave: -1,
      offset_cents: -22,
      sung_s: 100,
      reference_s: 110,
    },
    ...over,
  });

  it("says each part in one line from its numbers", () => {
    const lines = partLines(scored());
    expect(lines.map((l) => [l.name, l.max])).toEqual([
      ["音程", 60],
      ["安定", 15],
      ["節奏", 15],
      ["表現", 10],
    ]);
    expect(lines.map((l) => l.line)).toEqual([
      "命中 72%,整體偏低約 22 cents,低一個八度唱",
      "長音平均晃動 18 cents(6 段)",
      "整體偏慢約 82 ms",
      "顫音 6.2 秒 · 長音 3 個 · 尾音下滑 2 次",
    ]);
  });

  it("says why rhythm was given from the pitch", () => {
    const r = scored();
    expect(rhythmLine({ ...r, rhythm: { ...r.rhythm, calibrated: false } })).toBe("沒有校正延遲,節奏照音程給分");
    expect(rhythmLine({ ...r, rhythm: { ...r.rhythm, measured: false } })).toBe("抓到的起音太少,節奏照音程給分");
    expect(rhythmLine({ ...r, rhythm: { ...r.rhythm, feel: "early", offset_ms: -70 } })).toBe("整體偏快約 70 ms");
    expect(rhythmLine({ ...r, rhythm: { ...r.rhythm, feel: "steady", offset_ms: 12 } })).toBe("拍子很準,平均差 12 ms");
    expect(stabilityLine({ ...r, stability: { ...r.stability, held: 0 } })).toBe("這首沒有要拉住的長音");
    expect(stabilityLine({ ...r, stability: { ...r.stability, wobble_cents: null } })).toBe("長音沒有唱到");
    expect(partLines(scored({ expression: { score: 0, max: 10, vibrato_s: 0, long_tones: 0, scoops: 0, falls: 0 } }))[3]?.line).toBe(
      "沒有抓到顫音或長音",
    );
    expect(clock(185)).toBe("3:05");
    expect(clock(null)).toBe("—");
  });

  it("reads Core's result with every field the contract leaves untyped", () => {
    const r = scored() as unknown as KaraokeResult;
    expect(coreScored(r).rhythm.offset_ms).toBe(82);
  });
});

describe("the track", () => {
  // A reference of 20 s: a note per second, alternating C4 and E4, silent every fifth second.
  const reference = {
    hz: 50,
    start: 0,
    midi: Array.from({ length: 1000 }, (_, i) => {
      const s = Math.floor(i / 50);
      return s % 5 === 4 ? null : s % 2 === 0 ? 60 : 64;
    }),
  };

  it("goes from detections to the recorder, to base64, and decodes back", async () => {
    const take = new Take(reference, { tolerance_cents: 50, latency_ms: 100 });
    // A singer an octave below, 100 ms late, at 100 Hz.
    for (let i = 0; i < 1200; i++) {
      const t = i / 100;
      const ref = reference.midi[Math.round((t - 0.1) * 50)];
      take.push(t, ref === null || ref === undefined ? null : ref - 12 + 0.1);
    }
    expect(take.live.octave).toBe(-12);
    expect(take.live.score).toBeGreaterThan(90);
    // The line on screen sits in the reference's octave, moved back by the latency.
    const tip = take.trail.at(-1);
    expect(tip?.t).toBeCloseTo(11.89);
    expect(take.trail.length).toBeLessThan(800);

    const done = await finishTake(take, {
      calibrated: true,
      phrases: null,
      tolerance_cents: 50,
      browser: "Chrome 131",
    });
    expect(done.body.latency_ms).toBe(100);
    expect(done.body.calibrated).toBe(true);
    expect(done.body.browser).toBe("Chrome 131");
    const bytes = fromBase64(done.body.track);
    expect(bytes).not.toBeNull();
    expect(bytes?.length).toBe(600);
    const back = decodeTrack(bytes as Uint8Array);
    expect(back[25]).toBe(48);
    expect(back[100]).toBe(52);
    expect(back[225]).toBeNull();
    // The number shown meanwhile is Core's score of exactly what is sent.
    const again = scoreSinging({
      reference,
      sung: { hz: TRACK_HZ, midi: back },
      latency_ms: 100,
      calibrated: true,
      phrases: null,
      tuning: { tolerance_cents: 50 },
    });
    expect(done.provisional?.total).toBe(again.total);
    expect(done.body.client_total).toBe(again.total);
  });

  it("starts over on a restart", async () => {
    const take = new Take(reference, { tolerance_cents: 50, latency_ms: 0 });
    for (let i = 0; i < 300; i++) take.push(i / 100, 60);
    take.restart();
    expect(take.trail).toHaveLength(0);
    expect(take.live.score).toBe(0);
    take.push(0.5, 60);
    const done = await finishTake(take, { calibrated: false, phrases: null, tolerance_cents: 50, browser: "" });
    expect(fromBase64(done.body.track)?.length).toBe(25);
    expect(done.body.calibrated).toBe(false);
  });

  it("takes the score's track from its source", async () => {
    const source = liveTrackSource("test");
    source.push(0, 60);
    source.push(0.02, 61);
    source.push(0.03, 61);
    expect(source.name).toBe("test");
    expect(decodeTrack(fromBase64(await source.finish()) as Uint8Array)).toEqual([60, 61]);
    expect(provisionalScore("%%%", reference, { latency_ms: 0, calibrated: false, phrases: null, tolerance_cents: 50 })).toBeNull();
  });
});

describe("the browser", () => {
  it("names the browser briefly", () => {
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    expect(browserName(chrome)).toBe("Chrome 131");
    expect(browserName(`${chrome} Edg/131.0.2903.70`)).toBe("Edge 131");
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Firefox 132");
    expect(
      browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"),
    ).toBe("Safari 17");
    expect(browserName("curl/8")).toBe("其他");
  });

  it("says what is missing", () => {
    const fn = () => {};
    const full = {
      isSecureContext: true,
      AudioContext: fn,
      AudioWorkletNode: fn,
      navigator: { mediaDevices: { getUserMedia: fn } },
    };
    expect(missingSupport(full)).toBeNull();
    expect(missingSupport({ ...full, isSecureContext: false })).toMatch(/https/);
    expect(missingSupport({ ...full, AudioWorkletNode: undefined })).toMatch(/即時抓音高/);
    expect(missingSupport({ ...full, navigator: {} })).toMatch(/麥克風/);
  });
});

describe("the song list's logic", () => {
  const song = (over: Partial<KaraokeSongView>): KaraokeSongView => ({
    id: "s",
    title: "",
    artist: null,
    duration_s: 200,
    state: "ready",
    stage: null,
    progress: 1,
    position: null,
    error: null,
    lyrics: true,
    lyrics_source: "found",
    notes: 100,
    mine: false,
    best: null,
    sung: 0,
    ...over,
  });

  it("filters ready songs by title or artist", () => {
    const songs = [
      song({ id: "1", title: "夜に駆ける", artist: "YOASOBI" }),
      song({ id: "2", title: "Lemon", artist: "米津玄師" }),
      song({ id: "3", title: "Lemonade", state: "preparing" }),
    ];
    expect(filterSongs(songs, "").map((s) => s.id)).toEqual(["1", "2"]);
    expect(filterSongs(songs, "lem").map((s) => s.id)).toEqual(["2"]);
    expect(filterSongs(songs, "yoasobi").map((s) => s.id)).toEqual(["1"]);
    expect(retryText(song({ id: "x", title: "Lemon", artist: "米津玄師" }))).toBe("Lemon 米津玄師");
  });

  it("asks for her comment every five seconds for four minutes while she is thinking", () => {
    const waiting = { comment: { state: "waiting", text: null } } as KaraokeResult;
    const said = { comment: { state: "said", text: "很好" } } as KaraokeResult;
    expect(commentPollMs(waiting, 0, 60_000)).toBe(5_000);
    expect(commentPollMs(waiting, 0, 4 * 60_000 + 1)).toBe(false);
    expect(commentPollMs(said, 0, 1)).toBe(false);
    expect(commentPollMs(undefined, 0, 1)).toBe(false);
  });
});
