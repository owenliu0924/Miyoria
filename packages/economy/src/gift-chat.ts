// Gifts offered in conversation (docs/design/economy.md §16, 「說一聲就送」): a member tells her
// 「送你一杯珍奶」 and she calls `gift_quote` (gift-tools.ts), which lands here.
//
// * Nothing is charged here. A named thing goes through the same `GiftDesk.ask` as
//   `/me feed thing:` (rules, moderation, the owner's pins and blocks, the price cache and the
//   price-call budget, the day's limits), and the quote is posted as a card where the words were
//   said: a reply to the member's message in a channel or a DM, the voice room's text chat in
//   voice, else a DM to the member. A fixed food named in words (白飯, 鋼盆, 甜點) gets a card with
//   one 確認 too: from chat nothing is ever charged without the payer's own press, which is
//   stricter than the slash command on purpose (there the member typed the command themselves).
// * The card is public, so it never shows a balance, and only the payer can use it: anyone else
//   pressing is answered privately and nothing changes. After 確認 the card says what happened,
//   still without a balance; the payer gets their balance in a private follow-up. A quote that
//   runs out has its card closed by the sweep, and a press after that answers with the expiry.
// * One open card per member per place: a new offer while one waits is refused (the same words
//   asked again get the same card, as `ask` answers the same key once). Cards are counted per
//   member and per place (`chat_cards_per_person`, `chat_cards_per_place` in `chat_window_s`), so
//   someone saying 「送你 X」 over and over cannot make her post card after card.
// * Who gives: the author of the message she answers, or someone she names who spoke in this
//   place within `chat_window_s` (`ChatSpeakers`, fed from the bus). Bots and her own accounts
//   are never a giver.

import {
  type AnyComponentRoute,
  type CardBlock,
  type CommandReply,
  type ComponentInvocation,
  ComponentResult,
  cardReply,
  componentId,
  defineRoute,
  notice,
  ReplySinkKey,
} from "@miyoria/commands";
import { errorMessage, type ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  accountRefString,
  type BusEvent,
  type ContextKey,
  contextKeyString,
  Events,
  is,
  type MessageRef,
  newId,
  type PersonId,
  serviceKey,
} from "@miyoria/types";
import { CANNOT_FEED, type EconomyService, FULL, feedLabel, STRANGER } from "./economy.js";
import { priceLine, STATUS_WORD } from "./gift-commands.js";
import { fixedFood, giftKey, giftName, refusalText, ruleRefusal } from "./gift-words.js";
import { FreeGiftsKey, type GiftDesk, type GiftQuote, type GiftView } from "./gifts.js";
import { mutedText, unlockLines } from "./notices.js";
import { someone } from "./receipt.js";
import { EconomyError, type FeedItem } from "./types.js";
import { pronounOf } from "./words.js";

export const CHAT_GIFT_ROUTES = {
  ok: "me:gift:chat:ok",
  no: "me:gift:chat:no",
  food: "me:gift:food",
} as const;

/** The gifts offered in conversation (`ChatGifts`), for her tool and the card's buttons. */
export const ChatGiftsKey = serviceKey<ChatGifts>("ChatGifts");

/** Longest wait for the platform to post a card. */
const POST_MS = 8_000;
/** Lines kept per place, and places kept, for who spoke. */
const LINES_PER_PLACE = 100;
const MAX_PLACES = 1_000;
/** Open cards and food offers kept at most (far more than the rates allow). */
const MAX_OPEN = 2_000;

const UNAVAILABLE = "送禮現在打不開";

// ---- who spoke ------------------------------------------------------------------------------

/** Someone who said something in a place: their account, the name shown, their message. */
export interface Spoke {
  account: AccountRef;
  name: string;
  message: MessageRef;
  at: number;
}

/**
 * Who spoke where lately, from the bus (`platform.message.created`, `voice.utterance`): people
 * only, never a bot or one of her own accounts. Answers from memory.
 */
