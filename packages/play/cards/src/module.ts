// Module `cards`: the owner of the `cards` plugin's tables. It puts `[modules.cards]` in force and
// provides `CardsKey` (`CardService`), through which a daily card is issued and the odds, the pity,
// the dex and the wishlist are read. Coins go through `CardWalletKey`, which the economy provides;
// without it a card that costs anything is refused. The relationship a card shows is read from the
// heart's row of the person at the time.
//
// It listens to the heart for a bond entering a tier it never reached (`onTierEntered`) and gives a
// milestone card for each such tier (§6.1); her words for it come through `CardFacesKey`. A tier
// entered while this module is not running gets no card later: the cards are never handed out
// backwards.
//
// The routes and the commands are the api's (`KeepsakesKey`, the `cards` route group). Config
// changes reach it the way they reach every module: the supervisor restarts it.

import { type HeartStore, heartTables, type TierEntered } from "@miyoria/heart/person";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { type Store, StoreKey } from "@miyoria/store";
import {
  type Clock,
  EventLogKey,
  HandleDirectoryKey,
  type PersonId,
  serviceKey,
} from "@miyoria/types";
import { CardsConfigSchema } from "./config.js";
import type { Random } from "./draw.js";
import { CardFacesKey, type OccasionFace } from "./faces.js";
import { cardNotes } from "./notes.js";
import { cardRelationship } from "./relationship.js";
import { CardService } from "./service.js";
import { type CardStore, cardsTables, type IssuedCard } from "./store.js";
import { CardWalletKey } from "./wallet.js";

export const CardsKey = serviceKey<CardService>("Cards");

/** Her working-context bucket for the cards, and how many notes it keeps. */
const WRITER = "cards";
const MAX_ENTRIES = 6;

/**
 * A card worth a word (`notes.ts`) as a note she may react to: an observation on the event log,
 * not silent, once per card, in her working context. Names are untrusted.
 */
function tell(ctx: ModuleContext, issued: IssuedCard, cards: CardStore): void {
  const names = new Map(cards.catalogue().map((p) => [p.id, p.name]));
  const lines = cardNotes(issued, names);
  if (lines.length === 0) return;
  const handle = ctx.services.get(HandleDirectoryKey)?.ofPerson(issued.card.person) ?? null;
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "cards.drawn",
      silent: false,
      salience: "notable",
      attention_key: `cards:${issued.card.serial}`,
      revision: 1,
      summary: lines.join("\n"),
      addressed_to_her: false,
      from: handle,
      context: null,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer: WRITER,
          owner: CardsModule.ID,
          untrusted: true,
          max_entries: MAX_ENTRIES,
        },
      ],
      person: handle,
    },
  );
}

export interface CardsModuleOptions {
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
  random?: Random;
  newSerial?: () => string;
}

export class CardsModule implements Module {
  static readonly ID = "cards";
  readonly manifest = defineManifest(CardsModule.ID, "Cards", {
    description:
      "Her cards for each person: the daily card (paid, at most a few a day), milestone cards for a new tier, the public odds, the pity, the dex with series titles, and wishlists",
    optional: ["heart", "economy"],
    configSchema: CardsConfigSchema,
  });
  readonly #options: CardsModuleOptions;
  readonly #pending = new Set<Promise<void>>();
  #stop: (() => void) | null = null;

  constructor(options: CardsModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(CardsConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no cards");
      return;
    }
    const cards = store.plugin(cardsTables);
    try {
      const copied = cards.importLegacy();
      if (copied > 0)
        ctx.log.info({ copied }, "cards: the old collectibles were copied to the dex");
    } catch (error) {
      ctx.log.warn(
        { err: errorMessage(error) },
        "cards: cannot copy the old collectibles; the next start tries again",
      );
    }
    const heart = store.plugin(heartTables).people;
    const service = new CardService(cards, {
      config,
      clock: this.#options.clock ?? ctx.clock,
      // Looked up at each use: the economy may restart and provide a new one.
      wallet: () => ctx.services.get(CardWalletKey) ?? null,
      relationship: (person) => cardRelationship(heart.get(person)),
      onIssued: (issued) => tell(ctx, issued, cards),
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      ...(this.#options.newSerial === undefined ? {} : { newSerial: this.#options.newSerial }),
    });
    ctx.provide(CardsKey, service);
    // A bond entering a tier it never reached: one milestone card per tier (§6.1).
    const off = heart.onTierEntered((entered) => {
      const run = milestones(ctx, service, store, heart, entered);
      this.#pending.add(run);
      void run.finally(() => this.#pending.delete(run));
    });
    this.#stop = off;
  }

  async stop(): Promise<void> {
    this.#stop?.();
    this.#stop = null;
    await Promise.allSettled([...this.#pending]);
  }
}

/**
 * The milestone cards of `entered`, lowest tier first. Her words come from `CardFacesKey` (the api
 * module's) when it runs; without it the card carries the person's name and nothing she wrote.
 * Failures are logged: the heart's write is long committed.
 */
async function milestones(
  ctx: ModuleContext,
  service: CardService,
  store: Store,
  heart: HeartStore,
  entered: TierEntered,
): Promise<void> {
  const { person } = entered;
  for (const tier of entered.tiers) {
    try {
      const result = await service.issueMilestone(person, tier, async () => {
        const anchor = heart
          .get(person)
          ?.anchors.find((a) => a.tier === tier.min && a.by !== "migrate" && a.quote !== "");
        const faces = ctx.services.get(CardFacesKey);
        if (faces !== undefined) {
          return faces.face(person, {
            kind: "milestone",
            tier: tier.label,
            scene: anchor?.quote ?? null,
          });
        }
        return plainFace(store, heart, service, person);
      });
      if (!result.ok) {
        ctx.log.info(
          { person, tier: tier.label, reason: result.reason },
          "cards: no milestone card",
        );
      }
    } catch (error) {
      ctx.log.warn(
        { person, tier: tier.label, err: errorMessage(error) },
        "cards: cannot issue a milestone card",
      );
    }
  }
}

/** A card's face without the api: their name, nothing she wrote; `null` without an account. */
async function plainFace(
  store: Store,
  heart: HeartStore,
  service: CardService,
  person: PersonId,
): Promise<OccasionFace | null> {
  const [account] = await store.identity.accountsOf(person);
  if (account === undefined) return null;
  return {
    face: {
      name: account.display_name,
      avatar_url: null,
      call_name: null,
      line: null,
      stamp: null,
      fields: [],
      number: service.count(person) + 1,
    },
    // Her line for them only ever goes on a card through the api's screen.
    relationship: { ...cardRelationship(heart.get(person)), public_feeling: null },
  };
}
