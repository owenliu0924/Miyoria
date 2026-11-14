// The public side: what anyone may see, with no login. Nothing in these shapes points at a person,
// and the server strips whatever a response carries beyond them.

import { z } from "zod";
import { route } from "./route.js";

/** What she is doing, as the public page says it. `offline`: the modules that know are stopped. */
export const PublicStateSchema = z
  .enum(["singing", "playing", "live", "in_voice", "idle", "offline"])
  .meta({ id: "ApiPublicState" });
export type PublicState = z.output<typeof PublicStateSchema>;

/** Today's aggregate numbers. */
export const PublicTodaySchema = z
  .object({ songs_sung: z.number(), hours_live: z.number(), hours_in_voice: z.number() })
  .meta({ id: "ApiPublicToday" });
export type PublicToday = z.output<typeof PublicTodaySchema>;

/** One local day of `PublicToday`, `date` as `YYYY-MM-DD`. */
export const PublicDaySchema = PublicTodaySchema.extend({ date: z.string() }).meta({
  id: "ApiPublicDay",
});
export type PublicDay = z.output<typeof PublicDaySchema>;

/** `GET /api/public/status`. */
export const PublicStatusSchema = z
  .object({
    state: PublicStateSchema,
    live: z.boolean(),
    in_voice: z.boolean(),
    /** The game id while she plays one. */
    game: z.string().nullable(),
    today: PublicTodaySchema,
    /** The last 14 local days, oldest first, today last. */
    days: z.array(PublicDaySchema),
  })
  .meta({ id: "ApiPublicStatus" });
export type PublicStatus = z.output<typeof PublicStatusSchema>;

export const publicView = {
  /** One body serves everyone for `cache_secs`; 429 with `Retry-After` past the rate limit. */
  status: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/public/status" })
    .output(PublicStatusSchema),
};
