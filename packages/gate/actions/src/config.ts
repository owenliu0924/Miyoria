// `[modules.actions]`: the guardrails. Her judgment is not configured here, only the lines she
// cannot cross and how often she may do medium-risk things.

import { setting } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** Limits of one capability. `null` fields fall back to the tier defaults. */
export const LimitSchema = z.object({
  /** Allowed runs in any rolling 24 hours (all people together). */
  per_day: z.number().int().nonnegative().nullable().default(null),
  /** Allowed runs in any rolling 24 hours involving one person (requester or target). */
  per_person_per_day: z.number().int().nonnegative().nullable().default(null),
  /** Minimum time between two runs. A run whose executor failed starts none. */
  cooldown_ms: z.number().int().nonnegative().nullable().default(null),
  /** Allowed runs in any rolling hour (all people together). Unset: the tier's. */
  per_hour: z.number().int().nonnegative().optional(),
  /** Allowed runs in any rolling hour involving one person. Unset: the tier's. */
  per_person_per_hour: z.number().int().nonnegative().optional(),
});
export type Limit = z.output<typeof LimitSchema>;

/** Hourly limits of a tier: unset is none. */
const hourly = z.number().int().nonnegative().optional();

/** Defaults for medium- and high-risk capabilities. */
export const TierLimitSchema = z.object({
  per_day: z.number().int().nonnegative().default(30),
  per_person_per_day: z.number().int().nonnegative().default(8),
  cooldown_ms: z.number().int().nonnegative().default(20_000),
  per_hour: hourly,
  per_person_per_hour: hourly,
});
export type TierLimit = z.output<typeof TierLimitSchema>;

/**
 * `[modules.actions.work]`: defaults of the work capabilities (writing and deleting files,
 * running code, saving scripts, writing skills) instead of the medium tier's. A task that writes
 * ten files in a minute is ordinary, so there is no cooldown; the per-person AI quota and the
 * folder caps bound the rest.
 */
export const WorkLimitSchema = z.object({
  per_day: z.number().int().nonnegative().default(20_000),
  per_person_per_day: z.number().int().nonnegative().default(3000),
  cooldown_ms: z.number().int().nonnegative().default(0),
  per_hour: hourly,
  per_person_per_hour: z.number().int().nonnegative().optional().default(300),
});

/**
 * `[modules.actions.share]`: the `share` capability, which hands a file she made to the person who
 * asked, as an attachment.
 */
export const ShareConfigSchema = z.object({
  /**
   * The largest file she shares, in bytes; 0: only the platform's own limit applies. Over it, the
   * link alone goes when there is a file origin. A value written in an old config still holds.
   */
  max_bytes: z.number().int().nonnegative().default(0),
  /** Files shared in any rolling 24 hours, all people together. */
  per_day: z.number().int().nonnegative().default(60),
  /** Files shared to one person in any rolling 24 hours. */
  per_person_per_day: z.number().int().nonnegative().default(10),
  /** An archive (zip, Office and OpenDocument files, tar, tgz) that unpacks to more than this, in MiB, is refused. */
  zip_max_unpacked_mb: z.number().int().positive().default(256),
  /** A zip listing more files than this is refused. */
  zip_max_entries: z.number().int().positive().default(5000),
});
export type ShareConfig = z.output<typeof ShareConfigSchema>;

/**
 * ```toml
 * [modules.actions]
 * paused = false
 * forbidden = ["message.dm"]          # never, for anyone (patterns: "stream.*")
 * [modules.actions.limits."voice.join"]
 * per_day = 10
 * cooldown_ms = 60000
 * ```
 */
export const ActionsConfigSchema = z.object({
  /**
   * Start with the emergency stop on (`/admin autonomy resume` lifts it; the runtime choice is
   * remembered). While it is on she does not reply or speak, and only commands and the panel act.
   */
  paused: z.boolean().default(false),
  /** How long one step of the emergency stop may take before the next one runs. */
  emergency_step_ms: z.number().int().positive().default(20_000),
  /**
   * Capabilities nobody may use (`"voice.join"`, `"stream.*"`, `"*"`). Per place too
   * (docs/design/v5-places.md): a Space's and a room's lists add to this one and never lift
   * anything from it (union).
   */
  forbidden: z
    .array(z.string())
    .default([])
    .meta(
      setting({
        kind: "multi",
        scope: "room",
        merge: "union",
        label: "不能用的功能",
        help: "這裡(和整個伺服器、全部)列的功能她都不能用;只能加,不能解開上一層禁止的",
      }),
    ),
  /** Allow her and chat requests to act in another guild than the one they came from. */
  cross_guild: z.boolean().default(false),
  /** Allow DMs to people she barely knows (familiarity below `stranger_familiarity`). */
  dm_strangers: z.boolean().default(false),
  /** Familiarity (0..100) from which someone is no longer a stranger. */
  stranger_familiarity: z.number().default(10),
  /**
   * Bond (-100..1000) from which someone may ask her for real work: files, code, skills and
   * helpers (the work nodes). 15 is where 朋友 starts. Owners and anyone holding a node
   * themselves need no bond; the bond only opens the door and work never changes it.
   */
  work_min_bond: z.number().min(-100).max(1000).default(15),
  /** Defaults for medium / high risk capabilities without their own `limits`. */
  medium: TierLimitSchema.prefault({}),
  /** Defaults for the work capabilities (`Capability.work`) instead of `medium`. */
  work: WorkLimitSchema.prefault({}),
  /** The `share` capability (files as attachments). */
  share: ShareConfigSchema.prefault({}),
  /** Per-capability limits, by capability name. */
  limits: z.record(z.string(), LimitSchema.prefault({})).default({}),
  /** LLM purpose of the self-review of high-risk actions (falls back to `chat`). */
  review_purpose: z.string().default("review"),
  review_timeout_ms: z.number().int().positive().default(45_000),
  /** How long the owners have to answer an approval card; no answer = denied. */
  escalation_timeout_ms: z.number().int().positive().default(600_000),
  /**
   * How long a high-risk tool whose result matters (`followup`, e.g. `code.run`) waits for the
   * review and the run before answering "pending"; the result then comes back as a notice.
   */
  inline_wait_ms: z.number().int().nonnegative().default(8000),
  /** Register the placeholder high-risk capability `test.high` (for trying the review flow). */
  test_capability: z.boolean().default(false),
});
export type ActionsConfig = z.output<typeof ActionsConfigSchema>;

export function defaultActionsConfig(): ActionsConfig {
  return ActionsConfigSchema.parse({});
}

/** `"stream.*"` covers `stream.start`; `"*"` covers everything. */
export function capabilityMatches(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(`${prefix}.`);
  }
  return pattern === name;
}
