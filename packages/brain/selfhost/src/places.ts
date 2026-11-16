// Where `say` may go: a place she knows, named the way she can see it.
//
// - a channel or thread by its mention (`<#id>`), `#id` or bare id;
// - a DM by `私訊:名字` (or `dm:名字`, `@名字`): the DM whose other person goes by that name.
//
// She knows a place when it has a transcript (she was there) or a place on the runner this
// process. Voice channels are never a `say` target: speaking there is the voice path's.
// Names of channels are not known here (the platform's room names are not exposed), so a channel
// is only found by its id or mention.

import type { TranscriptStore } from "@miyoria/memory/transcript";
import { type ContextKey, contextKeyEquals, safeName } from "@miyoria/types";
import { speakersOf } from "./prompt.js";

export interface PlaceBook {
  transcript: TranscriptStore;
  /** The places on the runner now, beside those with a transcript. */
  live(): readonly ContextKey[];
  /** The session of a place. */
  sessionOf(context: ContextKey): string;
}

const DM_PREFIX = /^(?:私訊|dm|DM)\s*[:：]\s*/;

function known(book: PlaceBook): ContextKey[] {
  const out: ContextKey[] = [...book.live()];
  for (const session of book.transcript.sessions()) {
    const context = book.transcript.contextOf(session);
    if (context !== null && !out.some((c) => contextKeyEquals(c, context))) out.push(context);
  }
  return out.filter((c) => c.kind !== "voice");
}

function sameName(a: string, b: string): boolean {
  const n = (s: string) => safeName(s).replace(/^@/, "").trim().toLowerCase();
  return n(a) !== "" && n(a) === n(b);
}

/** The place `name` means seen from `from`, or `null`. */
export function resolvePlace(book: PlaceBook, name: string, from: ContextKey): ContextKey | null {
  const raw = name.trim();
  if (raw === "") return null;
  const places = known(book);
  const dm = DM_PREFIX.exec(raw);
  if (dm !== null || raw.startsWith("@")) {
    const who = dm !== null ? raw.slice(dm[0].length) : raw.slice(1);
    for (const place of places) {
      if (place.kind !== "dm") continue;
      const tail = book.transcript.tail(book.sessionOf(place));
      if (speakersOf(tail.entries).some((s) => sameName(s.name, who))) return place;
    }
    return null;
  }
  const id = /^<#([^>\s]+)>$/.exec(raw)?.[1] ?? /^#?([^<>\s]+)$/.exec(raw)?.[1] ?? null;
  if (id === null) return null;
  const matches = places.filter((p) => p.kind !== "dm" && p.channel === id);
  return (
    matches.find((p) => p.platform === from.platform && p.scope === from.scope) ??
    matches.find((p) => p.platform === from.platform) ??
    matches[0] ??
    null
  );
}
