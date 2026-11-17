// The `cards` plugin's tables on the store's database (`migrations.ts`): the catalogue, the cards,
// the pity, the dex, wishlists and titles (`CardStore`).
//
// A card is written by `issue` only: in one `Db.tx` it checks the day's cap again, reads the pity,
// the catalogue and the wishlist, draws (`draw.ts`), writes the card, moves the pity, adds the
// parts to the dex, gives the titles of any series it completes and appends `cards.drawn` (and
// `cards.titled`) to the event log, as the heart writes `heart_person` with `heart.changed`. Paying
// for it is the service's (`service.ts`), outside the transaction.
//
// The tables are written in plain SQL on the store's connection (`Db.all/get/run`), not Drizzle,
// whose package this one does not depend on.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `cards` (`module.ts`) owns it. Cards
// are not tradable: nothing here moves a card to another person except a merge of two persons
// that turned out to be one.

import {
  type CategoryData,
  type Db,
  type EventStore,
  fromMicros,
  type PersonForget,
  type PersonHookResult,
  type PersonMerge,
  type Row,
  type StorePlugin,
  tablePart,
  toMicros,
} from "@miyoria/store";
import { type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { isRarity, isSlot, type Part, type Rarity } from "./catalogue.js";
import { completedBy, type WishlistProblem, wishlistProblem } from "./dex.js";
import {
  CardsError,
  type DrawnPart,
  type DrawRules,
  drawCard,
  nextSince,
  type PityView,
  pityView,
  type Random,
  wishedOn,
} from "./draw.js";
import { drawnWrite, titledWrite } from "./events.js";
import type { Expression } from "./expressions.js";
import { cardsSchema } from "./migrations.js";

export const CARD_KINDS = ["daily", "milestone", "keepsake", "drop"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** The words on a card besides the relationship: who it is for and what she wrote. */
export interface CardFace {
  /** Their name as she knows them. */
  name: string;
  /** What she calls them; `null`: their name. */
  call_name: string | null;
  /** The line she wrote on it; `null`: none. */
  line: string | null;
  /** Her stamp; `null`: none. */
  stamp: string | null;
}

/**
 * The relationship a card shows, in words only (the heart's `PublicBond` at the time): never the
 * raw bond, so a card cannot be used to read it off.
 */
export interface CardRelationship {
  /** The tier's bare name (陌生人, 認識 ... 永恆羈絆, 討厭, 很討厭): what picks the expression. */
  tier: string;
  /** Name and stage: 「知心 II」. */
  tier_label: string;
  closeness: string;
  trust: string;
  familiarity: string;
  public_feeling: string | null;
}

/** One card as stored. */
export interface CardRecord {
  serial: string;
  person: PersonId;
  kind: CardKind;
  rarity: Rarity;
  parts: DrawnPart[];
  expression: Expression;
  foil: boolean;
  seed: number;
  face: CardFace;
  relationship: CardRelationship;
  /** Its picture in the artifact store; `null`: not rendered (yet). */
  artifact_id: string | null;
  /** Coins it cost. */
  price: number;
  pity_hit: boolean;
  /** Wished parts it has. */
  wished: string[];
  created_at: Timestamp;
}

/** One part a person has. */
export interface DexEntry {
  part: string;
  first_at: Timestamp;
  /** The card it first came on. */
  first_card: string | null;
  count: number;
}

/** A title a person earned. */
export interface CardTitle {
  series: string;
  title: string;
  card: string | null;
  /** Shown to others; private by default. */
  public: boolean;
  earned_at: Timestamp;
}

/** What `issue` writes. */
export interface IssueInput {
  person: PersonId;
  kind: CardKind;
  serial: string;
  price: number;
  face: CardFace;
  relationship: CardRelationship;
  rules: DrawRules;
  random: Random;
  /** Epoch ms. */
  now: number;
  /** At most `max` cards of `kind` since `since` (epoch ms): checked inside the transaction. */
  cap?: { max: number; since: number };
}

/** What `issue` did. */
export interface IssuedCard {
  card: CardRecord;
  pity: PityView;
  /** Parts the person had never had. */
  new_parts: string[];
  /** Titles this card earned. */
  titles: CardTitle[];
}

/** The day's cap was reached (by a card issued meanwhile). */
export class CardCapError extends CardsError {
  override name = "CardCapError";
}

// ---- rows -----------------------------------------------------------------------------------

const str = (row: Row, column: string): string => {
  const v = row[column];
  if (typeof v !== "string") throw new CardsError(`cards column \`${column}\` is not text`);
  return v;
};

const optStr = (row: Row, column: string): string | null => {
  const v = row[column];
  return v === null || v === undefined ? null : str(row, column);
};

const num = (row: Row, column: string): number => {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new CardsError(`cards column \`${column}\` is not a number`);
};

function json<T>(row: Row, column: string): T {
  try {
    return JSON.parse(str(row, column)) as T;
  } catch (cause) {
    throw new CardsError(`cards column \`${column}\` is not JSON`, { cause });
  }
}

function partOf(row: Row): Part {
  const slot = str(row, "slot");
  const rarity = str(row, "rarity");
  if (!isSlot(slot) || !isRarity(rarity)) {
    throw new CardsError(`part \`${str(row, "id")}\` has slot ${slot}, rarity ${rarity}`);
  }
  return {
    id: str(row, "id"),
    slot,
    rarity,
    series: optStr(row, "series"),
    name: str(row, "name"),
    weight: num(row, "weight"),
    enabled: num(row, "enabled") === 1,
    drop_only: num(row, "drop_only") === 1,
    blank: num(row, "blank") === 1,
  };
}

/** What `cards_card.parts` holds. */
interface DrawSnapshot {
  parts: DrawnPart[];
  expression: Expression;
  foil: boolean;
  seed: number;
}

function cardOf(row: Row): CardRecord {
  const drawn = json<DrawSnapshot>(row, "parts");
  const rarity = str(row, "rarity");
  if (!isRarity(rarity))
    throw new CardsError(`card \`${str(row, "serial")}\` has rarity ${rarity}`);
  return {
    serial: str(row, "serial"),
    person: str(row, "person_id"),
    kind: str(row, "kind") as CardKind,
    rarity,
    parts: drawn.parts,
    expression: drawn.expression,
    foil: drawn.foil,
    seed: drawn.seed,
    face: json<CardFace>(row, "face"),
    relationship: json<CardRelationship>(row, "relationship"),
    artifact_id: optStr(row, "artifact_id"),
    price: num(row, "price"),
    pity_hit: num(row, "pity_hit") === 1,
    wished: json<string[]>(row, "wished"),
    created_at: fromMicros(num(row, "created_at")),
  };
}

const micros = (ms: number): number => toMicros(toTimestamp(ms));

/** `$i0, $i1, ...` for `ids`, with their parameters. */
function inList(ids: readonly string[]): [string, Record<string, string>] {
  const params: Record<string, string> = {};
  ids.forEach((id, i) => {
    params[`i${i}`] = id;
  });
  return [ids.map((_, i) => `$i${i}`).join(", "), params];
}

/** The person's tables, in the order a forget deletes them. */
const PERSON_TABLES = [
  "cards_card",
  "cards_pity",
  "cards_dex",
  "cards_wishlist",
  "cards_titles",
] as const;

// ---- the store ------------------------------------------------------------------------------

export class CardStore {
  readonly #db: Db;
  readonly #events: EventStore;

  constructor(db: Db, events: EventStore) {
    this.#db = db;
    this.#events = events;
  }

  /** The whole catalogue, by slot then id. */
  catalogue(): Part[] {
    return this.#db.all("SELECT * FROM cards_parts ORDER BY slot, id").map(partOf);
  }

  card(serial: string): CardRecord | null {
    const row = this.#db.get("SELECT * FROM cards_card WHERE serial = $serial", { serial });
    return row === undefined ? null : cardOf(row);
  }

  /** A person's cards, newest first; `before`: older than that card (the next page). */
  cards(person: PersonId, options: { limit?: number; before?: string } = {}): CardRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const before = options.before === undefined ? null : this.card(options.before);
    const rows = before
      ? this.#db.all(
          "SELECT * FROM cards_card WHERE person_id = $person AND (created_at < $at OR (created_at = $at AND serial < $serial)) ORDER BY created_at DESC, serial DESC LIMIT $limit",
          { person, at: micros(Date.parse(before.created_at)), serial: before.serial, limit },
        )
      : this.#db.all(
          "SELECT * FROM cards_card WHERE person_id = $person ORDER BY created_at DESC, serial DESC LIMIT $limit",
          { person, limit },
        );
    return rows.map(cardOf);
  }

  /** Cards of `kind` a person got since `since` (epoch ms). */
  countSince(person: PersonId, kind: CardKind, since: number): number {
    const row = this.#db.get(
      "SELECT count(*) AS n FROM cards_card WHERE person_id = $person AND kind = $kind AND created_at >= $since",
      { person, kind, since: micros(since) },
    );
    return row === undefined ? 0 : num(row, "n");
  }

  /** Cards in a row without SR or better. */
  pitySince(person: PersonId): number {
    const row = this.#db.get("SELECT since FROM cards_pity WHERE person_id = $person", { person });
    return row === undefined ? 0 : num(row, "since");
  }

  wishlist(person: PersonId): string[] {
    return this.#db
      .all("SELECT part_id FROM cards_wishlist WHERE person_id = $person ORDER BY position", {
        person,
      })
      .map((row) => str(row, "part_id"));
  }

  /**
   * Replaces the wishlist with `ids` (at most three, each once, each a collectable part). Returns
   * why not, or `null` once written. An empty list clears it.
   */
  setWishlist(person: PersonId, ids: readonly string[], now: number): WishlistProblem | null {
    return this.#write(() => {
      const problem = wishlistProblem(this.catalogue(), ids);
      if (problem !== null) return problem;
      this.#db.run("DELETE FROM cards_wishlist WHERE person_id = $person", { person });
      ids.forEach((part, i) => {
        this.#db.run(
          "INSERT INTO cards_wishlist (person_id, part_id, position, added_at) VALUES ($person, $part, $position, $at)",
          { person, part, position: i + 1, at: micros(now) },
        );
      });
      return null;
    });
  }

  clearWishlist(person: PersonId): number {
    return this.#write(() =>
      this.#db.run("DELETE FROM cards_wishlist WHERE person_id = $person", { person }),
    );
  }

  /** The parts a person has, first drawn first. */
  dex(person: PersonId): DexEntry[] {
    return this.#db
      .all("SELECT * FROM cards_dex WHERE person_id = $person ORDER BY first_at, part_id", {
        person,
      })
      .map((row) => ({
        part: str(row, "part_id"),
        first_at: fromMicros(num(row, "first_at")),
        first_card: optStr(row, "first_card"),
        count: num(row, "count"),
      }));
  }

  titles(person: PersonId): CardTitle[] {
    return this.#db
      .all("SELECT * FROM cards_titles WHERE person_id = $person ORDER BY earned_at, series", {
        person,
      })
      .map((row) => ({
        series: str(row, "series"),
        title: str(row, "title"),
        card: optStr(row, "card"),
        public: num(row, "public") === 1,
        earned_at: fromMicros(num(row, "earned_at")),
      }));
  }

  /** Records the picture of a card once rendered. Whether there was such a card. */
  setArtifact(serial: string, artifactId: string): boolean {
    return (
      this.#write(() =>
        this.#db.run("UPDATE cards_card SET artifact_id = $artifact WHERE serial = $serial", {
          artifact: artifactId,
          serial,
        }),
      ) > 0
    );
  }

  /**
   * Draws and writes one card, its pity, dex entries, titles and events, in one transaction.
   * Throws a `CardCapError` when `cap` is already reached, a `CardsError` when the catalogue has
   * nothing to draw; nothing is written then.
   */
  issue(input: IssueInput): IssuedCard {
    const { person, now } = input;
    return this.#write(() => {
      if (input.cap && this.countSince(person, input.kind, input.cap.since) >= input.cap.max) {
        throw new CardCapError(`${person} already has ${input.cap.max} ${input.kind} cards today`);
      }
      const at = micros(now);
      const ts = fromMicros(at);
      const catalogue = this.catalogue();
      const since = this.pitySince(person);
      const drawn = drawCard({
        catalogue,
        rules: input.rules,
        since,
        tier: input.relationship.tier,
        random: input.random,
      });
      const wished = wishedOn(drawn, this.wishlist(person));
      this.#db.run(
        `INSERT INTO cards_card (serial, person_id, kind, rarity, parts, face, relationship, price, pity_hit, wished, created_at)
         VALUES ($serial, $person, $kind, $rarity, $parts, $face, $relationship, $price, $pity_hit, $wished, $at)`,
        {
          serial: input.serial,
          person,
          kind: input.kind,
          rarity: drawn.rarity,
          parts: JSON.stringify({
            parts: drawn.parts,
            expression: drawn.expression,
            foil: drawn.foil,
            seed: drawn.seed,
          } satisfies DrawSnapshot),
          face: JSON.stringify(input.face),
          relationship: JSON.stringify(input.relationship),
          price: input.price,
          pity_hit: drawn.pity_hit ? 1 : 0,
          wished: JSON.stringify(wished),
          at,
        },
      );
      const after = nextSince(since, drawn.rarity);
      this.#db.run(
        `INSERT INTO cards_pity (person_id, since, drawn, updated_at) VALUES ($person, $since, 1, $at)
         ON CONFLICT (person_id) DO UPDATE SET since = excluded.since, drawn = drawn + 1, updated_at = excluded.updated_at`,
        { person, since: after, at },
      );
      const before = new Set(this.dex(person).map((e) => e.part));
      const collected = drawn.parts.filter((p) => !p.blank);
      for (const p of collected) {
        this.#db.run(
          `INSERT INTO cards_dex (person_id, part_id, first_at, first_card, count) VALUES ($person, $part, $at, $serial, 1)
           ON CONFLICT (person_id, part_id) DO UPDATE SET count = count + 1`,
          { person, part: p.id, at, serial: input.serial },
        );
      }
      const newParts = collected.filter((p) => !before.has(p.id)).map((p) => p.id);
      const owned = new Set([...before, ...newParts]);
      const known = new Set(this.titles(person).map((t) => t.series));
      const titles: CardTitle[] = [];
      for (const s of completedBy(catalogue, before, owned)) {
        if (known.has(s.id)) continue;
        this.#db.run(
          "INSERT INTO cards_titles (person_id, series, title, card, public, earned_at) VALUES ($person, $series, $title, $serial, 0, $at)",
          { person, series: s.id, title: s.title, serial: input.serial, at },
        );
        titles.push({
          series: s.id,
          title: s.title,
          card: input.serial,
          public: false,
          earned_at: ts,
        });
      }
      this.#events.appendNow(
        drawnWrite(
          {
            serial: input.serial,
            person,
            kind: input.kind,
            rarity: drawn.rarity,
            parts: drawn.parts.map((p) => p.id),
            expression: drawn.expression.id,
            price: input.price,
            pity_hit: drawn.pity_hit,
            pity_since: after,
            wished,
            new_parts: newParts,
          },
          ts,
        ),
      );
      for (const t of titles) {
        this.#events.appendNow(
          titledWrite({ person, series: t.series, title: t.title, serial: input.serial }, ts),
        );
      }
      const card = this.card(input.serial);
      if (card === null) throw new CardsError(`card ${input.serial} was not written`);
      return {
        card,
        pity: pityView(after, input.rules.pity),
        new_parts: newParts,
        titles,
      };
    });
  }

  /** Deletes every row of `ids` (a person and everyone merged into them). Rows per table. */
  forgetPerson(ids: readonly PersonId[]): Record<string, number> {
    if (ids.length === 0) return {};
    const [list, params] = inList(ids);
    return this.#write(() => {
      const counts: Record<string, number> = {};
      for (const table of PERSON_TABLES) {
        counts[table] = this.#db.run(`DELETE FROM ${table} WHERE person_id IN (${list})`, params);
      }
      return counts;
    });
  }

  /**
   * `absorb`'s rows as `keep`'s: the cards move, the pity keeps the longer run, the dex adds up
   * (earliest first time), the titles join, and `keep`'s wishlist wins when both have one.
   */
  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      const p = { keep, absorb };
      const cards = this.#db.run(
        "UPDATE cards_card SET person_id = $keep WHERE person_id = $absorb",
        p,
      );
      this.#db.run(
        `INSERT INTO cards_pity (person_id, since, drawn, updated_at)
         SELECT $keep, since, drawn, updated_at FROM cards_pity WHERE person_id = $absorb
         ON CONFLICT (person_id) DO UPDATE SET since = max(since, excluded.since), drawn = drawn + excluded.drawn, updated_at = max(updated_at, excluded.updated_at)`,
        p,
      );
      const pity = this.#db.run("DELETE FROM cards_pity WHERE person_id = $absorb", { absorb });
      this.#db.run(
        `INSERT INTO cards_dex (person_id, part_id, first_at, first_card, count)
         SELECT $keep, part_id, first_at, first_card, count FROM cards_dex WHERE person_id = $absorb
         ON CONFLICT (person_id, part_id) DO UPDATE SET
           count = count + excluded.count,
           first_card = CASE WHEN excluded.first_at < first_at THEN excluded.first_card ELSE first_card END,
           first_at = min(first_at, excluded.first_at)`,
        p,
      );
      const dex = this.#db.run("DELETE FROM cards_dex WHERE person_id = $absorb", { absorb });
      this.#db.run(
        `INSERT OR IGNORE INTO cards_titles (person_id, series, title, card, public, earned_at)
         SELECT $keep, series, title, card, public, earned_at FROM cards_titles WHERE person_id = $absorb`,
        p,
      );
      const titles = this.#db.run("DELETE FROM cards_titles WHERE person_id = $absorb", { absorb });
      if (this.wishlist(keep).length === 0) {
        this.#db.run("UPDATE cards_wishlist SET person_id = $keep WHERE person_id = $absorb", p);
      }
      this.#db.run("DELETE FROM cards_wishlist WHERE person_id = $absorb", { absorb });
      return { counts: { cards, pity, dex, titles } };
    });
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }
}

