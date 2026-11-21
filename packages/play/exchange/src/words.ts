// Her side of the exchange (owner 2026-11-21, docs/design/exchange.md §7). She is the anchor:
//
// - Every piece of news the program drew gets a headline and a body in her words (`ExchangeWords`,
//   which the api provides with her persona); she gets only who, which way and how big, never a
//   number, and the price already moved before she writes. No model, no answer in time, or words
//   that do not pass: the plain words (`plainNews`). Her text is never an input to a price.
// - At the day's first held round, one line; at its close, one line and the day's picture in the
//   exchange's channel; each Friday's close, her rating of every company from the week's public
//   news. She sees only totals: the index, the volume, what burned, the companies' moves. Never
//   anyone's holdings, never "should I buy", never a word about anyone's liquidation.
// - She hears the day's totals as a quiet note, so she can talk about the market when asked; the
//   note says she gives nobody advice on what to buy.

import type { CommandReply } from "@miyoria/commands";
import { cardReply } from "@miyoria/commands";
import type { Logger } from "@miyoria/runtime/kernel";
import type {
  ExchangeDayFacts,
  ExchangeNewsDraft,
  ExchangeRatingItem,
  ExchangeWords,
  Pictures,
} from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import { companyOf, roundSlot, weekdayOf } from "./engine/index.js";
import { dayPictureData, withPicture } from "./pictures.js";
import { type ExchangeService, plainNews } from "./service.js";
import type { NewsRecord } from "./store.js";

/** Longest wait for one piece of her words. */
const WORDS_MS = 20_000;
/** News worded per pass at most. */
const NEWS_PER_PASS = 8;

export interface HerDeskDeps {
  service: ExchangeService;
  words: () => ExchangeWords | null;
  pictures: () => Pictures | null;
  post: (channel: string, reply: CommandReply) => Promise<string | null>;
  tell: (summary: string, key: string) => void;
  log: Logger;
  now: () => number;
}

/** A draft for her: who, which way, how big. */
export function draftOf(
  n: Pick<NewsRecord, "company" | "kind" | "direction" | "size">,
): ExchangeNewsDraft {
  const c = n.company ? companyOf(n.company) : null;
  return {
    company: c ? { code: c.code, name: c.name, blurb: c.blurb } : null,
    kind: n.kind,
    direction: n.direction,
    size: n.size,
  };
}

async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/** Her plain line when she cannot write one. */
export function plainLine(kind: "open" | "close", f: ExchangeDayFacts): string {
  const change = f.fish_ref > 0 ? f.fish / f.fish_ref - 1 : 0;
  if (kind === "open") return `深海交易所開盤了。魚市指數 FISH ${f.fish.toFixed(0)}。`;
  const sorted = [...f.companies].sort((a, b) => b.change - a.change);
  const best = sorted[0];
  const worst = sorted.at(-1);
  const movers =
    best && worst
      ? `漲最多 ${best.code} ${pct(best.change)},跌最多 ${worst.code} ${pct(worst.change)}。`
      : "";
  return `今天收盤,FISH ${f.fish.toFixed(0)}(${pct(change)}),成交 ${f.volume} 魚幣。${movers}${f.halted ? "今天熔斷過。" : ""}`;
}

/** Her plain weekly rating: the balance of the week's public news, nothing hidden. */
export function plainRating(
  codes: readonly string[],
  week: readonly ExchangeNewsDraft[],
): ExchangeRatingItem[] {
  return codes.map((code) => {
    const mine = week.filter((n) => n.company?.code === code);
    const net = mine.reduce((t, n) => t + (n.direction === "up" ? 1 : -1), 0);
    if (net > 0) return { code, rating: "買進", reason: "這週的消息偏多" };
    if (net < 0) return { code, rating: "賣出", reason: "這週的消息偏空" };
    return {
      code,
      rating: "持有",
      reason: mine.length === 0 ? "這週沒什麼消息" : "好壞消息差不多",
    };
  });
}

export class HerDesk {
  readonly #d: HerDeskDeps;

  constructor(deps: HerDeskDeps) {
    this.#d = deps;
  }

  /** One pass of her side; nothing here can fail the market's pass. */
  async run(): Promise<void> {
    const s = this.#d.service;
    if (!s.config.open) return;
    try {
      await this.#wordNews();
      await this.#day();
    } catch (error) {
      this.#d.log.warn({ err: String(error) }, "exchange: her words failed");
    }
  }

