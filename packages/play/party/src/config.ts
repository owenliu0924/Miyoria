import { z } from "zod";

/**
 * Permission nodes of the party tools for the person she plays with (`user` principals). Everyday
 * users have `chat.talk`, so anyone she talks with can ask her to start a game (`start`) and play
 * it; a role without it cannot get her to start or run one.
 */
export const PartyPermissionsSchema = z.object({
  start: z.string().default("chat.talk"),
  host: z.string().default("chat.talk"),
  play: z.string().default("chat.talk"),
});
export type PartyPermissions = z.output<typeof PartyPermissionsSchema>;

/**
 * Coins for the people who played, through `PartyRewardsKey` when someone provides it. A finished
 * game pays `coins_per_point` per point, at most `max_coins` per person, and only when at least
 * `min_players` people took part (so nobody farms coins alone with her).
 */
export const PartyRewardsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  coins_per_point: z.number().int().nonnegative().default(2),
  max_coins: z.number().int().nonnegative().default(20),
  min_players: z.number().int().min(1).default(2),
});

/**
 * `[modules.party]`: party games (docs/design/v4-plan.md §9.1, v5-play.md §5): song guessing in
 * voice, turtle soup in voice or in a text channel. Nothing starts on its own: a game only begins
 * when she calls `party_start`, so the module is on by default.
 *
 * ```toml
 * [modules.party]
 * song_rounds = 8
 * ```
 */
export const PartyConfigSchema = z.object({
  /** Songs in a song-guessing game unless she asks for another number. */
  song_rounds: z.number().int().min(1).max(30).default(8),
  /** Seconds to guess a song after its clip started. */
  song_answer_secs: z.number().int().min(5).default(60),
  /** How long the clip of a song is. */
  clip_secs: z.number().int().min(3).max(60).default(15),
  /** Turtle soup: minutes before the bottom is given. */
  soup_mins: z.number().min(1).default(15),
  /** The model chain that judges turtle-soup questions (`[llm.purposes]`; unset: the chat chain). */
  judge_purpose: z.string().default("party"),
  judge_timeout_ms: z.number().int().positive().default(8000),
  /** Nobody said anything that reached the game for this long: the game ends. */
  idle_mins: z.number().min(1).default(6),
  /** Nobody but her in the channel for this long: the game ends (a reconnect is not leaving). */
  empty_grace_secs: z.number().int().nonnegative().default(30),
  rewards: PartyRewardsConfigSchema.prefault({}),
  permissions: PartyPermissionsSchema.prefault({}),
});
export type PartyConfig = z.output<typeof PartyConfigSchema>;

export function defaultPartyConfig(): PartyConfig {
  return PartyConfigSchema.parse({});
}
