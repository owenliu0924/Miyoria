// Karaoke's record on the event log (docs/design/karaoke.md 「做了什麼(第一步)」): a singing that
// Core scored is one `karaoke.scored`, appended in the transaction that stores the result. It is
// the singer's: their DM scope, kept a year like the cards. The pitch track and the full result
// are in the plugin's own tables; the track is deleted after a week. A singing whose recording is
// scored later (「做了什麼第三步」) has a second one, `source: "voice"`: the official score.

import { z } from "zod";
import { defineEvent } from "./registry.js";

/** A `karaoke.scored` payload. */
export const KaraokeScoredSchema = z
  .object({
    session: z.string(),
    song: z.string(),
    /** Untrusted (from YouTube). */
    title: z.string(),
    person: z.string().nullable(),
    total: z.number(),
    pitch: z.number(),
    stability: z.number(),
    rhythm: z.number(),
    expression: z.number(),
    /** Flagged as not sung (§9): shown, never a best. */
    unranked: z.boolean(),
    /**
     * `estimate`: from the pitch the browser detected; `voice`: from the recording of the singer
     * (the official score, a second event of the same session). Older events: `estimate`.
     */
    source: z.enum(["estimate", "voice"]).default("estimate"),
  })
  .meta({ id: "EventsKaraokeScored" });
export type KaraokeScoredData = z.output<typeof KaraokeScoredSchema>;

export const KaraokeScored = defineEvent({
  type: "karaoke.scored",
  v: 1,
  data: KaraokeScoredSchema,
  scope: "dm",
  tier: "long",
});

export const KARAOKE_EVENTS = [KaraokeScored] as const;
