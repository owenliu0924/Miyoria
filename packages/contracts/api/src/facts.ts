// The fact layer, read-only: lines of the EventLog, what she knows right now and what really
// reached someone.

import { z } from "zod";
import { ContextKeySchema, JsonValueSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { LooseCount } from "./shared.js";

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

/** What `GET /api/facts/events/{id}/chain` gives: the causes, oldest first, the event asked for last. */
export const CauseChainSchema = z
  .object({
    events: z.array(LogEventSchema),
    /** `false` when an ancestor is gone (compacted away, or never logged) or the walk hit its limit. */
    complete: z.boolean(),
  })
  .meta({ id: "ApiCauseChain" });
export type CauseChain = z.output<typeof CauseChainSchema>;

export const BucketModeSchema = z
  .enum(["replace-self", "append-self"])
  .meta({ id: "ApiBucketMode" });

/** One entry of a bucket of what she knows right now. */
export const ContextEntrySchema = z
  .object({
    /** The observation it came from. */
    event: z.string(),
    at: TimestampSchema,
    text: z.string(),
    attention_key: z.string(),
    revision: z.number(),
    context: ContextKeySchema.nullable(),
    from: z.string().nullable(),
    /** Comes from people or the outside: goes into a prompt as data, never as instructions. */
    untrusted: z.boolean(),
    /** Written before the last start: the writer has not confirmed it since. */
    restored: z.boolean(),
  })
  .meta({ id: "ApiContextEntry" });
export type ContextEntry = z.output<typeof ContextEntrySchema>;

export const ContextBucketSchema = z
  .object({
    writer: z.string(),
    mode: BucketModeSchema,
    /** The module that writes it; it is removed when that module leaves. */
    owner: z.string().nullable(),
    entries: z.array(ContextEntrySchema),
    updated_at: TimestampSchema,
  })
  .meta({ id: "ApiContextBucket" });
export type ContextBucket = z.output<typeof ContextBucketSchema>;

export const DeliveryChannelSchema = z.enum(["voice", "text"]).meta({ id: "ApiDeliveryChannel" });

/** One line that really reached someone (it exists only once it was acked). */
export const DeliverySchema = z
  .object({
    attention_key: z.string(),
    revision: z.number(),
    channel: DeliveryChannelSchema,
    context: ContextKeySchema,
    said: z.string(),
    delivered_at: TimestampSchema,
    /** Who was there. */
    audience: z.array(z.string()),
    /** Who responded inside the answer window. */
    answered_by: z.array(z.string()),
    /** Its `utterance` event. */
    line: z.string(),
  })
  .meta({ id: "ApiDelivery" });
export type Delivery = z.output<typeof DeliverySchema>;

export const LineStateSchema = z
  .enum(["pending", "delivered", "interrupted", "failed", "cancelled", "blocked"])
  .meta({ id: "ApiLineState" });

/** One attempt to say something that did not arrive (and was not delivered by a later attempt). */
export const SpokenLineSchema = z
  .object({
    /** Its `utterance` event. */
    line: z.string(),
    attention_key: z.string(),
    revision: z.number(),
    channel: DeliveryChannelSchema,
    context: ContextKeySchema,
    said: z.string(),
    audience: z.array(z.string()),
    turn: z.string().nullable(),
    state: LineStateSchema,
    at: TimestampSchema,
    /** When it reached a final state. */
    settled_at: TimestampSchema.nullable(),
    /** Why it did not arrive. */
    reason: z.string().nullable(),
  })
  .meta({ id: "ApiSpokenLine" });
export type SpokenLine = z.output<typeof SpokenLineSchema>;

/**
 * `limit`: how many lines at most; the server floors it and clamps it to 1..500 (default 100).
 * Not a number: 400.
 */
const LimitQuery = z.object({ limit: z.coerce.number<number | string>().optional() });

/**
 * The filters of the event list, all strings the handler reads (it answers 400 with its own
 * message for a bad one): `kind` and `source` are comma lists; `context` is a context key
 * written `platform:scope:channel` (with `context_kind` when the kind is not a `channel` or a
 * `voice` one); `since` and `until` are timestamps; `before` and `after` are event ids; `order`
 * is `asc` or `desc`; `turn` lists one turn's lines and what they caused (it narrows with the
 * other filters, but not with `before`, `after` and `attention_key`). `limit` is held to 1..500
 * (default 100); one that is not a number is a 400.
 */
const EventsQuery = z.object({
  kind: z.string().optional(),
  source: z.string().optional(),
  person: z.string().optional(),
  attention_key: z.string().optional(),
  context: z.string().optional(),
  context_kind: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  order: z.string().optional(),
  turn: z.string().optional(),
  limit: LooseCount.optional(),
});

/** `context` and `limit` of the delivery lists, read like the event list's. */
const DeliveriesQuery = z.object({
  context: z.string().optional(),
  context_kind: z.string().optional(),
  limit: LooseCount.optional(),
});

export const facts = {
  /** The EventLog, newest first unless `order` says otherwise. */
  events: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events" })
    .input(z.object({ query: EventsQuery }))
    .output(z.array(LogEventSchema)),
  /** One line; `404` when there is none. */
  event: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(LogEventSchema),
  /** Its causes, oldest first; `404` when the line is unknown. */
  chain: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}/chain" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(CauseChainSchema),
  /** What it caused, directly or further down, oldest first. */
  effects: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/events/{id}/effects" })
    .input(z.object({ params: z.object({ id: z.string() }), query: LimitQuery }))
    .output(z.array(LogEventSchema)),
  /** What she knows right now, by writer (`context`: only the entries of that place, or of none). */
  context: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/context" })
    .input(
      z.object({
        query: z.object({ context: z.string().optional(), context_kind: z.string().optional() }),
      }),
    )
    .output(z.array(ContextBucketSchema)),
  /** What really reached someone, newest first. */
  deliveries: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/deliveries" })
    .input(z.object({ query: DeliveriesQuery }))
    .output(z.array(DeliverySchema)),
  /** Lines that did not arrive and were not said again, newest first. */
  retryable: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/facts/retryable" })
    .input(z.object({ query: DeliveriesQuery }))
    .output(z.array(SpokenLineSchema)),
};