export class ChatSpeakers {
  readonly #self = new Set<string>();
  readonly #bots = new Set<string>();
  readonly #lines = new Map<string, Spoke[]>();

  /** One bus event at `now`; anything else is ignored. Never throws. */
  onEvent(event: BusEvent, now: number): void {
    if (is(Events.PlatformReady, event)) {
      this.#self.add(accountRefString(event.data.self_account));
    } else if (is(Events.PlatformMessageCreated, event)) {
      const m = event.data;
      if (m.self === true) this.#self.add(accountRefString(m.author.account));
      this.heard(m.id, m.author.account, m.author.display_name, m.author.is_bot, now);
    } else if (is(Events.VoiceUtteranceEvent, event)) {
      const u = event.data;
      const message = { context: u.context, id: u.id };
      this.heard(message, u.speaker.account, u.speaker.display_name, u.speaker.is_bot, now);
    }
  }

  /** `account` said `message` at `at`. */
  heard(message: MessageRef, account: AccountRef, name: string, bot: boolean, at: number): void {
    const key = accountRefString(account);
    if (bot) this.#bots.add(key);
    if (bot || this.#self.has(key)) return;
    const place = contextKeyString(message.context);
    const lines = this.#lines.get(place) ?? [];
    lines.push({ account, name, message, at });
    if (lines.length > LINES_PER_PLACE) lines.splice(0, lines.length - LINES_PER_PLACE);
    this.#lines.delete(place);
    this.#lines.set(place, lines);
    while (this.#lines.size > MAX_PLACES) {
      const oldest = this.#lines.keys().next().value as string;
      this.#lines.delete(oldest);
    }
  }

  /** One of her own accounts, or a bot: never a giver. */
  barred(account: AccountRef): boolean {
    const key = accountRefString(account);
    return this.#self.has(key) || this.#bots.has(key);
  }

  /** Who spoke in `context` since `since`, each once with their newest line, newest first. */
  spoke(context: ContextKey, since: number): Spoke[] {
    const lines = this.#lines.get(contextKeyString(context)) ?? [];
    const out: Spoke[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as Spoke;
      if (line.at < since) break;
      const key = accountRefString(line.account);
      if (this.barred(line.account) || out.some((s) => accountRefString(s.account) === key))
        continue;
      out.push(line);
    }
    return out;
  }
}

// ---- the cards ----------------------------------------------------------------------------

/** A Discord timestamp the reader sees in their own time (「3 分鐘內」). */
const until = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

interface Words {
  her: string;
  cur: string;
}

/** The quote everyone sees: what, the price, who may press; never a balance. */
export function chatQuoteCard(q: GiftQuote, payer: AccountRef, w: Words): CommandReply {
  const who = someone(payer);
  const lines = [`${who} 想送${w.her}「**${q.item}**」　${q.kind_word}`, priceLine(q)];
  if (q.big) lines.push(`這是一份大禮:${q.price.toLocaleString("en-US")} ${q.currency}。`);
  const muted = [
    ...(q.note ? [q.note] : []),
    `只有 ${who} 按得了。按確認才扣${w.cur},${w.her}會自己決定收不收,不收全部退回。`,
    `期限 ${until(Date.parse(q.expires_at))}`,
  ];
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      { type: "muted", text: muted.join("\n") },
      {
        type: "buttons",
        buttons: [
          { id: componentId(CHAT_GIFT_ROUTES.ok, q.id), label: "確認", style: "primary" },
          { id: componentId(CHAT_GIFT_ROUTES.no, q.id), label: "取消", style: "secondary" },
        ],
      },
    ],
    { accent: "neutral", title: `送${w.her}禮物` },
  );
}

