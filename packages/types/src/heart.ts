// The heart as the rest of the program sees it (docs/design/v5-heart.md §2.1, §2.5, §2.9): the
// words of a `feel` block, the words she reads for each number of a person, and the service the
// module `heart` provides (`HeartKey`). The rows and the rules that move them live in
// `@miyoria/heart/person`; the brain and memory packages do not depend on it, so what they read
// is here, as the bond's words already were.

import { type AppraisalStrength, familiarityBand, trustBand } from "./affect.js";
import type { PersonId } from "./ids.js";
import type { EmotionName } from "./self.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

// ---- a `feel` block ---------------------------------------------------------------------------

/** The numbers she may propose a change to in `feel` (the person part's `PROPOSAL_FIELDS`). */
export const FEEL_FIELDS = [
  "bond",
  "trust",
  "warmth",
  "respect",
  "ease",
  "grudge",
  "rapport",
] as const;
export type FeelField = (typeof FEEL_FIELDS)[number];

/** The word she writes for each of them (the rules of block 1 list these). */
export const FEEL_FIELD_WORDS: Readonly<Record<FeelField, string>> = {
  bond: "羈絆",
  trust: "信任",
  warmth: "好感",
  respect: "敬意",
  ease: "自在",
  grudge: "心結",
  rapport: "默契",
};

/** Her strength words, as the emotion engine's appraisal strengths. */
export const FEEL_STRENGTH_WORDS: Readonly<Record<string, AppraisalStrength>> = {
  弱: "weak",
  中: "medium",
  強: "strong",
};

/**
 * Her emotion words (the rules list the first of each row) and the plain synonyms she may use
 * instead, as the engine's emotions; `null`: nothing in particular (no stir).
 */
export const FEEL_EMOTION_WORDS: Readonly<Record<string, EmotionName | null>> = {
  開心: "joy",
  高興: "joy",
  快樂: "joy",
  愉快: "joy",
  興奮: "joy",
  喜: "joy",
  生氣: "anger",
  火大: "anger",
  憤怒: "anger",
  不爽: "anger",
  怒: "anger",
  難過: "sorrow",
  傷心: "sorrow",
  失落: "sorrow",
  委屈: "sorrow",
  沮喪: "sorrow",
  哀: "sorrow",
  害怕: "fear",
  緊張: "fear",
  不安: "fear",
  擔心: "fear",
  懼: "fear",
  驚訝: "surprise",
  意外: "surprise",
  嚇到: "surprise",
  驚: "surprise",
  討厭: "disgust",
  噁心: "disgust",
  嫌棄: "disgust",
  厭煩: "disgust",
  厭: "disgust",
  害羞: "shy",
  不好意思: "shy",
  難為情: "shy",
  得意: "pride",
  驕傲: "pride",
  自豪: "pride",
  吃醋: "jealousy",
  嫉妒: "jealousy",
  寂寞: "lonely",
  孤單: "lonely",
  想念: "missing",
  感激: "gratitude",
  感謝: "gratitude",
  感動: "gratitude",
  愧疚: "guilt",
  內疚: "guilt",
  不甘心: "frustration",
  懊惱: "frustration",
  挫折: "frustration",
  煩躁: "frustration",
  平靜: null,
  普通: null,
  還好: null,
  平常: null,
};

/** One proposal of hers about one person: a direction, never a size. */
export interface FeelProposal {
  field: FeelField;
  direction: "up" | "down";
  /** What happened, in her quote: the reason the change records. */
  quote: string;
}

// ---- the words she reads for a person ---------------------------------------------------------

/** What the readers of the heart see of one person (a `heart_person` row's numbers and words). */
export interface HeartView {
  person: PersonId;
  /** -100..1000. */
  bond: number;
  /** 0..100. */
  trust: number;
  /** 0..100. */
  familiarity: number;
  /** -1..1. */
  warmth: number;
  /** -1..1. */
  respect: number;
  /** 0..1. */
  ease: number;
  /** 0..1. */
  grudge: number;
  /** 0..1. */
  longing: number;
  /** 0..1. */
  rapport: number;
  stance: string;
  impression: string;
  call_name: string | null;
  tags: readonly string[];
  owner: boolean;
  blocked: boolean;
  last_seen: Timestamp | null;
  last_together: Timestamp | null;
}

/** `[lowest value, words]`, highest first: the first whose value is reached. */
type Bands = readonly (readonly [number, string])[];

function band(bands: Bands, value: number, below: string): string {
  for (const [min, words] of bands) if (value >= min) return words;
  return below;
}

