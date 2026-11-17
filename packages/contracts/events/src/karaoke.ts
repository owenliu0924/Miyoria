// Karaoke's record on the event log (docs/design/karaoke.md 「做了什麼(第一步)」): a singing that
// Core scored is one `karaoke.scored`, appended in the transaction that stores the result. It is
// the singer's: their DM scope, kept a year like the cards. The pitch track and the full result
// are in the plugin's own tables; the track is deleted after a week.

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
