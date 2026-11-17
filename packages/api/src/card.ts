// Her cards (她發給你的卡) on the API: the daily card (docs/design/v5-play.md §2) issued through the
// cards plugin (`CardsKey`), and the member cards of before it, kept exactly as they were (owner
// decision: 舊卡保持原樣).
//
// * `GET /api/member/card`, `POST /api/member/card` `{ foil? }`: their latest card and what the day
//   allows, and a new daily card (routes in `member.ts`; what goes on a card is `cardView` there).
//   A daily card costs `[modules.cards] price` fish coins, the first of the day too, at most
//   `daily_cap` a day; the parts are drawn by the public odds and her expression follows the
//   relationship. Frames and the foil finish still apply. The day and the balance are checked
//   before she is asked to write anything, so a refused card costs no model call.
// * `GET /api/public/card/{serial}`: anyone may check a code, daily or older; unknown, deleted and
//   malformed serials get the same 404.
//
// A card holds what the member page showed, in words, the frame they chose, and on a daily card
// the parts drawn onto it: it is built field by field from the stored snapshot, so a field added to
// the snapshot stays private until named here.

import type {
  CardPart,
  CardPrices,
  IssuedCard,
  MemberCard,
  MemberCards,
} from "@miyoria/contracts/api";
import { type Economy, EconomyError, EconomyKey, STRANGER } from "@miyoria/economy";
import {
  CARD_TEXTS,
  type CardFace,
  type CardRecord,
  type CardRelationship,
  type CardService,
  CardsKey,
  CardWalletKey,
  cardRelationship,
  type DailyRefusal,
  portraitPose,
  refusalText,
} from "@miyoria/play/cards";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type MemberCardRecord, MemberCardStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  HeartKey,
  isJsonObject,
  type JsonValue,
  type PersonId,
} from "@miyoria/types";
import type { CardWords } from "./card-words.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { heartRows } from "./heart-rows.js";
import { clientKey } from "./public.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.card");

/** Most cards a person may be issued per local day when the cards plugin cannot say. */
export const CARDS_PER_DAY = 5;
/** Cards an export lists at most. */
const MAX_EXPORTED = 1_000;
/** Recent older cards looked at for "latest". */
const RECENT = 100;
/** Requests remembered so a retry with the same idempotency key answers the same card. */
const REMEMBERED_KEYS = 500;

const NO_STORE = "這個 Core 還不能發卡";
const NO_SUCH_CARD = "這張卡不存在或已經作廢";
const NO_WALLET = "錢包現在不能用";

// ---- serials --------------------------------------------------------------------------------

const MAX_SERIAL_INPUT = 64;

