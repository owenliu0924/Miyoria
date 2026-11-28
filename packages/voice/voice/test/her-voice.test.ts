// Her voice for one line in her room (docs/design/her-room.md §3.8).

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  ModerationKey,
  type ModerationService,
  type OutputCheck,
  SpeechPauseKey,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import type { AudioChunk, AudioStream, SpeechService, TtsRequest } from "../../speech/src/index.js";
import { VoiceProfile } from "../src/config.js";
import {
  HER_VOICE_FAILING_MS,
  type HerVoiceDeps,
  HerVoiceRefused,
  HerVoiceService,
  HerVoiceUnavailable,
} from "../src/her-voice.js";

/** A TTS that answers with `chunks`, or fails while `fail` is set. */
class FakeSpeech implements Pick<SpeechService, "hasTts" | "synthesize"> {
  readonly requests: TtsRequest[] = [];
  fail: Error | null = null;
  chunks: AudioChunk[] = [
    { sampleRate: 24_000, samples: Int16Array.from([1, 2, 3]) },
    { sampleRate: 24_000, samples: new Int16Array(0) },
    { sampleRate: 24_000, samples: Int16Array.from([4, 5]) },
  ];

  constructor(readonly tts = true) {}

  hasTts(): boolean {
    return this.tts;
  }

  async synthesize(request: TtsRequest): Promise<[string, AudioStream]> {
    this.requests.push(request);
    if (this.fail !== null) throw this.fail;
    const chunks = this.chunks;
    return [
      "fake",
      (async function* () {
        yield* chunks;
      })(),
    ];
  }
}

const profile = VoiceProfile.parse("p", {
  voice: "her-voice",
  emotion: { instruct: { happy: "brightly" } },
  design: { bank: { Japanese: { happy: "line" } } },
});

