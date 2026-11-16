// The four ways the one turn runner is run (docs/design/v5-brain.md 「設計的結論」): the same loop
// with different limits, reasoning and tools. A profile never changes within a session, so the
// tools it leaves out are left out for the whole session and the tool list keeps its prefix.

import type { ToolEntry } from "@miyoria/llm/tools";
import type { ReasoningLevel } from "@miyoria/types";

export type ProfileName = "text" | "voice" | "subagent" | "reflect";

export const PROFILE_NAMES: readonly ProfileName[] = ["text", "voice", "subagent", "reflect"];

/** Which limit ended a run's loop. */
export type LimitName = "rounds" | "time" | "tokens" | "spend";

export interface RunLimits {
  /** Model steps that may call tools; one more step, without tools, follows when they are used up. */
  rounds: number;
  /** Tool calls run of one step; the rest are refused. */
  callsPerRound: number;
  /** Wall time of a run, checked between steps (ms). */
  wallMs: number;
  /** One tool call may take this long (ms). */
  toolMs: number;
  /** Prompt and completion tokens of a run, all steps together. */
  tokens: number;
  /** What a session may spend on models in an hour (USD). Owner decision Q6: 1. */
  sessionUsdPerHour: number;
  /**
   * The same cap in tokens, for a session whose model has no price in `[llm.pricing]`: its cost
   * cannot be counted, so its tokens are.
   */
  sessionTokensPerHour: number;
}

export interface RunProfile {
  name: ProfileName;
  /** The model chain (`[llm.purposes]`). */
  purpose: string;
  /** The `[llm.reasoning]` entry that decides the level when `reasoning` is `null`. */
  reasoningPurpose: string;
  /** A fixed level; `null`: what the purpose is configured for. */
  reasoning: ReasoningLevel | null;
  /** What she writes is said in the focus place. `false`: it is the run's result, shown to nobody. */
  speaks: boolean;
  limits: RunLimits;
  /** `max_tokens` of one step; `null`: the provider's. */
  maxStepTokens: number | null;
  /** Whether this profile offers `tool` at all. */
  offers(tool: ToolEntry): boolean;
}

const everything = (): boolean => true;
/** Not a tool that puts her words in front of people. */
const quiet = (tool: ToolEntry): boolean => tool.effect !== "say";

/** What a voice turn may reach for: it answers within a breath. */
export const VOICE_TOOLS: ReadonlySet<string> = new Set([
  "find_tools",
  "recall",
  "remember",
  "web_search",
  "check_coins",
  "voice_status",
  "remind_me",
  "say",
]);

const HOUR_USD = 1;
/** About what 1 USD buys of a flash model's cached input; only used when no price is known. */
const HOUR_TOKENS = 3_000_000;

export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  text: {
    name: "text",
    purpose: "chat",
    reasoningPurpose: "chat_text",
    reasoning: null,
    speaks: true,
    limits: {
      rounds: 10,
      callsPerRound: 6,
      wallMs: 120_000,
      toolMs: 30_000,
      tokens: 400_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: null,
    offers: everything,
  },
  voice: {
    name: "voice",
    purpose: "chat",
    reasoningPurpose: "chat_voice",
    reasoning: "off",
    speaks: true,
    limits: {
      rounds: 2,
      callsPerRound: 2,
      wallMs: 12_000,
      toolMs: 6_000,
      tokens: 60_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: 600,
    offers: (tool) => VOICE_TOOLS.has(tool.name),
  },
  subagent: {
    name: "subagent",
    purpose: "work",
    reasoningPurpose: "work",
    reasoning: "high",
    speaks: false,
    limits: {
      rounds: 40,
      callsPerRound: 8,
      wallMs: 10 * 60_000,
      toolMs: 60_000,
      tokens: 1_500_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: null,
    offers: quiet,
  },
  reflect: {
    name: "reflect",
    purpose: "chat",
    reasoningPurpose: "reflect",
    reasoning: "high",
    speaks: false,
    limits: {
      rounds: 12,
      callsPerRound: 6,
      wallMs: 5 * 60_000,
      toolMs: 60_000,
      tokens: 600_000,
      sessionUsdPerHour: HOUR_USD,
      sessionTokensPerHour: HOUR_TOKENS,
    },
    maxStepTokens: null,
    offers: quiet,
  },
};

/** `profile` with some limits replaced (tests, and a subagent's own budget). */
export function withLimits(profile: RunProfile, limits: Partial<RunLimits>): RunProfile {
  return { ...profile, limits: { ...profile.limits, ...limits } };
}
