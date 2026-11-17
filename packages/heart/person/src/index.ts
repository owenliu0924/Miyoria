// @miyoria/heart/person: her numbers and words for each person, and the rules that move them
// (docs/design/v5-heart.md §2.2, §2.3; phase 4 step 1, "資料和規則").
//
// - `model.ts`: a person as a `heart_person` row (nine numbers, her words about them, the tier
//   anchors, when she last saw them, `legacy`).
// - `rules.ts`: pure functions. The size of a `feel` proposal, the repeat damping, the daily caps
//   (H3), the anchors a tier needs (H4), the daily decay (H9) and the one definition of 在意.
// - `log.ts`: a change is one `heart.changed` event and evidence one `heart.evidence`; a
//   person's history and the day's ledger are read from them.
// - `legacy.ts`: the migration from `relationships`, `relationship_deltas`, the
//   `self:feeling:<person>` cards and the `hearts` of `self:state`.
// - `config.ts`: every number of the rules, with its default.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `heart` store plugin (`heart_person`,
//   `heart_self`) and the code that writes a row and its event in one transaction.
// - `public.ts`: what a member may see (words, the ring, the tier; no raw value).
//
// Nothing runs these yet, and no store is opened with `heartTables`: the modules still use
// `social`, `self` and `mind` until the next steps of the phase switch them over.

export {
  type HeartPersonConfig,
  HeartPersonConfigSchema,
  heartPersonConfig,
} from "./config.js";
export {
  type LegacyHearts,
  type LegacyInput,
  type LegacyResult,
  migrateLegacy,
  parseLegacyHearts,
} from "./legacy.js";
export {
  changeWrite,
  evidenceWrite,
  HEART_SOURCE,
  type HeartEvidenceEntry,
  type HeartHistoryEntry,
  HeartLog,
} from "./log.js";
export { heartSchema } from "./migrations.js";
export {
  type AnchorSource,
  BLOCKED_TAG,
  clampField,
  type Direction,
  FIELD_RANGE,
  goodDirection,
  HEART_FIELDS,
  type HeartCause,
  type HeartField,
  type HeartPerson,
  hasAnchor,
  hasTag,
  isProposalField,
  newPerson,
  OWNER_TAG,
  PROPOSAL_FIELDS,
  type ProposalField,
  type TierAnchor,
} from "./model.js";
export { type PublicBond, type PublicRing, publicBond } from "./public.js";
export {
  ANCHORED_TIERS,
  type AppliedChange,
  applyBond,
  applyChange,
  applyDecay,
  type BondResult,
  bondGainCap,
  bookChange,
  CAPPED_CAUSES,
  CARE_BY_TIER,
  CARES_THRESHOLD,
  capLeft,
  cares,
  caresBase,
  type DayLedger,
  type DecayPass,
  dailyCap,
  dayStart,
  decayDay,
  emptyLedger,
  type FieldLedger,
  familiarityGain,
  type HeartChange,
  type HeartChangeRequest,
  isNegative,
  type LocalDay,
  ledgerFrom,
  lineDepth,
  localDay,
  proposalStep,
  repeatFactor,
  settle,
  warmthBaseline,
} from "./rules.js";
export { type HeartPersonRow, type HeartSelfRow, heartPerson, heartSelf } from "./schema.js";
export {
  type HeartApplied,
  type HeartApplyOptions,
  type HeartListEntry,
  type HeartListOptions,
  type HeartPersonPage,
  HeartSelfStore,
  HeartStore,
  type HeartTables,
  heartTables,
} from "./store.js";