// ---- the plugin -----------------------------------------------------------------------------

/** A person's cards are part of their relationship with her, like the member cards were. */
const cardsData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("cards_card", "cards_card", "node", "created_at", "created_at", {
        serial: "text",
        person_id: "text",
        kind: "text",
        rarity: "text",
        parts: "json",
        face: "json",
        relationship: "json",
        artifact_id: "text",
        price: "num",
        pity_hit: "bool",
        wished: "json",
        created_at: "ts",
      }),
      tablePart("cards_pity", "cards_pity", "node", "updated_at", "person_id", {
        person_id: "text",
        since: "num",
        drawn: "num",
        updated_at: "ts",
      }),
      tablePart("cards_dex", "cards_dex", "node", "first_at", "person_id, part_id", {
        person_id: "text",
        part_id: "text",
        first_at: "ts",
        first_card: "text",
        count: "num",
      }),
      tablePart("cards_wishlist", "cards_wishlist", "node", "added_at", "person_id, position", {
        person_id: "text",
        part_id: "text",
        position: "num",
        added_at: "ts",
      }),
      tablePart("cards_titles", "cards_titles", "node", "earned_at", "person_id, series", {
        person_id: "text",
        series: "text",
        title: "text",
        card: "text",
        public: "bool",
        earned_at: "ts",
      }),
    ],
  },
];

/** The `cards` plugin's tables and code (`StorePlugin`). */
export const cardsTables: StorePlugin<CardStore> = {
  schema: cardsSchema,
  open: ({ db, events }) => new CardStore(db, events),
  data: cardsData,
  forgetPerson: (opened, request: PersonForget) => ({
    counts: opened.forgetPerson(request.ids),
  }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