const WARMTH: Bands = [
  [0.7, "很喜歡"],
  [0.45, "很有好感"],
  [0.15, "有好感"],
  [-0.15, "普通"],
  [-0.5, "有點冷淡"],
];
const RESPECT: Bands = [
  [0.5, "很佩服"],
  [0.15, "欣賞"],
  [-0.15, "普通"],
  [-0.5, "不太佩服"],
];
const EASE: Bands = [
  [0.7, "很自在"],
  [0.4, "自在"],
  [0.15, "有點放得開"],
];
const GRUDGE: Bands = [
  [0.6, "心結很深"],
  [0.3, "有心結"],
  [0.1, "有點心結"],
];
const LONGING: Bands = [
  [0.7, "很想念"],
  [0.4, "想念"],
  [0.15, "有點想念"],
];
const RAPPORT: Bands = [
  [0.7, "很有默契"],
  [0.4, "有默契"],
  [0.15, "有點默契"],
];

/** The eight values besides the bond, as she reads them: words, never a number. */
export interface HeartWords {
  trust: string;
  familiarity: string;
  warmth: string;
  respect: string;
  ease: string;
  grudge: string;
  longing: string;
  rapport: string;
}

const num = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** The words of each value of `v` (the bands are defined once, here). */
export function heartWords(
  v: Pick<
    HeartView,
    "trust" | "familiarity" | "warmth" | "respect" | "ease" | "grudge" | "longing" | "rapport"
  >,
): HeartWords {
  return {
    trust: trustBand(num(v.trust)),
    familiarity: familiarityBand(num(v.familiarity)),
    warmth: band(WARMTH, num(v.warmth), "很冷淡"),
    respect: band(RESPECT, num(v.respect), "看不起"),
    ease: band(EASE, num(v.ease), "拘謹"),
    grudge: band(GRUDGE, num(v.grudge), "沒有心結"),
    longing: band(LONGING, num(v.longing), "不特別想"),
    rapport: band(RAPPORT, num(v.rapport), "還沒默契"),
  };
}

/** From this grudge on, block 7 says so in a sentence of its own. */
export const GRUDGE_CUE = 0.3;
/** From this longing on, block 7 says so in a sentence of its own. */
export const LONGING_CUE = 0.4;

/** The sentences block 7 adds for someone she holds a grudge against or misses a lot. */
export function heartCues(v: Pick<HeartView, "grudge" | "longing">): string[] {
  const out: string[] = [];
  if (num(v.grudge) >= GRUDGE_CUE) out.push("你對他還有心結,還沒說開");
  if (num(v.longing) >= LONGING_CUE) out.push("你很想他");
  return out;
}

// ---- the service ------------------------------------------------------------------------------

/**
 * From this much 在意 on (`cares` of the person part, 0..1), she cares about someone: world, self,
 * mind and her initiative all use this one threshold (owner decision H5).
 */
export const CARES_THRESHOLD = 0.3;

/** One line someone said, as the heart keeps count of it. */
export interface HeartLine {
  text: string;
  /** Said to her (a mention, a reply, a DM, her name). */
  directed: boolean;
  /** Said with her: to her, or in the voice channel she is in. */
  together: boolean;
  /** Epoch ms. */
  at: number;
}

/**
 * Her numbers and words for each person, provided by the module `heart`. Everything that moves a
 * number goes through its store's rules (steps, caps, anchors); readers get words and views.
 */
export interface HeartPeople {
  /**
   * Her `feel` proposals about `person` from the run of `turn`, applied by the rules (cause
   * `feel`). Someone tagged `blocked` is never moved. How many were applied.
   */
  feel(
    person: PersonId,
    proposals: readonly FeelProposal[],
    options: { turn: string | null; now?: number },
  ): number;
  /** `person` said a line: when she last saw them, talked and was with them, and familiarity. */
  seen(person: PersonId, line: HeartLine): void;
  view(person: PersonId): HeartView | null;
  /** How much she cares about `person` (在意, 0..1; 0 for someone without a row). */
  cares(person: PersonId): number;
  /**
   * The one she cares about most, if that is at or above the threshold (`CARES_THRESHOLD`);
   * among `among` when given. Where the old crush (暗戀) behaviours hang now (H5).
   */
  mostCared(among?: readonly PersonId[]): { person: PersonId; cares: number } | null;
  /** Everyone she cares about (at or above the threshold), most first, at most `max`. */
  caredAbout(max: number): { person: PersonId; cares: number }[];
}

export const HeartKey = serviceKey<HeartPeople>("HeartPeople");
