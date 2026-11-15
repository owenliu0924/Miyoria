// How she feels and what that does to her, read-only: `GET /api/affect` (the strongest emotions,
// the derived mood, the drives, the bias table and what she shows) and `GET /api/affect/people` (one
// card per person, highest attachment first). Bond changes stay with her own reflection and the
// people routes.

import { z } from "zod";
import { PersonIdSchema, TimestampSchema } from "../../wire/src/index.js";
import {
  DrivesSchema,
  EmotionNameSchema,
  EmotionReadingSchema,
  MoodSchema,
  PersonEmotionNameSchema,
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

/** The one relationship scale. */
export const RelationshipLabelSchema = z
  .enum([
    "很討厭",
    "討厭",
    "陌生人",
    "認識",
    "朋友",
    "好朋友",
    "摯友",
    "知心",
    "知己",
    "至交",
    "莫逆之交",
    "心有靈犀",
    "形影不離",
    "家人般",
    "生死之交",
    "命運相連",
    "無可取代",
    "心之所歸",
    "永恆羈絆",
  ])
  .meta({ id: "ApiRelationshipLabel" });
export type RelationshipLabel = z.output<typeof RelationshipLabelSchema>;

/** One card per person: the place her feeling about someone lives. */
export const PersonCardSchema = z
  .object({
    person: PersonIdSchema,
    /** The name she uses for them. */
    handle: z.string(),
    /** How she addresses them (`null`: by handle). */
    call_name: z.string().nullable(),
    /** -100..1000 */
    affinity: z.number(),
    /** 0..100 */
    trust: z.number(),
    /** 0..100 */
    familiarity: z.number(),
    /** 0..1, how much she cares. */
    attachment: z.number(),
    /** Active emotions toward them (0..1; absent: none). */
    emotions: z.partialRecord(PersonEmotionNameSchema, z.number()),
    /** Her feeling about them in her own words. */
    feeling: z.string(),
    /** The line written for that person's own eyes (`null` or absent: none yet). */
    public_feeling: z.string().nullable().optional(),
    label: RelationshipLabelSchema,
    /** -100..1000, one per affinity point. */
    level: z.number(),
    /** How she acts with them now, one line she wrote in her reflection (`null` or absent: none). */
    stance: z.string().nullable().optional(),
    /** The `level` the stance was written at. */
    stance_level: z.number().nullable().optional(),
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
  /** One card per person, highest attachment first. */
  people: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/affect/people" })
    .output(z.array(PersonCardSchema)),
};