/** A fixed food offered in words: the price and one 確認; never a balance. */
export function chatFoodCard(
  nonce: string,
  item: FeedItem,
  price: number,
  expires: number,
  payer: AccountRef,
  w: Words,
): CommandReply {
  const who = someone(payer);
  return cardReply(
    [
      { type: "text", text: `${who} 想餵${w.her}${feedLabel(item, 1)}　${price} ${w.cur}` },
      {
        type: "muted",
        text: `只有 ${who} 按得了。按確認才扣${w.cur};沒按就不扣。\n期限 ${until(expires)}`,
      },
      {
        type: "buttons",
        buttons: [
          { id: componentId(CHAT_GIFT_ROUTES.food, nonce), label: "確認", style: "primary" },
        ],
      },
    ],
    { accent: "neutral", title: `餵${w.her}` },
  );
}

/** A closed card: what happened, no buttons, no balance. */
function closedCard(title: string, text: string, muted: string | null = null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text }];
  if (muted) blocks.push({ type: "muted", text: muted });
  return cardReply(blocks, { accent: "neutral", title });
}

/** A card only the presser sees. */
function privately(text: string, muted: string | null = null, title: string | null = null) {
  const blocks: CardBlock[] = [{ type: "text", text }];
  if (muted) blocks.push({ type: "muted", text: muted });
  return cardReply(blocks, { accent: "neutral", ephemeral: true, title });
}

// ---- the desk -----------------------------------------------------------------------------

/**
 * Why no card went up: `invalid`, `money` (coins or real money named as the thing), `stranger`,
 * `barred` (a bot, her own account), `off`, `open` (one waits already), `rate_person`,
 * `rate_place`, `answered` (these words' quote is over), `nowhere` (no place to post), `limit`,
 * `unavailable`, `not_enough`, `full`, or one of `ask`'s (`GiftNo`).
 */
export type ChatRefusal = string;

/** Where a card went. */
export type ChatWhere = "here" | "voice_text" | "dm";

export type ChatQuoteResult =
  | {
      status: "posted";
      kind: "gift" | "food";
      item: string;
      price: number;
      where: ChatWhere;
      expires_at: number;
      /** This offer's card was already up (the same words asked again): nothing new posted. */
      again: boolean;
    }
  | { status: "refused"; reason: ChatRefusal; message: string; item?: string; until?: number };

/** One card waiting for its payer's press. */
interface Open {
  kind: "gift" | "food";
  /** The gift's id, or the food offer's nonce. */
  id: string;
  /** What one offer is keyed by (the place, the message and the thing). */
  request: string;
  item: string;
  price: number;
  expires: number;
  where: ChatWhere;
  card: MessageRef | null;
}

interface FoodOffer {
  person: PersonId;
  item: FeedItem;
  expires: number;
  open: string;
}

export class ChatGifts {
  readonly speakers = new ChatSpeakers();
  /** `<person>|<place>` → the card waiting there. */
  readonly #open = new Map<string, Open>();
  readonly #food = new Map<string, FoodOffer>();
  /** When cards went up, per person and per place. */
  readonly #byPerson = new Map<string, number[]>();
  readonly #byPlace = new Map<string, number[]>();

  constructor(
    private readonly e: EconomyService,
    private readonly gifts: GiftDesk,
  ) {}

