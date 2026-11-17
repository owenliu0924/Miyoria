// Module `cards`: the owner of the `cards` plugin's tables. It puts `[modules.cards]` in force and
// provides `CardsKey` (`CardService`), through which a daily card is issued and the odds, the pity,
// the dex and the wishlist are read. Coins go through `CardWalletKey`, which the economy provides;
// without it a card that costs anything is refused. The relationship a card shows is read from the
// heart's row of the person at the time.
//
// No commands, routes or pictures yet: those come with the wiring step. Config changes reach it the
// way they reach every module: the supervisor restarts it.

import { heartTables } from "@miyoria/heart/person";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import { type Clock, serviceKey } from "@miyoria/types";
import { CardsConfigSchema } from "./config.js";
import type { Random } from "./draw.js";
import { cardRelationship } from "./relationship.js";
import { CardService } from "./service.js";
import { cardsTables } from "./store.js";
import { CardWalletKey } from "./wallet.js";

export const CardsKey = serviceKey<CardService>("Cards");

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
      "Her cards for each person: the daily card (paid, at most a few a day), the public odds, the pity, the dex with series titles, and wishlists",
    optional: ["heart", "economy"],
    configSchema: CardsConfigSchema,
  });
  readonly #options: CardsModuleOptions;

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
    const heart = store.plugin(heartTables).people;
    const service = new CardService(cards, {
      config,
      clock: this.#options.clock ?? ctx.clock,
      // Looked up at each use: the economy may restart and provide a new one.
      wallet: () => ctx.services.get(CardWalletKey) ?? null,
      relationship: (person) => cardRelationship(heart.get(person)),
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      ...(this.#options.newSerial === undefined ? {} : { newSerial: this.#options.newSerial }),
    });
    ctx.provide(CardsKey, service);
  }

  async stop(): Promise<void> {}
}
