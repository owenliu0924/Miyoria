// The routes of her cards beyond issuing one (`card.ts`, `member.ts`): a member's own cards, one
// card with what only its owner sees, the dex (with the old collectibles as the closed series
// 舊收藏), the pity, the wishlist, the public odds, and one person's cards for the owner
// (docs/design/v5-play.md §2, §6.3). Someone she has never met has none of these yet; their own
// cards stay theirs to see whatever she thinks of them now.

import type {
  CardDex,
  CardOdds,
  CardPart,
  CardPity,
  CardWishlist,
  MyCard,
  PersonCards,
} from "@miyoria/contracts/api";
import {
  CARD_TEXTS,
  type CardRecord,
  type CardService,
  CardsKey,
  MAX_WISHES,
  type Part,
} from "@miyoria/play/cards";
import { MemberCardStoreKey } from "@miyoria/store";
import { type PersonId, sameAccount } from "@miyoria/types";
import { cardsOf, dailyCard, normalizeSerial } from "./card.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { accountsOf, loadMember, type MemberContext } from "./member.js";
import type { ApiState } from "./state.js";

const NO_CARDS = "這個 Core 還不能發卡";
const NO_SUCH_CARD = "這張卡不存在或已經作廢";

function service(state: ApiState): CardService {
  const cards = state.optional(CardsKey);
  if (!cards) throw ApiError.unavailable(NO_CARDS);
  return cards;
}

const partOf = (p: Pick<Part, "id" | "slot" | "name" | "rarity">): CardPart => ({
  id: p.id,
  slot: p.slot,
  name: p.name,
  rarity: p.rarity,
});

function myCard(c: CardRecord): MyCard {
  return { card: dailyCard(c), pity_hit: c.pity_hit, wished: c.wished, price: c.price };
}

function dexOf(cards: CardService, person: PersonId | null): CardDex {
  const legacy = { name: "舊收藏", items: [] as CardDex["legacy"]["items"] };
  if (person === null) return { parts: [], series: [], titles: [], legacy };
  const dex = cards.dex(person);
  return {
    parts: dex.parts.map((p) => ({
      ...partOf({ id: p.part, slot: p.slot, name: p.name, rarity: p.rarity }),
      series: p.series,
      count: p.count,
      first_at: p.first_at,
    })),
    series: dex.series,
    titles: dex.titles.map((t) => ({
      series: t.series,
      title: t.title,
      public: t.public,
      earned_at: t.earned_at,
    })),
    legacy: { name: dex.legacy.series.name, items: dex.legacy.items },
  };
}

function pityOf(cards: CardService, person: PersonId | null): CardPity {
  return person === null
    ? { since: 0, pity: cards.config.pity, until: cards.config.pity }
    : cards.pity(person);
}

function wishlistOf(cards: CardService, person: PersonId | null): CardPart[] {
  if (person === null) return [];
  const byId = new Map(cards.catalogue().map((p) => [p.id, p]));
  return cards.wishlist(person).flatMap((id) => {
    const p = byId.get(id);
    return p ? [partOf(p)] : [];
  });
}

/** The public odds of a daily card, with its price and the day's cap. */
export function cardOdds(cards: CardService): CardOdds {
  const table = cards.odds();
  return { ...table, price: cards.config.price, per_day: cards.config.daily_cap };
}

async function me(state: ApiState, c: Parameters<typeof loadMember>[1]): Promise<MemberContext> {
  return loadMember(state, c);
}

/** One of their own cards: a daily card of theirs, or an older one on one of their accounts. */
async function oneOf(state: ApiState, who: MemberContext, input: string): Promise<MyCard> {
  const missing = () => new ApiError(404, NO_SUCH_CARD);
  const serial = normalizeSerial(input);
  if (serial === null) throw missing();
  const daily = state.optional(CardsKey)?.card(serial);
  if (daily) {
    if (daily.person !== who.person?.id) throw missing();
    return myCard(daily);
  }
  const older = await state.optional(MemberCardStoreKey)?.bySerial(state.profile(), serial);
  const mine = older && accountsOf(who).some((a) => sameAccount(a, older.account));
  if (!older || !mine) throw missing();
  const card = (await cardsOf(state, [older.account], null)).find((x) => x.serial === serial);
  if (!card) throw missing();
  return { card, pity_hit: false, wished: [], price: 0 };
}

/** The cards routes on the route table: the member's and the public odds (see `rpc.ts`). */
export const cardsRpc = {
  mine: os.cards.mine.handler(async ({ context }) => {
    const who = await me(context.state, context.c);
    return {
      cards: await cardsOf(context.state, accountsOf(who), who.person?.id ?? null),
    };
  }),
  one: os.cards.one.handler(async ({ input, context }) =>
    oneOf(context.state, await me(context.state, context.c), input.params.serial),
  ),
  dex: os.cards.dex.handler(async ({ context }) => {
    const who = await me(context.state, context.c);
    return dexOf(service(context.state), who.person?.id ?? null);
  }),
  pity: os.cards.pity.handler(async ({ context }) => {
    const who = await me(context.state, context.c);
    return pityOf(service(context.state), who.person?.id ?? null);
  }),
  wishlist: os.cards.wishlist.handler(async ({ context }): Promise<CardWishlist> => {
    const who = await me(context.state, context.c);
    return {
      parts: wishlistOf(service(context.state), who.person?.id ?? null),
      max: MAX_WISHES,
    };
  }),
  setWishlist: os.cards.setWishlist.handler(async ({ input, context }): Promise<CardWishlist> => {
    const who = await me(context.state, context.c);
    const cards = service(context.state);
    const person = who.person?.id ?? null;
    // Someone she has never met has no cards to wish among yet.
    if (person === null) throw new ApiError(403, CARD_TEXTS.no_wallet);
    const problem = cards.setWishlist(person, input.body.parts);
    if (problem !== null) throw ApiError.badRequest(CARD_TEXTS[problem]);
    return { parts: wishlistOf(cards, person), max: MAX_WISHES };
  }),
  odds: os.cards.odds.handler(({ context }) => cardOdds(service(context.state))),
};

/** One person's cards for the owner (`GET /api/people/{id}/cards`). */
export const cardsAdminRpc = {
  person: os.cardsAdmin.person.handler(({ input, context }): PersonCards => {
    const cards = service(context.state);
    const person = input.params.id;
    return {
      cards: cards.cards(person, { limit: 200 }).map(myCard),
      dex: dexOf(cards, person),
      pity: pityOf(cards, person),
      wishlist: wishlistOf(cards, person),
    };
  }),
};
