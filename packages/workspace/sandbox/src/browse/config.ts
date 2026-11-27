import { z } from "zod";

/**
 * `[modules.sandbox.browser]`: a real browser in a `browser` job on a computer of the cluster
 * (docs/design/v6-agent-split.md P6). Its traffic leaves through the job's egress proxy like any
 * program's, so the limits here are about one person holding a machine, not about the network.
 */
export const BrowseConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** A session nobody used for this long is closed (its downloads come back first). */
  idle_minutes: z.number().positive().default(15),
  /** Longest a session lives, used or not. */
  lifetime_minutes: z.number().positive().default(120),
  /** `--memory` of one browser job, in MiB (Chromium with a few tabs wants about 1 GiB). */
  memory_mb: z.number().int().min(256).default(2048),
  /** `--cpus` of one browser job. */
  cpus: z.number().positive().default(2),
  /**
   * Sessions open at once, everyone's together. Each is a container of `memory_mb` on someone's
   * computer, so this is what keeps a few people from taking all of them.
   */
  max_sessions: z.number().int().min(0).default(6),
  /** Sessions one person (or she herself) has open at once; a new name closes their oldest. */
  per_person: z.number().int().min(1).default(2),
  /** Longest one step in the browser (open, click, read, screenshot) may take, in ms. */
  step_timeout_ms: z.number().int().min(1000).max(300_000).default(45_000),
});
export type BrowseConfig = z.output<typeof BrowseConfigSchema>;
