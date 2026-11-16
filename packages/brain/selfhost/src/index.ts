// @miyoria/brain/selfhost: the text conversations on the phase-3 turn runner
// (`@miyoria/brain/self`), wired to today's services. Core installs `selfHost()` on the agent
// module; it runs only with `[modules.agent] runner = "self"`, beside the main line, which keeps
// voice, her own starts and the work lane.

export {
  GateBook,
  type GateConfig,
  type GateFacts,
  type GateName,
  type GateSnapshot,
  type GateVerdict,
  keyOf,
  OPPORTUNITY_KINDS,
  type Opportunity,
  type OpportunityKind,
} from "./gates.js";
export { SelfHost, type SelfHostOptions, selfHost } from "./host.js";
export {
  INITIATIVE_STATE_KEY,
  Initiative,
  type InitiativeOptions,
  ScheduleRemindersKey,
  startInitiative,
} from "./initiative.js";
export {
  gateConfig,
  type InitiativeConfig,
  InitiativeConfigSchema,
  type InitiativeSettings,
  initiativeFromConfig,
  initiativeSettings,
} from "./initiative-config.js";
export { initiativeSchema } from "./initiative-migrations.js";
export {
  type InboxRow,
  InitiativeStore,
  initiativeTables,
  type ScheduleRow,
} from "./initiative-store.js";
export { Lane, type LaneHost, type LaneInput, type LaneRun } from "./lane.js";
export { MouthOutlet, type Settled, Settlements, submitTyping, TYPING_TTL_MS } from "./outlet.js";
export { type PlaceBook, resolvePlace } from "./places.js";
export {
  HostPrompt,
  type HostPromptOptions,
  RECAP_TITLE,
  type Speaker,
  speakersOf,
} from "./prompt.js";
export {
  type ParseAt,
  parseWhen,
  type ReminderBackend,
  ScheduleBook,
  scheduleKey,
} from "./schedule.js";
export { SCHEDULE, SCHEDULE_CANCEL, SCHEDULE_LIST, scheduleTools } from "./schedule-tools.js";
