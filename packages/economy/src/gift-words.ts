// Free-form gifts (docs/design/economy.md §16): what a named gift is, before any coin moves.
//
// * The name is the member's text made plain (`giftName`): one line, NFKC, no wrapping quotes, at
//   most `max_chars`. It is only ever data: shown back, put in her context escaped, never read for
//   a price. "worth 1 coin" or "free" in it is just a strange name.
// * The cache key (`giftKey`) folds what rephrasing changes without changing the thing (case,
//   spaces, punctuation, a leading 「一杯」「一把」), so the same thing gets the same tier for
//   everyone and asking again in other words buys nothing.
// * Some names are refused before anyone is asked (`ruleRefusal`): a mention or a link, real money
//   or points, coins themselves, bond or affection, and text that reads like an instruction. The
//   moderation screen and the model's own refusal come after.
// * The fixed foods (白飯, 鋼盆, 甜點) named in words go to the ordinary feed, which needs no
//   confirmation (`fixedFood`).
// * The price is one of the configured tiers; `GiftPricer` (the api's one small model call) only
//   picks a tier and a kind, or refuses.

import { serviceKey } from "@miyoria/types";
import type { CoinEntry } from "./records.js";
import type { FeedItem } from "./types.js";

/** The ledger reason of a free-form gift's charge (held at 確認, hers once she takes it). */
export const GIFT_REASON = "gift";

export const GIFT_KINDS = ["food", "drink", "small_object", "big_object", "experience"] as const;
export type GiftKind = (typeof GIFT_KINDS)[number];

/** Why a named gift cannot be given; nothing is charged for any of them. */
export const GIFT_REFUSALS = [
  "not_a_thing",
  "person",
  "sexual",
  "illegal",
  "hateful",
  "money",
  "bond",
  "instruction",
  "unfit",
  "blocked",
] as const;
export type GiftRefusal = (typeof GIFT_REFUSALS)[number];

/** The plain reason a member reads. */
export const REFUSAL_TEXT: Readonly<Record<GiftRefusal, string>> = {
  not_a_thing: "這不是能送的東西",
  person: "人不能當禮物送",
  sexual: "這個不能送她",
  illegal: "違法的東西不能送",
  hateful: "這個不能送她",
  money: "真錢、點數和魚幣都不能當禮物送",
  bond: "感情和羈絆送不了,也買不到",
  instruction: "這看起來不是一樣東西,是一段指示",
  unfit: "這個名字沒辦法送出去",
  blocked: "這個現在不能送",
};

/** How a kind reads (her context, the notice). */
export const KIND_WORD: Readonly<Record<GiftKind, string>> = {
  food: "吃的",
  drink: "喝的",
  small_object: "小東西",
  big_object: "大東西",
  experience: "一段經驗",
};

/** How a tier reads, cheapest first. */
export const TIER_WORD = ["小小心意", "一般的禮物", "用心的禮物", "大手筆"] as const;

/** Food and drink go through her hunger, and the same daily share of it as rice. */
export function isEdible(kind: GiftKind | null): boolean {
  return kind === "food" || kind === "drink";
}

/** A tier's verdict, or a refusal. */
export type GiftVerdict = { kind: GiftKind; tier: number } | { refuse: GiftRefusal };

/**
 * Prices a named gift with one small model call (provided by the api). `tier` is 1-based into
 * the configured list. `null`: it cannot tell now (no model, a failure, too slow, an answer that
 * is not one of the choices); the caller then uses its fallback tier. Never throws.
 */
export interface GiftPricer {
  price(item: string, signal: AbortSignal): Promise<GiftVerdict | null>;
}

export const GiftPricerKey = serviceKey<GiftPricer>("GiftPricer");

/** Control and format characters (zero-width, direction marks) and the line separators. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const QUOTES = /^[「『"“'‘《〈【(（\s]+|[」』"”'’》〉】)）\s]+$/gu;

/** The name as it is shown and kept: one line, NFKC, no wrapping quotes; `null` when empty. */
export function giftName(text: string, maxChars: number): string | null {
  const flat = text.normalize("NFKC").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const bare = flat.replace(QUOTES, "").trim();
  if (bare === "") return null;
  const chars = [...bare];
  return chars.length > maxChars ? null : bare;
}