  get #c() {
    return this.e.config.free_gifts;
  }

  get #words(): Words {
    return { her: pronounOf(this.e.services), cur: this.e.config.currency };
  }

  /** Since when someone counts as having spoken here, and cards are counted. */
  windowStart(now = this.e.now()): number {
    return now - this.#c.chat_window_s * 1000;
  }

  /**
   * Puts up the card for `payer`'s offer of `text`, said in `context` (`message`: their words, the
   * card replies to it where it can). Charges nothing. Never throws for the member's reasons.
   */
  async quote(
    payer: AccountRef,
    text: string,
    context: ContextKey,
    message: MessageRef | null,
  ): Promise<ChatQuoteResult> {
    const c = this.#c;
    const cur = this.e.config.currency;
    const no = (
      reason: ChatRefusal,
      msg: string,
      extra: { item?: string; until?: number } = {},
    ): ChatQuoteResult => ({ status: "refused", reason, message: msg, ...extra });
    if (this.speakers.barred(payer)) return no("barred", "機器人和你自己的帳號不能送禮");
    if (c.chat_cards_per_person === 0 || c.chat_cards_per_place === 0) {
      return no("off", "聊天裡現在不貼報價卡");
    }
    const name = giftName(text, c.max_chars);
    if (name === null) return no("invalid", `禮物的名字要 1 到 ${c.max_chars} 個字`);
    if (ruleRefusal(name, cur) === "money") return no("money", refusalText("money", cur));
    const who = await this.e.member(payer);
    if (!who) return no("stranger", STRANGER);
    const now = this.e.now();
    this.#prune(now);
    const openKey = `${who.person.id}|${contextKeyString(context)}`;
    const request = `chat:${contextKeyString(context)}:${message?.id ?? newId()}:${giftKey(name)}`;
    const open = this.#open.get(openKey);
    if (open !== undefined && (await this.#live(payer, open, now))) {
      if (open.request === request) {
        return {
          status: "posted",
          kind: open.kind,
          item: open.item,
          price: open.price,
          where: open.where,
          expires_at: open.expires,
          again: true,
        };
      }
      return no("open", `還有一張等他按的卡(「${open.item}」)`, {
        item: open.item,
        until: open.expires,
      });
    }
    if (open !== undefined) this.#open.delete(openKey);
    const since = this.windowStart(now);
    const mine = (this.#byPerson.get(who.person.id) ?? []).filter((t) => t > since).length;
    if (mine >= c.chat_cards_per_person) {
      return no("rate_person", "他剛才已經叫出好幾張報價卡了,過幾分鐘再說");
    }
    const here = (this.#byPlace.get(contextKeyString(context)) ?? []).filter((t) => t > since);
    if (here.length >= c.chat_cards_per_place) {
      return no("rate_place", "這裡剛才已經貼了很多張報價卡,過幾分鐘再說");
    }

    const food = fixedFood(name);
    if (food !== null) {
      const w = await this.e.wallet(payer);
      if (w.hungry === null) return no("unavailable", CANNOT_FEED);
      if (w.hungry === "full") return no("full", FULL);
      const price = this.e.config[food];
      if (w.balance < price) return no("not_enough", `${cur}不夠:這份要 ${price}`);
      const nonce = newId();
      const expires = now + c.confirm_s * 1000;
      const card = chatFoodCard(nonce, food, price, expires, payer, this.#words);
      const posted = await this.#post(context, card, message, payer);
      if (posted === null) return no("nowhere", "這裡貼不了報價卡");
      const item = feedLabel(food, 1);
      this.#keep(openKey, who.person.id, context, now, {
        kind: "food",
        id: nonce,
        request,
        item,
        price,
        expires,
        where: posted.where,
        card: posted.card,
      });
      this.#food.set(nonce, { person: who.person.id, item: food, expires, open: openKey });
      return {
        status: "posted",
        kind: "food",
        item,
        price,
        where: posted.where,
        expires_at: expires,
        again: false,
      };
    }

    let quote: GiftQuote;
    try {
      const asked = await this.gifts.ask(payer, name, request, "discord");
      if (asked.status === "refused") return no(asked.reason, asked.message);
      if (asked.status !== "quote") return no("invalid", "這個名字沒辦法送出去");
      quote = asked.quote;
    } catch (error) {
      if (!(error instanceof EconomyError)) throw error;
      return no(askReason(error), error.message);
    }
    // The same words asked once before and already answered (cancelled, run out, sent).
    if ((await this.gifts.one(payer, quote.id))?.status !== "pending") {
      return no("answered", `「${quote.item}」這次的報價已經結束了`);
    }
    const card = chatQuoteCard(quote, payer, this.#words);
    const posted = await this.#post(context, card, message, payer);
    if (posted === null) {
      await this.gifts.cancel(payer, quote.id).catch(() => undefined);
      return no("nowhere", "這裡貼不了報價卡");
    }
    const expires = Date.parse(quote.expires_at);
    this.#keep(openKey, who.person.id, context, now, {
      kind: "gift",
      id: quote.id,
      request,
      item: quote.item,
      price: quote.price,
      expires,
      where: posted.where,
      card: posted.card,
    });
    return {
      status: "posted",
      kind: "gift",
      item: quote.item,
      price: quote.price,
      where: posted.where,
      expires_at: expires,
      again: false,
    };
  }

  /** Whether a card is still waiting for its press. */
  async #live(payer: AccountRef, open: Open, now: number): Promise<boolean> {
    if (now >= open.expires) return false;
    if (open.kind === "food") return this.#food.has(open.id);
    return (await this.gifts.one(payer, open.id))?.status === "pending";
  }

  #keep(key: string, person: PersonId, context: ContextKey, now: number, open: Open): void {
    this.#open.set(key, open);
    push(this.#byPerson, person, now);
    push(this.#byPlace, contextKeyString(context), now);
    while (this.#open.size > MAX_OPEN) this.#open.delete(this.#open.keys().next().value as string);
    while (this.#food.size > MAX_OPEN) this.#food.delete(this.#food.keys().next().value as string);
  }

  /** Forgets counts older than the window. */
  #prune(now: number): void {
    const since = this.windowStart(now);
    for (const map of [this.#byPerson, this.#byPlace]) {
      for (const [k, list] of map) {
        const kept = list.filter((t) => t > since);
        if (kept.length === 0) map.delete(k);
        else map.set(k, kept);
      }
    }
  }

  /**
   * Posts `card` where the words were said: as a reply in a channel or a DM, into the voice room's
   * text chat in voice, else (voice only) by DM to the payer. `null`: nowhere.
   */
  async #post(
    context: ContextKey,
    card: CommandReply,
    replyTo: MessageRef | null,
    payer: AccountRef,
  ): Promise<{ where: ChatWhere; card: MessageRef } | null> {
    const sink = this.e.services.get(ReplySinkKey);
    if (!sink || sink.platform !== context.platform) return null;
    const shown = { ...card, ephemeral: false };
    const direct = async () => {
      if (payer.platform !== sink.platform) return null;
      try {
        return { where: "dm" as const, card: await sink.sendDirect(payer, shown, timeout()) };
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error) }, "could not send a gift card by DM");
        return null;
      }
    };
    if (sink.sendCard) {
      const reply =
        context.kind !== "voice" &&
        replyTo !== null &&
        contextKeyString(replyTo.context) === contextKeyString(context)
          ? { replyTo }
          : undefined;
      try {
        const sent = await sink.sendCard(context, shown, timeout(), reply);
        const where: ChatWhere =
          context.kind === "voice" ? "voice_text" : context.kind === "dm" ? "dm" : "here";
        return { where, card: sent };
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error) }, "could not post a gift card");
      }
    }
    return context.kind === "voice" || context.kind === "dm" ? direct() : null;
  }

  // ---- the buttons ------------------------------------------------------------------------

  /** 確認 (`ok`) or 取消 of a gift quote's card. */
  async pressGift(inv: ComponentInvocation, id: string, ok: boolean): Promise<ComponentResult> {
    const w = this.#words;
    const title = `送${w.her}禮物`;
    const mine = await this.gifts.one(inv.invoker, id);
    if (mine === null) return ComponentResult.reply(this.#notYours());
    const who = someone(inv.invoker);
    if (!ok) {
      try {
        const g = await this.gifts.cancel(inv.invoker, id);
        this.#closeOpen(id);
        const text =
          g.status === "cancelled"
            ? `${who} 取消了「${g.item}」,沒有扣${w.cur}。`
            : `「${g.item}」:${STATUS_WORD[g.status]}。`;
        return ComponentResult.update(closedCard(title, text));
      } catch (error) {
        return ComponentResult.reply(this.#refusal(error));
      }
    }
    try {
      const done = await this.gifts.confirm(inv.invoker, id);
      this.#closeOpen(id);
      const g = done.gift;
      const sent = g.status !== "cancelled" && g.status !== "expired" && g.status !== "rejected";
      const shown = sent
        ? closedCard(
            title,
            `${who} 送出了「${g.item}」,${g.price.toLocaleString("en-US")} ${w.cur}。`,
            `${w.her}會自己決定收不收;不收全部退回。`,
          )
        : closedCard(title, `「${g.item}」:${STATUS_WORD[g.status]}。`);
      const mineOnly =
        g.status === "confirmed"
          ? privately(
              `送出了「${g.item}」,花了 ${g.price} ${w.cur},剩 ${done.balance}。`,
              `${w.her}下次說話時會看到,收不收由${w.her}決定;不收會全部退回。`,
              title,
            )
          : privately(`「${g.item}」:${STATUS_WORD[g.status]}。剩 ${done.balance} ${w.cur}。`);
      return await this.#both(inv, shown, mineOnly);
    } catch (error) {
      // Run out, cancelled or refused before: the card is over for everyone.
      const after = await this.gifts.one(inv.invoker, id);
      if (error instanceof EconomyError && after !== null && after.status !== "pending") {
        this.#closeOpen(id);
        return await this.#both(inv, this.#overCard(after), privately(error.message));
      }
      return ComponentResult.reply(this.#refusal(error));
    }
  }

  /** 確認 of a fixed food's card. */
  async pressFood(inv: ComponentInvocation, nonce: string): Promise<ComponentResult> {
    const w = this.#words;
    const offer = this.#food.get(nonce);
    // Gone: used, run out, or from before a restart. Nothing is charged; the card stays as it is.
    if (offer === undefined) {
      return ComponentResult.reply(privately(`這張卡已經過期或用過了,沒有扣${w.cur}。`));
    }
    const who = await this.e.member(inv.invoker);
    if (who === null || who.person.id !== offer.person) {
      return ComponentResult.reply(this.#notYours());
    }
    const title = `餵${w.her}`;
    const label = feedLabel(offer.item, 1);
    const close = () => {
      this.#food.delete(nonce);
      if (this.#open.get(offer.open)?.id === nonce) this.#open.delete(offer.open);
    };
    if (this.e.now() >= offer.expires) {
      close();
      return await this.#both(
        inv,
        closedCard(title, `餵${w.her}${label}的卡過期了,沒有扣${w.cur}。`),
        privately(`等太久了,這張卡過期了,沒有扣${w.cur}。`),
      );
    }
    try {
      const r = await this.e.feed(inv.invoker, offer.item, 1, `chat:${nonce}`);
      close();
      if (!r.accepted) {
        return await this.#both(
          inv,
          closedCard(title, `沒有餵成${label},沒有扣${w.cur}。`),
          privately(r.message, `沒有扣${w.cur}。`),
        );
      }
      return await this.#both(
        inv,
        closedCard(title, `${someone(inv.invoker)} 餵${w.her}${label},${r.charged} ${w.cur}。`),
        privately(
          `餵了${label},花了 ${r.charged} ${w.cur},剩 ${r.balance}。`,
          mutedText(unlockLines(r.unlocked)),
          title,
        ),
      );
    } catch (error) {
      return ComponentResult.reply(this.#refusal(error));
    }
  }

  /**
   * The card says what happened for everyone; the payer gets `mine` (their balance) privately.
   * Without follow-ups on the platform, the card is edited by the sink and `mine` is the answer.
   */
  async #both(
    inv: ComponentInvocation,
    shown: CommandReply,
    mine: CommandReply,
  ): Promise<ComponentResult> {
    if (inv.canFollowUp()) {
      try {
        await inv.followUp(mine);
        return ComponentResult.update(shown);
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error) }, "could not answer a gift card privately");
      }
    }
    const card = inv.messageId === null ? null : { context: inv.context, id: inv.messageId };
    await this.#edit(card, shown);
    return ComponentResult.reply(mine);
  }

  async #edit(card: MessageRef | null, reply: CommandReply): Promise<void> {
    const sink = this.e.services.get(ReplySinkKey);
    if (card === null || !sink?.editCard || sink.platform !== card.context.platform) return;
    try {
      await sink.editCard(card, reply, timeout());
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "could not close a gift card");
    }
  }

  #overCard(g: GiftView): CommandReply {
    const w = this.#words;
    const text =
      g.status === "expired"
        ? `「${g.item}」的報價過期了,沒有扣${w.cur}。`
        : `「${g.item}」:${STATUS_WORD[g.status]}。`;
    return closedCard(`送${w.her}禮物`, text);
  }

  #notYours(): CommandReply {
    const w = this.#words;
    return privately(
      `這張卡只有要送的那個人按得了,你按了什麼都沒變。想自己送${w.her}東西,就跟${w.her}說,或用 /me feed thing:。`,
    );
  }

  #refusal(error: unknown): CommandReply {
    if (error instanceof EconomyError) {
      return error.status === 503
        ? notice("warn", error.message)
        : privately(error.message, `沒有扣${this.e.config.currency}。`);
    }
    this.e.log.warn({ err: errorMessage(error) }, "a gift card press failed");
    return notice("warn", UNAVAILABLE);
  }

  #closeOpen(id: string): void {
    for (const [k, o] of this.#open) if (o.id === id) this.#open.delete(k);
  }

  /** Closes the cards whose quotes ran out (no buttons, nothing charged). */
  async sweep(): Promise<number> {
    const now = this.e.now();
    this.#prune(now);
    const w = this.#words;
    let closed = 0;
    for (const [k, o] of [...this.#open]) {
      if (now < o.expires) continue;
      this.#open.delete(k);
      if (o.kind === "food") this.#food.delete(o.id);
      const title = o.kind === "food" ? `餵${w.her}` : `送${w.her}禮物`;
      const text =
        o.kind === "food"
          ? `餵${w.her}${o.item}的卡過期了,沒有扣${w.cur}。`
          : `「${o.item}」的報價過期了,沒有扣${w.cur}。`;
      await this.#edit(o.card, closedCard(title, text));
      closed += 1;
    }
    for (const [k, f] of [...this.#food]) if (now >= f.expires) this.#food.delete(k);
    return closed;
  }
}

function push(map: Map<string, number[]>, key: string, at: number): void {
  const list = map.get(key) ?? [];
  list.push(at);
  map.set(key, list);
}

const timeout = () => AbortSignal.timeout(POST_MS);

/** What a refusal of `ask` is, for her. */
function askReason(error: EconomyError): ChatRefusal {
  switch (error.status) {
    case 400:
      return "invalid";
    case 403:
      return "stranger";
    case 429:
      return "limit";
    default:
      return "unavailable";
  }
}

/** The card's buttons (registered with `me feed`, beside the private quote's). */
export function chatGiftRoutes(services: ServiceLookup): AnyComponentRoute[] {
  const id = (p: readonly string[]) => (typeof p[0] === "string" && p[0] !== "" ? p[0] : null);
  const desk = () => (services.get(FreeGiftsKey) ? (services.get(ChatGiftsKey) ?? null) : null);
  const off = () => ComponentResult.reply(notice("warn", UNAVAILABLE));
  return [
    defineRoute<string>({
      route: CHAT_GIFT_ROUTES.ok,
      parse: id,
      ephemeral: true,
      handle: (inv, gift) => desk()?.pressGift(inv, gift, true) ?? off(),
    }),
    defineRoute<string>({
      route: CHAT_GIFT_ROUTES.no,
      parse: id,
      ephemeral: true,
      handle: (inv, gift) => desk()?.pressGift(inv, gift, false) ?? off(),
    }),
    defineRoute<string>({
      route: CHAT_GIFT_ROUTES.food,
      parse: id,
      ephemeral: true,
      handle: (inv, nonce) => desk()?.pressFood(inv, nonce) ?? off(),
    }),
  ];
}
