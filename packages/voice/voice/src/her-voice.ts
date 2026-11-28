// Her voice for one line outside a voice channel (her room, docs/design/her-room.md §3.8): the
// line is reviewed, translated and synthesized the way the voice channel's producer does it
// (`Speaker`, sink.ts), at priority `ahead` so what she says in a voice channel goes first on a
// shared worker, and handed back whole as 16-bit PCM.

import { errorMessage, type Logger, type ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type HerVoice,
  type HerVoiceDown,
  ModerationKey,
  type OutputPath,
  SpeechPauseKey,
} from "@miyoria/types";
import { SpeechError, type SpeechService } from "../../speech/src/index.js";
import type { VoiceProfile } from "./config.js";
import { stripEmoji, stripTags } from "./text.js";
import type { SpeechTranslator } from "./translate.js";

/** How long a failed synthesis keeps her voice marked as failing, ms. */
export const HER_VOICE_FAILING_MS = 60_000;

/** The output review turned the line down: it is not said, and her voice is not failing. */
export class HerVoiceRefused extends Error {
  override name = "HerVoiceRefused";
  constructor(readonly rule: string) {
    super(`the line was blocked by \`${rule}\``);
  }
}

/** Her voice cannot be heard now (`why`), so the line was not synthesized. */
export class HerVoiceUnavailable extends Error {
  override name = "HerVoiceUnavailable";
  constructor(readonly why: HerVoiceDown) {
    super(`her voice is ${why}`);
  }
}

export interface HerVoiceDeps {
  /** Where the output review (`ModerationKey`) and the GPU loan (`SpeechPauseKey`) are. */
  services: ServiceLookup;
  speech: Pick<SpeechService, "hasTts" | "synthesize">;
  profile: Pick<VoiceProfile, "voice" | "referenceFor" | "instructFor">;
  /** `tts_language`: what she speaks when she is not translated. */
  language: string | null;
  /** Set when she speaks in another language than she writes (`tts_translate`). */
  translator: Pick<SpeechTranslator, "language" | "translate"> | null;
  /** The LLM session her room's translations share. */
  session: string;
  /**
   * Whether a TTS worker answers now, as far as it can be told (the endpoint registry); `false`
   * reads as off. Left out: always assumed.
   */
  reachable?: () => boolean;
  now: () => number;
  log?: Pick<Logger, "debug" | "warn">;
}

/** The `HerVoice` provided by the `voice` module. */
export class HerVoiceService implements HerVoice {
  readonly #d: HerVoiceDeps;
  /** When a synthesis last failed (clock ms); `null` since a success or never. */
  #failedAt: number | null = null;

  constructor(deps: HerVoiceDeps) {
    this.#d = deps;
  }

  available(): { ok: true } | { ok: false; why: HerVoiceDown } {
    const { speech, services, reachable, now } = this.#d;
    if (!speech.hasTts()) return { ok: false, why: "off" };
    // The GPU is the song worker's for now: the TTS worker has no model to speak with.
    if ((services.get(SpeechPauseKey)?.paused() ?? null) !== null)
      return { ok: false, why: "lent" };
    if (reachable !== undefined && !reachable()) return { ok: false, why: "off" };
    if (this.#failedAt !== null && now() - this.#failedAt < HER_VOICE_FAILING_MS) {
      return { ok: false, why: "failing" };
    }
    return { ok: true };
  }

  async speak(
    rawText: string,
    emotion: string | null,
    signal: AbortSignal,
  ): Promise<{ sampleRate: number; samples: Int16Array }> {
    signal.throwIfAborted();
    const state = this.available();
    // A line tried while failing may find the worker back; off and lent cannot be heard at all.
    if (!state.ok && state.why !== "failing") throw new HerVoiceUnavailable(state.why);
    // Emoji and server emoji shortcodes cannot be said (docs/design/server-emoji.md).
    const text = stripEmoji(stripTags(rawText));
    if (text === "") throw new SpeechError("nothing to say");
    const { profile, language, translator, session } = this.#d;
    const written = this.#review(text, "tts");
    // What was blocked is not translated, and a translation can say what its source did not.
    const said =
      translator === null
        ? written
        : this.#review(await translator.translate(written, signal, session), "translation");
    const request = {
      text: said,
      language: translator?.language ?? language,
      emotion: profile.referenceFor(emotion),
      instruct: profile.instructFor(emotion),
      voice: profile.voice,
      priority: "ahead" as const,
    };
    try {
      const audio = await this.#synthesize(request, signal);
      this.#failedAt = null;
      return audio;
    } catch (error) {
      if (!signal.aborted) {
        this.#failedAt = this.#d.now();
        this.#d.log?.warn({ err: errorMessage(error) }, "her voice for the room failed");
      }
      throw error;
    }
  }

  /** The output review on its way to TTS: a blocked line is refused, not replaced. */
  #review(text: string, path: OutputPath): string {
    const verdict = this.#d.services.get(ModerationKey)?.screen({
      path,
      voice: text,
      context: null,
      turn: null,
    });
    if (verdict === undefined || verdict.ok) return text;
    throw new HerVoiceRefused(verdict.blocked[0]?.rule ?? "moderation");
  }

  /** The whole line, its chunks joined. */
  async #synthesize(
    request: Parameters<SpeechService["synthesize"]>[0],
    signal: AbortSignal,
  ): Promise<{ sampleRate: number; samples: Int16Array }> {
    const [provider, stream] = await this.#d.speech.synthesize(request, signal);
    const parts: Int16Array[] = [];
    let sampleRate = 0;
    for await (const chunk of stream) {
      if (chunk.samples.length === 0) continue;
      // Chunks of one stream share a sample rate.
      if (sampleRate === 0) sampleRate = chunk.sampleRate;
      parts.push(chunk.samples);
    }
    signal.throwIfAborted();
    if (parts.length === 0 || sampleRate <= 0) throw new SpeechError("TTS returned no audio");
    const samples = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      samples.set(p, at);
      at += p.length;
    }
    this.#d.log?.debug({ provider, samples: samples.length }, "her voice for the room synthesized");
    return { sampleRate, samples };
  }
}
