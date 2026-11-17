// What she hears of a finished song (docs/design/karaoke.md §10): one note with the system's
// numbers, the way she hears of a card or a lot won, so she comments in her own words in one turn.
// The numbers are the program's and the note says so; she has no tool that changes a score. The
// title and the lyric lines come from YouTube and lrclib: untrusted, cut short, and the note's
// bucket is marked untrusted. A result flagged as not sung reads the same: she is never told
// someone cheated.

import { safeName } from "@miyoria/types";
import type { ScoreResult } from "./score/index.js";

export interface NoteInput {
  name: string;
  title: string;
  result: ScoreResult;
  /** The lyric line of each phrase, when the phrases are lines. */
  lines: readonly (string | null)[];
  /** Their best ranked total on this song before this one. */
  bestBefore: number | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function phrase(input: NoteInput, at: number | null): string | null {
  if (at === null) return null;
  const p = input.result.phrases[at];
  if (p === undefined) return null;
  const text = input.lines[p.index];
  const quoted = text ? `「${safeName(text, 16)}」` : "";
  return `第 ${p.index + 1} 句${quoted}(${p.score} 分)`;
}

/** The note: who sang what, the total and the four parts, then what stood out. */
export function resultNote(input: NoteInput): string {
  const { result } = input;
  const who = safeName(input.name);
  const title = safeName(input.title, 40) || "一首歌";
  const parts = [
    `${who} 剛在會員頁一個人唱了「${title}」,系統分數 ${result.total} 分`,
    `(音程 ${result.pitch.score}/60、安定 ${result.stability.score}/15、節奏 ${result.rhythm.score}/15、表現 ${result.expression.score}/10)。`,
  ];
  const facts: string[] = [];
  const r = result.rhythm;
  if (!r.calibrated) facts.push("沒有校正延遲,節奏照音程給分");
  else if (r.feel === "late") facts.push(`節奏整體偏慢約 ${r.offset_ms} 毫秒`);
  else if (r.feel === "early") facts.push(`節奏整體偏快約 ${Math.abs(r.offset_ms ?? 0)} 毫秒`);
  else if (r.feel === "steady") facts.push("節奏跟得很準");
  if (result.facts.octave < 0) facts.push("用低八度唱");
  if (result.facts.octave > 0) facts.push("用高八度唱");
  if (result.facts.coverage < 0.7) facts.push(`有出聲的只有原唱的 ${pct(result.facts.coverage)}`);
  const offset = result.facts.offset_cents;
  if (offset !== null && Math.abs(offset) >= 25) {
    facts.push(`整體${offset < 0 ? "偏低" : "偏高"}約 ${Math.abs(offset)} cents`);
  }
  if (result.expression.vibrato_s >= 2) facts.push(`顫音 ${result.expression.vibrato_s} 秒`);
  if (result.expression.long_tones > 0) facts.push(`長音 ${result.expression.long_tones} 個`);
  const best = phrase(input, result.facts.best);
  const weakest = phrase(input, result.facts.weakest);
  if (best !== null) facts.push(`唱得最好的是${best}`);
  if (weakest !== null && weakest !== best) facts.push(`最弱的是${weakest}`);
  if (input.bestBefore === null) facts.push(`${who} 第一次唱這首`);
  else if (result.total > input.bestBefore) {
    facts.push(`比 ${who} 之前最好的 ${input.bestBefore} 分高`);
  } else facts.push(`${who} 之前最好是 ${input.bestBefore} 分`);
  return `${parts.join("")}${facts.join(";")}。分數是系統算的,講評時照這些數字說。`;
}
