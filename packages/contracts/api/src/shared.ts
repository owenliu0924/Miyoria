// Pieces more than one group's routes are made of.

import { z } from "zod";
import { ContextKeySchema } from "../../wire/src/index.js";

/** A context in a request body: a client may leave `scope` out, which means a DM (`null`). */
export const ContextKeyInSchema = z
  .object({
    ...ContextKeySchema.shape,
    scope: z.string().nullable().default(null),
  })
  .meta({ id: "ApiContextKeyIn" });
export type ContextKeyIn = z.input<typeof ContextKeyInSchema>;

/** A count in a query string: the digits, as a number (`limit=50`). */
export const UsizeQuery = z.coerce.number<number | string>().int().min(0);