function setup(overrides: Partial<HerVoiceDeps> = {}) {
  let now = 1_000_000;
  const services = new ServiceRegistry();
  const speech = new FakeSpeech();
  const voice = new HerVoiceService({
    services,
    speech,
    profile,
    language: "Chinese",
    translator: null,
    session: "s",
    now: () => now,
    ...overrides,
  });
  return {
    voice,
    speech: (overrides.speech as FakeSpeech | undefined) ?? speech,
    services,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Blocks whatever holds `word`, and remembers what it was asked. */
function review(services: ServiceRegistry, word = "禁語"): OutputCheck[] {
  const asked: OutputCheck[] = [];
  const service = {
    filteredLine: "Filtered.",
    filteredVoiceLine: "嗶。",
    screen: (check: OutputCheck) => {
      asked.push(check);
      const hit = check.voice?.includes(word) === true;
      return {
        ok: !hit,
        visible: null,
        voice: hit ? "嗶。" : (check.voice ?? null),
        blocked: hit
          ? [{ field: "voice", category: "custom", rule: "test.word", layer: "rules" }]
          : [],
      };
    },
  } as unknown as ModerationService;
  services.provide("app", ModerationKey, service);
  return asked;
}

const signal = () => new AbortController().signal;

describe("her voice in the room", () => {
  it("is off without TTS", async () => {
    const speech = new FakeSpeech(false);
    const { voice } = setup({ speech });
    expect(voice.available()).toEqual({ ok: false, why: "off" });
    await expect(voice.speak("你好", null, signal())).rejects.toBeInstanceOf(HerVoiceUnavailable);
    expect(speech.requests).toEqual([]);
  });

  it("is off while no TTS worker can be reached", () => {
    let reachable = false;
    const { voice } = setup({ reachable: () => reachable });
    expect(voice.available()).toEqual({ ok: false, why: "off" });
    reachable = true;
    expect(voice.available()).toEqual({ ok: true });
  });

  it("is lent while the GPU is the song worker's", async () => {
    const { voice, services, speech } = setup();
    let paused: string | null = "song";
    services.provide("sing", SpeechPauseKey, { paused: () => paused });
    expect(voice.available()).toEqual({ ok: false, why: "lent" });
    await expect(voice.speak("你好", null, signal())).rejects.toMatchObject({ why: "lent" });
    expect(speech.requests).toEqual([]);
    paused = null;
    expect(voice.available()).toEqual({ ok: true });
  });

  it("is failing for a minute after a synthesis failed, then comes back", async () => {
    const { voice, speech, advance } = setup();
    speech.fail = new Error("worker down");
    await expect(voice.speak("你好", null, signal())).rejects.toThrow("worker down");
    expect(voice.available()).toEqual({ ok: false, why: "failing" });
    advance(HER_VOICE_FAILING_MS - 1);
    expect(voice.available()).toEqual({ ok: false, why: "failing" });
    advance(1);
    expect(voice.available()).toEqual({ ok: true });
  });

  it("a line that works while failing clears it", async () => {
    const { voice, speech } = setup();
    speech.fail = new Error("worker down");
    await expect(voice.speak("你好", null, signal())).rejects.toThrow();
    speech.fail = null;
    await voice.speak("你好", null, signal());
    expect(voice.available()).toEqual({ ok: true });
  });

  it("a cancelled line does not mark her voice failing", async () => {
    const { voice, speech } = setup();
    const controller = new AbortController();
    speech.fail = new Error("aborted");
    controller.abort();
    await expect(voice.speak("你好", null, controller.signal)).rejects.toThrow();
    expect(voice.available()).toEqual({ ok: true });
  });

  it("speaks through the review and the TTS, with the emotion's voice, at priority ahead", async () => {
    const { voice, speech, services } = setup();
    const asked = review(services);
    const audio = await voice.speak("<emo:happy>今天好開心", "happy", signal());
    expect(audio.sampleRate).toBe(24_000);
    expect(audio.samples).toBeInstanceOf(Int16Array);
    expect([...audio.samples]).toEqual([1, 2, 3, 4, 5]);
    expect(asked).toEqual([{ path: "tts", voice: "今天好開心", context: null, turn: null }]);
    expect(speech.requests).toEqual([
      {
        text: "今天好開心",
        language: "Chinese",
        emotion: profile.referenceFor("happy"),
        instruct: "brightly",
        voice: "her-voice",
        priority: "ahead",
      },
    ]);
  });

  it("translates when she speaks another language, and reviews the translation too", async () => {
    const translated: Array<[string, string | undefined]> = [];
    const { voice, speech, services } = setup({
      translator: {
        language: "Japanese",
        translate: async (text, _signal, session) => {
          translated.push([text, session]);
          return "こんにちは";
        },
      },
      session: "room-session",
    });
    const asked = review(services);
    await voice.speak("你好", null, signal());
    expect(translated).toEqual([["你好", "room-session"]]);
    expect(asked.map((c) => [c.path, c.voice])).toEqual([
      ["tts", "你好"],
      ["translation", "こんにちは"],
    ]);
    expect(speech.requests[0]).toMatchObject({ text: "こんにちは", language: "Japanese" });
  });

  it("a line the review refuses is not synthesized, and her voice is not failing", async () => {
    const { voice, speech, services } = setup();
    review(services);
    const speaking = voice.speak("那個禁語", null, signal());
    await expect(speaking).rejects.toBeInstanceOf(HerVoiceRefused);
    await expect(speaking).rejects.toMatchObject({ rule: "test.word" });
    expect(speech.requests).toEqual([]);
    expect(voice.available()).toEqual({ ok: true });
  });

  it("a translation the review refuses is not synthesized", async () => {
    const { voice, speech, services } = setup({
      translator: { language: "Japanese", translate: async () => "禁語です" },
    });
    review(services);
    await expect(voice.speak("你好", null, signal())).rejects.toBeInstanceOf(HerVoiceRefused);
    expect(speech.requests).toEqual([]);
  });

  it("TTS that returns no audio is a failure", async () => {
    const { voice, speech } = setup();
    speech.chunks = [{ sampleRate: 24_000, samples: new Int16Array(0) }];
    await expect(voice.speak("你好", null, signal())).rejects.toThrow("no audio");
    expect(voice.available()).toEqual({ ok: false, why: "failing" });
  });
});
