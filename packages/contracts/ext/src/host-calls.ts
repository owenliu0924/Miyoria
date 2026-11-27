// Requests and notifications an extension sends the host while it runs: subscribing, publishing,
// registering after activation, storage and logging. Each result is `{}` unless noted.

import { z } from "zod";
import { EventIdSchema, JsonValueSchema, TurnIdSchema } from "../../wire/src/index.js";

/** `events.subscribe` and `events.unsubscribe` params. The result of subscribing lists them all. */
export const ExtEventsTopicsParamsSchema = z
  .object({ topics: z.array(z.string()) })
  .meta({ id: "ExtEventsTopicsParams" });
export type ExtEventsTopicsParams = z.output<typeof ExtEventsTopicsParamsSchema>;

/**
 * `events.publish` params: one event of a registered type, published with source `ext.<id>`. The
 * host resolves `type` against the bus registry and checks `data` against that type's schema;
 * the rest of the envelope (`id`, `at`, the place and person fields, `scope`) is the host's.
 */
export const ExtEventsPublishParamsSchema = z
  .object({
    /** Dotted event type: `ext.<id>.<name>`, or `game.<game>.<name>` for a game adapter. */
    type: z.string(),
    /** The payload. */
    data: JsonValueSchema.default(null),
    /** The agent turn the event belongs to. */
    turn: TurnIdSchema.nullable().default(null),
    /** The event that caused this one: the `id` of an envelope the extension received. */
    parent: EventIdSchema.nullable().default(null),
    /** Attention and dedupe key. */
    key: z.string().nullable().default(null),
  })
  .meta({ id: "ExtEventsPublishParams" });
export type ExtEventsPublishParams = z.output<typeof ExtEventsPublishParamsSchema>;
export type ExtEventsPublishParamsIn = z.input<typeof ExtEventsPublishParamsSchema>;

/** `tools.unregister` params. */
export const ExtToolsUnregisterParamsSchema = z
  .object({ name: z.string() })
  .meta({ id: "ExtToolsUnregisterParams" });
export type ExtToolsUnregisterParams = z.output<typeof ExtToolsUnregisterParamsSchema>;

/** `commands.unregister` params: the path as words, or as one string split on spaces. */
export const ExtCommandsUnregisterParamsSchema = z
  .object({ path: z.union([z.array(z.string()), z.string()]) })
  .meta({ id: "ExtCommandsUnregisterParams" });
export type ExtCommandsUnregisterParams = z.output<typeof ExtCommandsUnregisterParamsSchema>;

/** `prompt.register`, `prompt.unregister` and `storage.get` params. */
export const ExtKeyParamsSchema = z.object({ key: z.string() }).meta({ id: "ExtKeyParams" });
export type ExtKeyParams = z.output<typeof ExtKeyParamsSchema>;

/** `storage.set` params. A `null` value deletes the key. */
export const ExtStorageSetParamsSchema = z
  .object({ key: z.string(), value: JsonValueSchema.nullable().default(null) })
  .meta({ id: "ExtStorageSetParams" });
export type ExtStorageSetParams = z.output<typeof ExtStorageSetParamsSchema>;
export type ExtStorageSetParamsIn = z.input<typeof ExtStorageSetParamsSchema>;

/** `storage.get` result: `null` when the key is not there. */
export const ExtStorageGetResultSchema = z
  .object({ value: JsonValueSchema.nullable() })
  .meta({ id: "ExtStorageGetResult" });
export type ExtStorageGetResult = z.output<typeof ExtStorageGetResultSchema>;

/** `log` params, as a request or a notification. `level` defaults to `info`. */
export const ExtLogParamsSchema = z
  .object({
    level: z.string().default(""),
    message: z.string(),
    fields: JsonValueSchema.nullable().default(null),
  })
  .meta({ id: "ExtLogParams" });
export type ExtLogParams = z.output<typeof ExtLogParamsSchema>;
export type ExtLogParamsIn = z.input<typeof ExtLogParamsSchema>;

/**
 * `schedule.set` params: one schedule of this extension, replaced when the id exists. Give `at`
 * (once) or `daily`, not both. Each extension keeps at most 32.
 */
export const ExtScheduleSetParamsSchema = z
  .object({
    /** `^[a-z0-9][a-z0-9_-]{0,47}$`. */
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
    /** Epoch ms, once. */
    at: z.number().optional(),
    /** `"HH:MM"` on her clock every day. */
    daily: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .optional(),
    /** At most 4 KiB as JSON; sent back as it is. */
    payload: JsonValueSchema.optional(),
  })
  .meta({ id: "ExtScheduleSetParams" });
export type ExtScheduleSetParams = z.output<typeof ExtScheduleSetParamsSchema>;

/** `schedule.cancel` params. */
export const ExtScheduleCancelParamsSchema = z
  .object({ id: z.string() })
  .meta({ id: "ExtScheduleCancelParams" });
export type ExtScheduleCancelParams = z.output<typeof ExtScheduleCancelParamsSchema>;

/** One schedule, as `schedule.list` returns it. */
export const ExtScheduleEntrySchema = z
  .object({
    id: z.string(),
    at: z.number().optional(),
    daily: z.string().optional(),
    payload: JsonValueSchema.nullable().default(null),
    /** Epoch ms of the next time it fires. */
    next: z.number().nullable().default(null),
  })
  .meta({ id: "ExtScheduleEntry" });
export type ExtScheduleEntry = z.output<typeof ExtScheduleEntrySchema>;

/** `schedule.list` result. */
export const ExtScheduleListResultSchema = z
  .object({ schedules: z.array(ExtScheduleEntrySchema) })
  .meta({ id: "ExtScheduleListResult" });
export type ExtScheduleListResult = z.output<typeof ExtScheduleListResultSchema>;

/** `schedule.fire` params (host to extension, a notification): a schedule came due. */
export const ExtScheduleFireParamsSchema = z
  .object({
    id: z.string(),
    payload: JsonValueSchema.nullable(),
    /** Epoch ms it was due. */
    due: z.number(),
  })
  .meta({ id: "ExtScheduleFireParams" });
export type ExtScheduleFireParams = z.output<typeof ExtScheduleFireParamsSchema>;