function formatSerial(body: string): string {
  return `MYR-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/**
 * The canonical serial of what someone typed or scanned, `null` when it cannot be one: any case,
 * dashes and spaces optional, and the letters Crockford reads as digits (I, L as 1, O as 0).
 */
export function normalizeSerial(input: string): string | null {
  if (input.length > MAX_SERIAL_INPUT) return null;
  const flat = input.toUpperCase().replace(/[\s-]/g, "");
  if (!flat.startsWith("MYR")) return null;
  const body = flat.slice(3).replace(/[IL]/g, "1").replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(body)) return null;
  return formatSerial(body);
}

// ---- cards as the API shows them --------------------------------------------------------------

const text = (v: JsonValue | undefined): string | null => (typeof v === "string" ? v : null);

function fieldsOf(v: JsonValue | undefined): IssuedCard["fields"] {
  if (!Array.isArray(v)) return [];
  const out: IssuedCard["fields"] = [];
  for (const f of v) {
    if (!isJsonObject(f)) continue;
    const label = text(f.label);
    const body = text(f.text);
    if (label !== null && body !== null) out.push({ label, text: body });
  }
  return out;
}

/** An older member card as it may leave, or `null` when the snapshot is not one. */
function olderCard(r: MemberCardRecord): IssuedCard | null {
  const s = r.snapshot;
  const name = text(s.name);
  const pose = text(s.pose);
  const number = s.number;
  if (name === null || pose === null || typeof number !== "number" || !Number.isInteger(number)) {
    return null;
  }
  return {
    serial: r.serial,
    issued_at: r.issued_at,
    name,
    avatar_url: text(s.avatar_url),
    number,
    call_name: text(s.call_name),
    relationship: text(s.relationship),
    affinity: text(s.affinity),
    trust: text(s.trust),
    familiarity: text(s.familiarity),
    public_feeling: text(s.public_feeling),
    // Cards from before she wrote on them have none of these.
    line: text(s.line),
    stamp: text(s.stamp),
    fields: fieldsOf(s.fields),
    pose,
    // Cards from before frames have none.
    frame: text(s.frame),
    foil: s.foil === true,
    voided_at: text(s.voided_at),
    rarity: null,
    parts: [],
    expression: null,
  };
}

/** Someone she has not met reads as before: no relationship on the card at all. */
const STRANGER_TIER = "陌生人";

/** A daily card as it may leave: its words, the parts drawn onto it and her expression. */
export function dailyCard(c: CardRecord): IssuedCard {
  const r = c.relationship;
  const known = r.tier !== STRANGER_TIER;
  const parts: CardPart[] = c.parts
    .filter((p) => !p.blank)
    .map((p) => ({ id: p.id, slot: p.slot, name: p.name, rarity: p.rarity }));
  return {
    serial: c.serial,
    issued_at: c.created_at,
    name: c.face.name,
    avatar_url: c.face.avatar_url,
    number: c.face.number,
    call_name: c.face.call_name,
    relationship: known ? r.tier_label : null,
    affinity: known ? r.closeness : null,
    trust: known ? r.trust : null,
    familiarity: known ? r.familiarity : null,
    public_feeling: known ? r.public_feeling : null,
    line: c.face.line,
    stamp: c.face.stamp,
    fields: c.face.fields,
    // Her picture until the rendered one exists: the fixed portrait nearest her expression.
    pose: portraitPose(c.expression.id),
    frame: c.frame,
    foil: c.foil,
    voided_at: null,
    rarity: c.rarity,
    parts,
    expression: c.expression.name,
    kind: c.kind,
  };
}

/** Whose cards these are. */
export interface CardHolder {
  /** Only who it was issued to is read: their account, name and picture. */
  session: Pick<SessionRecord, "account" | "name" | "avatar_url">;
  /** The session account and every account of the person she knows them as. */
  accounts: readonly AccountRef[];
  person: PersonId | null;
}

/** Their newest older card that is not voided. */
async function latestOlder(state: ApiState, holder: CardHolder): Promise<IssuedCard | null> {
  const store = state.optional(MemberCardStoreKey);
  if (!store) return null;
  const recent = await store.listFor(state.profile(), holder.accounts, RECENT);
  const latest = recent.find((r) => text(r.snapshot.voided_at) === null);
  return latest ? olderCard(latest) : null;
}

/** What `item` costs and whether it is on sale, or `null` without a wallet. */
function offer(economy: Economy | undefined, item: "card_foil"): number | null {
  if (!economy) return null;
  const { price, per_day } = economy.price(item);
  return per_day > 0 ? price : null;
}

/** `GET /api/member/card`: their latest card, today's count, the prices, their coins, the pity. */
export async function memberCards(state: ApiState, holder: CardHolder): Promise<MemberCards> {
  const cards = state.optional(CardsKey);
  const economy = state.optional(EconomyKey);
  const person = holder.person;
  const newest = cards && person ? (cards.cards(person, { limit: 1 })[0] ?? null) : null;
  const latest = newest ? dailyCard(newest) : await latestOlder(state, holder);
  const prices: CardPrices = {
    card: cards ? cards.config.price : null,
    foil: offer(economy, "card_foil"),
  };
  if (!cards) {
    return { latest, today: 0, per_day: CARDS_PER_DAY, prices, balance: null, pity: null };
  }
  const per_day = cards.config.daily_cap;
  if (person === null) {
    return { latest, today: 0, per_day, prices, balance: null, pity: null };
  }
  let balance: number | null = null;
  try {
    balance =
      (await state.optional(CardWalletKey)?.balance({ person, account: holder.session.account })) ??
      null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read a balance for the cards");
  }
  return {
    latest,
    today: per_day - cards.dailyLeft(person),
    per_day,
    prices,
    balance,
    pity: cards.pity(person),
  };
}

/** The frame they chose for their cards; none when the wallet cannot say. */
async function frameOf(state: ApiState, account: AccountRef): Promise<string | null> {
  try {
    return (await state.optional(EconomyKey)?.selectedFrame(account)) ?? null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read the card frame");
    return null;
  }
}

/** A refusal of the cards as the error the routes answer with. */
function refusedCard(r: DailyRefusal): ApiError {
  // A wallet that has no balance for them will not take their coins: for the economy, someone she
  // does not know or has blocked, who are answered alike.
  if (r.reason === "refused" && r.message === CARD_TEXTS.no_wallet) {
    return new ApiError(403, STRANGER);
  }
  const status =
    r.reason === "daily_cap"
      ? 429
      : r.reason === "insufficient"
        ? 402
        : r.reason === "no_wallet"
          ? 503
          : 403;
  return new ApiError(status, r.reason === "no_wallet" ? NO_WALLET : refusalText(r));
}

/** A card she gave them is evidence for her nightly reflection on them (`card`). Never throws. */
function cardEvidence(state: ApiState, person: PersonId, card: IssuedCard) {
  try {
    state.optional(HeartKey)?.evidence?.({
      person,
      kind: "card",
      detail: `拿到了你的第 ${card.number} 張卡片${card.rarity ? `(${card.rarity})` : ""}${card.foil ? "(閃卡)" : ""}`,
      weight: null,
      at: state.now(),
    });
  } catch (error) {
    log.warn({ err: errorMessage(error) }, "cannot record a card as evidence");
  }
}

async function giveBack(economy: Economy, account: AccountRef, entry: string) {
  try {
    await economy.refund(account, entry);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot refund a card charge");
  }
}

/** What they ask for on top of a plain card. */
export interface CardOrder {
  foil: boolean;
  /** The request's Idempotency-Key; the foil charge derives its own from it. */
  key: string;
}

/** Cards answered per idempotency key, per state: a retry gets the card the first try made. */
const answered = new WeakMap<ApiState, Map<string, string>>();

function rememberedCard(state: ApiState, cards: CardService, key: string): IssuedCard | null {
  if (key === "") return null;
  const serial = answered.get(state)?.get(key);
  const card = serial === undefined ? null : cards.card(serial);
  return card ? dailyCard(card) : null;
}

function remember(state: ApiState, key: string, serial: string) {
  if (key === "") return;
  let keys = answered.get(state);
  if (!keys) {
    keys = new Map();
    answered.set(state, keys);
  }
  keys.set(key, serial);
  if (keys.size > REMEMBERED_KEYS) keys.delete(keys.keys().next().value as string);
}

/**
 * `POST /api/member/card`: a daily card of `view`, what the member page shows them right now,
 * with what she writes on it (`write`, asked only once the day and the coins allow the card; null
 * for no words). `hidden`: someone she will not say anything about gets a stranger's card. A foil
 * finish is charged first and given back if no card follows.
 */
export async function issueCard(
  state: ApiState,
  holder: CardHolder,
  view: MemberCard,
  write: () => Promise<CardWords | null>,
  order: CardOrder = { foil: false, key: "" },
  hidden = false,
): Promise<IssuedCard> {
  const cards = state.optional(CardsKey);
  if (!cards) throw ApiError.unavailable(NO_STORE);
  const person = holder.person;
  if (person === null) throw new ApiError(403, STRANGER);
  const again = rememberedCard(state, cards, order.key);
  if (again) return again;
  const account = holder.session.account;
  const payer = { person, account };
  // Nobody pays for a card the day or the wallet would refuse.
  const quote = await cards.quote(payer);
  if (!quote.ok) throw refusedCard(quote);
  const economy = state.optional(EconomyKey);
  let foilEntry: string | null = null;
  if (order.foil) {
    if (!economy || offer(economy, "card_foil") === null) throw ApiError.unavailable(NO_WALLET);
    try {
      const bought = await economy.purchase(account, "card_foil", `${order.key}:foil`, null);
      foilEntry = bought.entry_id;
    } catch (error) {
      if (error instanceof EconomyError) throw new ApiError(error.status, error.message);
      throw error;
    }
  }
  // Her line for them goes on the card as the page shows it (nobody else named, moderation passed),
  // never as it is stored: anyone with the serial can read the card.
  const relationship: CardRelationship = hidden
    ? cardRelationship(null)
    : {
        ...cardRelationship(heartRows(state)?.get(person) ?? null),
        public_feeling: view.public_feeling,
      };
  const older = await state
    .optional(MemberCardStoreKey)
    ?.countFor(state.profile(), holder.accounts);
  const face = async (): Promise<CardFace> => {
    const words = await write();
    return {
      name: holder.session.name,
      avatar_url: holder.session.avatar_url,
      call_name: view.call_name,
      line: words?.line ?? null,
      stamp: words?.stamp ?? null,
      fields: words?.fields ?? [],
      number: (older ?? 0) + cards.count(person) + 1,
    };
  };
  let result: Awaited<ReturnType<CardService["issueDaily"]>>;
  try {
    result = await cards.issueDaily(payer, face, {
      frame: await frameOf(state, account),
      foil: order.foil,
      relationship,
    });
  } catch (error) {
    if (economy && foilEntry) await giveBack(economy, account, foilEntry);
    throw error;
  }
  if (!result.ok) {
    if (economy && foilEntry) await giveBack(economy, account, foilEntry);
    throw refusedCard(result);
  }
  const card = dailyCard(result.issued.card);
  remember(state, order.key, card.serial);
  cardEvidence(state, person, card);
  return card;
}

/** Their cards for the export, newest first: daily cards, then the older ones. */
export async function cardsOf(
  state: ApiState,
  accounts: readonly AccountRef[],
  person: PersonId | null,
): Promise<IssuedCard[]> {
  const cards = state.optional(CardsKey);
  const daily = cards && person ? cards.cards(person, { limit: 500 }).map(dailyCard) : [];
  const store = state.optional(MemberCardStoreKey);
  const older = store ? await store.listFor(state.profile(), accounts, MAX_EXPORTED) : [];
  return [...daily, ...older.map(olderCard).filter((c): c is IssuedCard => c !== null)];
}

/** Deletes every card of theirs (forgetting), daily and older; they then fail the check. */
export async function deleteCards(
  state: ApiState,
  accounts: readonly AccountRef[],
  person: PersonId | null,
): Promise<number> {
  const cards = state.optional(CardsKey);
  const daily = cards && person ? cards.deleteCards(person) : 0;
  const store = state.optional(MemberCardStoreKey);
  return daily + (store ? await store.deleteFor(state.profile(), accounts) : 0);
}

// ---- the public check -----------------------------------------------------------------------

/** What every answer of the check carries: a card can be deleted, so nobody may keep the answer. */
const CHECK_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** The card behind a canonical serial, daily or older; `null` when there is none. */
async function bySerial(state: ApiState, serial: string): Promise<IssuedCard | null> {
  const daily = state.optional(CardsKey)?.card(serial);
  if (daily) return dailyCard(daily);
  const store = state.optional(MemberCardStoreKey);
  if (!store) return null;
  const found = await store.bySerial(state.profile(), serial);
  return found && isJsonObject(found.snapshot) ? olderCard(found) : null;
}

/** `GET /api/public/card/{serial}`. */
async function checkCard(state: ApiState, c: ApiContext, input: string): Promise<IssuedCard> {
  const wait = state.publicSide.admitCardCheck(clientKey(c));
  if (wait !== null) throw ApiError.tooMany(wait);
  const missing = () => new ApiError(404, NO_SUCH_CARD, CHECK_HEADERS);
  const serial = normalizeSerial(input);
  if (serial === null) throw missing();
  let card: IssuedCard | null;
  try {
    card = await bySerial(state, serial);
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot check a card");
    throw new ApiError(503, "not available right now", CHECK_HEADERS);
  }
  if (!card) throw missing();
  return card;
}

/** `GET /api/public/card/{serial}`; served only while the public side is on (see `rpc.ts`). */
export const cardCheckRpc = {
  card: os.public.card.handler(async ({ input, context }) => {
    const card = await checkCard(context.state, context.c, input.params.serial);
    for (const [name, value] of Object.entries(CHECK_HEADERS)) context.resHeaders?.set(name, value);
    return card;
  }),
};

/**
 * The card behind a serial for a page that is open to anyone (the link preview): `null` for a
 * malformed, unknown, voided or unreadable one, so nothing of it leaves.
 */
export async function publicCard(state: ApiState, input: string): Promise<IssuedCard | null> {
  const serial = normalizeSerial(input);
  if (serial === null) return null;
  try {
    const card = await bySerial(state, serial);
    return card && card.voided_at === null ? card : null;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot read a card for its preview");
    return null;
  }
}
