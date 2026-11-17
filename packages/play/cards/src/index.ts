// @miyoria/play/cards: her cards for each person (docs/design/v5-play.md §2, §6.3, §10; cards.md).
//
// - `catalogue.ts`: the slots, rarities, series and the catalogue `cards_parts` is seeded with.
// - `draw.ts`: the draw as pure functions with the random source passed in: the rarity by the
//   public weights, the pity, the parts allowed for that rarity, her expression by relationship.
// - `expressions.ts`: which expressions each tier of the relationship may show.
// - `odds.ts`: the public odds table, from the catalogue and the draw's own helpers.
// - `dex.ts`: series progress and titles, and what a wishlist may hold.
// - `config.ts`: `[modules.cards]` (price, daily cap, pity, rarity weights).
// - `legacy.ts`: the old collectibles, kept as the closed series 舊收藏.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `cards` store plugin (`cards_card`, `cards_parts`,
//   `cards_pity`, `cards_dex`, `cards_wishlist`, `cards_titles`) and the transaction that writes a
//   card with its pity, dex, titles and events (`events.ts`).
// - `wallet.ts`: the port through which a card is paid (`CardWalletKey`, the economy's to provide).
// - `service.ts`, `module.ts`: module `cards` and `CardsKey`: issuing a daily card, the odds, a
//   person's pity, dex and wishlist.

export {
  drawPool,
  isRare,
  isRarity,
  isSlot,
  type Part,
  RARITIES,
  type Rarity,
  rarityRank,
  SEED_PARTS,
  SERIES,
  type Series,
  SLOT_NAMES,
  SLOTS,
  type Slot,
  seriesOf,
} from "./catalogue.js";
export { type CardsConfig, CardsConfigSchema, cardsConfig, drawRules } from "./config.js";
export {
  completedBy,
  MAX_WISHES,
  type SeriesProgress,
  seriesParts,
  seriesProgress,
  type WishlistProblem,
  wishlistProblem,
} from "./dex.js";
export {
  CardsError,
  type DrawInput,
  type DrawnCard,
  type DrawnPart,
  type DrawRules,
  type DrawSnapshot,
  drawCard,
  drawnPart,
  headlineSlots,
  nextSince,
  type PityView,
  pityApplies,
  pityView,
  type Random,
  type RarityWeights,
  rarityChances,
  seededRandom,
  slotParts,
  wishedOn,
} from "./draw.js";
export {
  CARDS_DRAWN,
  CARDS_SOURCE,
  CARDS_TITLED,
  type CardDrawnData,
  type CardTitledData,
  drawnWrite,
  titledWrite,
} from "./events.js";
export { EXPRESSIONS, type Expression, expressionsFor } from "./expressions.js";
export { LEGACY_ITEMS, LEGACY_SERIES, type LegacyItem } from "./legacy.js";
export { CARDS_CATALOGUE_SQL, cardsSchema } from "./migrations.js";
export { CardsKey, CardsModule, type CardsModuleOptions } from "./module.js";
export {
  type OddsPart,
  type OddsRarity,
  type OddsSlot,
  type OddsTable,
  oddsTable,
  shownPercents,
} from "./odds.js";
export { cardRelationship } from "./relationship.js";
export {
  type CardsCardRow,
  type CardsPartRow,
  cardsCard,
  cardsDex,
  cardsLegacy,
  cardsParts,
  cardsPity,
  cardsTitles,
  cardsWishlist,
} from "./schema.js";
export { newSerial } from "./serial.js";
export {
  CARD_TEXTS,
  CardService,
  type CardServiceOptions,
  type DailyOptions,
  type DailyQuote,
  type DailyRefusal,
  type DailyResult,
  type DexPart,
  type DexView,
  dayStart,
  refusalText,
} from "./service.js";
export {
  CARD_KINDS,
  CardCapError,
  type CardFace,
  type CardField,
  type CardKind,
  type CardRecord,
  type CardRelationship,
  CardStore,
  type CardTitle,
  cardsTables,
  type DexEntry,
  type IssuedCard,
  type IssueInput,
} from "./store.js";
export {
  CARD_REASONS,
  type CardCharge,
  type CardPayer,
  type CardWallet,
  CardWalletKey,
} from "./wallet.js";
