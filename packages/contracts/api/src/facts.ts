// The fact layer, read-only: lines of the EventLog. Only the effects of one line are routed here
// so far; the rest of `/api/facts/*` is still on the old route table.

import { z } from "zod";
import { ContextKeySchema, JsonValueSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

export const LogEventKindSchema = z
  .enum([
    "observation",
    "thought",
    "decision",
    "utterance",
    "delivered",
    "action",
    "result",
    "steer",
    "directive",
    "proposal",
  ])
  .meta({ id: "ApiLogEventKind" });
export type LogEventKind = z.output<typeof LogEventKindSchema>;

/** One line of the EventLog. */
export const LogEventSchema = z
  .object({
    /** ULID: sorts in creation order. */
    id: z.string(),
    at: TimestampSchema,
    kind: LogEventKindSchema,
    /** What wrote it: `voice.asr`, `game.minecraft`, `plan`, ... */
    source: z.string(),
    /** The line that caused this one (`null`: nothing in the log did). */
    cause: z.string().nullable(),
    context: ContextKeySchema.nullable(),
    /** A person handle. */
    person: z.string().nullable(),
    body: JsonValueSchema,
  })
  .meta({ id: "ApiLogEvent" });
export type LogEvent = z.output<typeof LogEventSchema>;

/**
 * `limit`: how many lines at most; the server floors it and clamps it to 1..500 (default 100).
 * Not a number: 400.
 */
const LimitQuery = z.object({ limit: z.coerce.number<number | string>().optional() });

export const facts = {
  /** What a line caused, directly or further down, oldest first. */
  effects: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}/effects" })
    .input(z.object({ params: z.object({ id: z.string() }), query: LimitQuery }))
    .output(z.array(LogEventSchema)),
};
