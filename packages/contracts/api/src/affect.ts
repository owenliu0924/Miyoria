// How she feels and what that does to her, read-only: `GET /api/affect` (the strongest emotions,
// the derived mood, the drives, the bias table and what she shows) and `GET /api/affect/people` (one
// card per person from the heart's rows, closest first). Changes go through the people routes.

import { z } from "zod";
import { PersonIdSchema, RELATIONSHIP_LABELS, TimestampSchema } from "../../wire/src/index.js";
import {
  DrivesSchema,
  EmotionNameSchema,
  EmotionReadingSchema,
  MoodSchema,
  ShownEmotionSchema,
} from "./inner.js";
import { route } from "./route.js";

/** What her feelings push her toward: added to her talkativeness and initiative, and her wishes. */
export const AffectBiasesSchema = z
  .object({
    /** Added to her talkativeness (-1..1). */
    talkativeness: z.number(),
    /** Added to her willingness to start things (-1..1). */
    initiative: z.number(),
    /** Per wish (`chat_with`, `play`, `stream`, `rest`, `sing`): weight 0..1 and why. */
    wants: z.array(
      z.object({
        want: z.string(),
        weight: z.number(),
        person: z.string().nullable(),
        why: z.string(),
        /** The emotion behind it, when one is (a drive otherwise). */
        from: EmotionNameSchema.optional(),
      }),
    ),
  })
  .meta({ id: "ApiAffectBiases" });
export type AffectBiases = z.output<typeof AffectBiasesSchema>;

/** `GET /api/affect`. */
export const AffectSnapshotSchema = z
  .object({
    at: TimestampSchema,
    drives: DrivesSchema,
    /** 0..1 */
    boredom: z.number(),
    /** The strongest 2 or 3 emotions only. */
    top: z.array(EmotionReadingSchema),
    /** Derived, never stored on its own. */
    mood: MoodSchema,
    /** One line for the prompt (`心情不錯、有點累`). */
    mood_line: z.string(),
    shown: ShownEmotionSchema.nullable(),
    biases: AffectBiasesSchema,
  })
  .meta({ id: "ApiAffectSnapshot" });
export type AffectSnapshot = z.output<typeof AffectSnapshotSchema>;

/** The one relationship scale (its names are the wire contract's one list). */
export const RelationshipLabelSchema = z
  .enum(RELATIONSHIP_LABELS)
  .meta({ id: "ApiRelationshipLabel" });
export type RelationshipLabel = z.output<typeof RelationshipLabelSchema>;

/** One card per person: their heart row (`heart_person`) as the panel's list shows it. */
export const PersonCardSchema = z
  .object({
    person: PersonIdSchema,
    /** The name she uses for them. */
    handle: z.string(),
    /** How she addresses them (`null`: by handle). */
    call_name: z.string().nullable(),
    /** -100..1000: the bond. */
    affinity: z.number(),
    /** 0..100 */
    trust: z.number(),
    /** 0..100 */
    familiarity: z.number(),
    /** Her impression of them in her own words. */
    feeling: z.string(),
    /** The line written for that person's own eyes (`null` or absent: none yet). */
    public_feeling: z.string().nullable().optional(),
    label: RelationshipLabelSchema,
    /** -100..1000, one per affinity point. */
    level: z.number(),
    /** How she acts with them now, one line she wrote in her reflection (`null` or absent: none). */
    stance: z.string().nullable().optional(),
    owner: z.boolean(),
    blocked: z.boolean(),
    last_seen: TimestampSchema.nullable(),
    last_together: TimestampSchema.nullable(),
    updated_at: TimestampSchema,
  })
  .meta({ id: "ApiPersonCard" });
export type PersonCard = z.output<typeof PersonCardSchema>;

export const affect = {
  /** Her emotions, derived mood, drives and the behaviour biases they imply. */
  snapshot: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/affect" })
    .output(AffectSnapshotSchema),
  /** One card per person with a heart row, closest first. */
  people: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/affect/people" })
    .output(z.array(PersonCardSchema)),
};
