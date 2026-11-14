// @miyoria/heart/social: her social life (ARCHITECTURE §6).
//
// * Module `SocialModule` (`social`): relationships of the active profile, appraisal of
//   conversations (keyword rules plus a batched LLM pass), her impression notes, the `在場的人`
//   prompt section, `/me profile | call | link` and `/admin person ...`. Provides `SocialSignalsKey` and
//   `SocialKey`.
//
// Only this module changes relationship numbers; LLM tools cannot.

export {
  AppraisalParseError,
  appraisalRequest,
  type HeartAppraisal,
  type Line,
  notesRequest,
  type PersonAppraisal,
  parseAppraisal,
  parseHeartAppraisal,
  parseNotes,
  truncate,
} from "./appraisal.js";
export { callNameCapability } from "./call-name-tool.js";
export { PATHS, registerCommands, unregisterCommands } from "./commands.js";
export { type SocialConfig, SocialConfigSchema, socialConfig } from "./config.js";
export {
  attitude,
  type CappedEvent,
  type LinkOutcome,
  mergeInto,
  type Observed,
  type Publisher,
  Social,
  SocialKey,
  type SocialStores,
  stripTags,
  TOPIC,
} from "./engine.js";
export { applyBond, SocialError, SocialModule } from "./module.js";
export {
  apply,
  BLOCKED_TAG,
  baseChange,
  cappedKind,
  DayLedger,
  dayStart,
  diff,
  EVENT_KINDS,
  type EventKind,
  eventKindOrder,
  FLIRT_FREE_AFFINITY,
  familiarityChange,
  flirtWeight,
  hasTag,
  isBlocked,
  isOwner,
  isPositiveKind,
  type LocalDay,
  label,
  lineDepth,
  localDay,
  normalize,
  OWNER_TAG,
  parseEventKind,
  type Source,
} from "./rel.js";
export { classify } from "./rules.js";
