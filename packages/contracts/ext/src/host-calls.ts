// Requests and notifications an extension sends the host while it runs: subscribing, publishing,
// registering after activation, storage and logging. Each result is `{}` unless noted.

import { z } from "zod";
import { JsonValueSchema } from "../../wire/src/index.js";

/** `events.subscribe` and `events.unsubscribe` params. The result of subscribing lists them all. */
export const ExtEventsTopicsParamsSchema = z
  .object({ topics: z.array(z.string()) })
  .meta({ id: "ExtEventsTopicsParams" });
export type ExtEventsTopicsParams = z.output<typeof ExtEventsTopicsParamsSchema>;

/** `events.publish` params: a custom event whose source is `ext.<id>`. */
export const ExtEventsPublishParamsSchema = z
  .object({
    topic: z.string(),
    payload: JsonValueSchema.default(null),
    /** A turn id, to hang the event under that turn. */
    correlation: z.string().nullable().default(null),
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