  async #wordNews(): Promise<void> {
    const s = this.#d.service;
    const words = this.#d.words();
    for (const n of s.unworded(NEWS_PER_PASS)) {
      const draft = draftOf(n);
      const hers = words ? await within(WORDS_MS, (signal) => words.news(draft, signal)) : null;
      if (hers) s.wordNews(n.id, hers.headline, hers.body, "her");
      else {
        const plain = plainNews(n);
        s.wordNews(n.id, plain.headline, plain.body, "plain");
      }
    }
  }

  /** Her opening, her closing with the day's picture, and Friday's rating, once each. */
  async #day(): Promise<void> {
    const s = this.#d.service;
    const { day } = s.clock();
    const p = s.params;
    const rounds = s.store.rounds({ from: day * p.rounds_per_day });
    const opened = rounds.find((r) => roundSlot(r.round, p) === 0 && r.status === "held");
    const closed = rounds.find(
      (r) =>
        roundSlot(r.round, p) === p.rounds_per_day - 1 &&
        (r.status === "held" || r.status === "halted"),
    );
    const commentary = s.config.commentary;
    if (opened && !s.store.words(`open:${day}`)) {
      const facts = this.#facts();
      const text =
        (commentary ? await this.#line("open", facts) : null) ?? plainLine("open", facts);
      const w = s.store.writeWords({
        key: `open:${day}`,
        kind: "open",
        day,
        text,
        by: text === plainLine("open", facts) ? "plain" : "her",
        data: null,
        created_at: this.#ts(),
      });
      if (commentary)
        await this.#post(
          w.key,
          cardReply([{ type: "text", text: w.text }], {
            accent: "neutral",
            title: "深海交易所・開盤",
          }),
        );
    }
    if (closed && !s.store.words(`close:${day}`)) {
      const facts = this.#facts();
      const her = commentary ? await this.#line("close", facts) : null;
      const text = her ?? plainLine("close", facts);
      const w = s.store.writeWords({
        key: `close:${day}`,
        kind: "close",
        day,
        text,
        by: her ? "her" : "plain",
        data: null,
        created_at: this.#ts(),
      });
      this.#d.tell(
        `${plainLine("close", facts)}(這是公開的總數;你看不到誰持有什麼,也不替任何人做買賣建議。)`,
        `exchange:close:${day}`,
      );
      if (commentary) {
        const reply = cardReply([{ type: "text", text: w.text }], {
          accent: "neutral",
          title: "深海交易所・收盤",
        });
        const drawn = await withPicture(
          this.#d.pictures(),
          "exchange_day",
          dayPictureData(s, w.text),
          reply,
        );
        await this.#post(w.key, drawn);
      }
      if (weekdayOf(day) === 5 && !s.store.words(`rating:${day}`)) await this.#rating(day, facts);
    }
  }

  async #rating(day: number, facts: ExchangeDayFacts): Promise<void> {
    const s = this.#d.service;
    const week = s.store
      .news({ limit: 200 })
      .filter((n) => n.day > day - 7)
      .map(draftOf);
    const words = this.#d.words();
    const codes = facts.companies.map((c) => c.code);
    const hers =
      this.#d.service.config.commentary && words
        ? await within(WORDS_MS, (signal) => words.rating(facts, week, signal))
        : null;
    const valid = hers?.filter((r) => codes.includes(r.code)) ?? null;
    const items = valid && valid.length === codes.length ? valid : plainRating(codes, week);
    const text = items.map((r) => `${r.code} ${r.rating}:${r.reason}`).join("\n");
    const w = s.store.writeWords({
      key: `rating:${day}`,
      kind: "rating",
      day,
      text,
      by: valid && valid.length === codes.length ? "her" : "plain",
      data: JSON.stringify(items),
      created_at: this.#ts(),
    });
    if (s.config.commentary) {
      await this.#post(
        w.key,
        cardReply([{ type: "text", text: `她這週的評等(是她的意見,她也會錯):\n${w.text}` }], {
          accent: "neutral",
          title: "深海交易所・每週評等",
        }),
      );
    }
  }

  async #line(kind: "open" | "close", facts: ExchangeDayFacts): Promise<string | null> {
    const words = this.#d.words();
    if (!words) return null;
    return within(WORDS_MS, (signal) => words.line(kind, facts, signal));
  }

  #facts(): ExchangeDayFacts {
    const m = this.#d.service.summary();
    return {
      date: m.date,
      fish: m.fish,
      fish_ref: m.fish_ref,
      level: m.level,
      volume: m.volume,
      burned: m.burned,
      halted: m.halted,
      companies: m.companies.map((c) => ({
        code: c.code,
        name: c.name,
        change: c.change,
        limit: c.limit,
      })),
      news: m.news.map((n) => ({
        company: n.company,
        kind: n.kind,
        direction: n.direction,
        size: n.size,
      })),
    };
  }

  async #post(key: string, reply: CommandReply): Promise<void> {
    const s = this.#d.service;
    const channel = s.config.channel;
    if (channel === "") return;
    const w = s.store.words(key);
    if (!w || w.posted_at !== null) return;
    const id = await this.#d.post(channel, reply);
    if (id !== null) s.store.markPosted(key, this.#ts());
  }

  #ts() {
    return toTimestamp(this.#d.now());
  }
}
