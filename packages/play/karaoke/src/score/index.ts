// @miyoria/play/karaoke/score: the karaoke score, shared by the singer's browser and Core
// (docs/design/karaoke.md §5.4). Plain TypeScript with no imports outside this folder, no DOM and
// no Node, so the panel takes it without pulling Core into its bundle.
//
// - `track.ts`: pitch tracks, their one-byte-a-frame form at 50 Hz, base64, resampling.
// - `curve.ts`: what is read off the reference curve (runs, onsets, held stretches, phrases).
// - `score.ts`: `scoreSinging`, the four parts, phrases and the facts her comment uses.
// - `expression.ts`: vibrato, long tones, scoops and falls.
// - `live.ts`: `LiveScore`, the running number while singing.

export type { Span } from "./curve.js";
export type { Expression } from "./expression.js";
export { LiveScore } from "./live.js";
export {
  alignSung,
  DEFAULT_TUNING,
  frameCredit,
  PARTS,
  type PhraseScore,
  type PhraseTime,
  phraseSpans,
  pitchFraction,
  type ReferenceCurve,
  type RhythmFeel,
  type ScoreInput,
  type ScoreResult,
  type ScoreTuning,
  scoreSinging,
} from "./score.js";
export {
  asSubmitted,
  decodeTrack,
  encodeTrack,
  fromBase64,
  type PitchFrames,
  type PitchTrack,
  resampleTrack,
  TRACK_HZ,
  TRACK_MIDI_BASE,
  TRACK_MIDI_TOP,
  TRACK_STEPS,
  toBase64,
} from "./track.js";