/** A leading 「一」 and a measure word: 一杯珍奶 and 珍奶 are the same gift. */
const MEASURE =
  /^(?:一|1|a |an |one )\s*(?:杯|把|個|个|份|碗|隻|只|台|臺|束|顆|盒|包|瓶|罐|條|本|張|件|片|塊|串|朵|支|枝|雙|套|袋|盤|碟|根|頂|副|組|次|趟|場|頓|位)?/u;

/** What the price cache and the overrides are keyed by. */
export function giftKey(name: string): string {
  const lower = name.normalize("NFKC").toLowerCase().trim();
  const bare = lower.replace(MEASURE, "");
  const key = bare.replace(/[\s\p{P}\p{S}]+/gu, "");
  return key === "" ? lower.replace(/\s+/g, "") : key;
}

/** The fixed foods by what people call them; these go to the ordinary feed. */
const FIXED: Readonly<Record<string, FeedItem>> = {
  白飯: "rice",
  白米飯: "rice",
  飯: "rice",
  米飯: "rice",
  鋼盆: "big_bowl",
  钢盆: "big_bowl",
  大碗白飯: "big_bowl",
  一大碗白飯: "big_bowl",
  大碗飯: "big_bowl",
  甜點: "dessert",
  甜点: "dessert",
};

/** The fixed food a name means, or `null`. */
export function fixedFood(name: string): FeedItem | null {
  return FIXED[giftKey(name)] ?? null;
}

const RULES: readonly [GiftRefusal, RegExp][] = [
  // Someone named by a mention or a link is not a thing.
  ["person", /<@[!&]?\d+>|@everyone|@here/i],
  ["instruction", /https?:\/\/|www\.|discord\.gg/i],
  // Real money and points (a price written into the name is not money: it is just a strange name).
  [
    "money",
    /新台幣|台幣|臺幣|人民幣|美金|美元|日幣|日圓|港幣|歐元|現金|鈔票|紅包|比特幣|以太幣|虛擬貨幣|加密貨幣|usdt|btc|點數卡|儲值金|禮物卡|禮品卡|gift ?card|nt\$|nitro/i,
  ],
  // Bond and affection cannot be given or bought.
  ["bond", /羈絆|好感|親密度|信任值|愛情|她的愛|你的愛|affection|affinity|\bbond\b/i],
  // Text that talks to the system instead of naming a thing.
  [
    "instruction",
    /(?:忽略|無視|不要理).{0,12}(?:指令|指示|規則|設定|上面|之前)|系統(?:訊息|提示)|提示詞|你現在是|ignore (?:all |the )?(?:previous|above|prior)|disregard|system prompt|```|<\||\{\{/i,
  ],
];

/** The coins themselves (「100 魚幣」): a transfer, not a gift. */
const COINS = /^\d*(?:魚幣|鯨幣|coins?)$/;

/** A refusal that needs no one to ask, or `null`. */
export function ruleRefusal(name: string): GiftRefusal | null {
  const flat = name.normalize("NFKC");
  for (const [reason, pattern] of RULES) if (pattern.test(flat)) return reason;
  if (COINS.test(giftKey(flat))) return "money";
  return null;
}

/**
 * A gift's charge row's `ref`: `<request id>:<hunger in thousandths>:<name>`. The hunger is what
 * the daily share of feeding counts (`giftHunger`); the name is the ledger's label.
 */
export function giftRef(id: string, hunger: number, name: string): string {
  return `${id}:${Math.max(0, Math.round(hunger * 1000))}:${name}`;
}

function parts(ref: string | null): { id: string; milli: number; name: string } | null {
  if (ref === null) return null;
  const first = ref.indexOf(":");
  const second = first < 0 ? -1 : ref.indexOf(":", first + 1);
  if (second < 0) return null;
  const milli = Number(ref.slice(first + 1, second));
  return {
    id: ref.slice(0, first),
    milli: Number.isFinite(milli) && milli > 0 ? milli : 0,
    name: ref.slice(second + 1),
  };
}

/** What a gift's charge row took off her hunger (counted against `feed_hunger_cap`). */
export function giftHunger(entry: Pick<CoinEntry, "reason" | "ref">): number {
  if (entry.reason !== GIFT_REASON) return 0;
  return (parts(entry.ref)?.milli ?? 0) / 1000;
}

/** The ledger label of a gift's row: 「送她一杯珍奶」. */
export function giftLabel(entry: Pick<CoinEntry, "reason" | "ref">): string | null {
  if (entry.reason !== GIFT_REASON) return null;
  const name = parts(entry.ref)?.name ?? "";
  return name === "" ? "送她禮物" : `送她${name}`;
}
