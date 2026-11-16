// @miyoria/brain/agent: the cognition core (module `agent`).
//
// Turns `platform.*` and `voice.*` events into replies: each conversation context keeps a
// `Session`, a coordinator debounces messages into turns, attention decides whether to respond,
// and the reply is generated through the `chat` LLM purpose (with an optional tool loop),
// parsed by the expression parser and submitted to the scheduler. In voice channels the reply
// is cut into sentences that are spoken while the model is still generating.
//
// Other modules shape her turns through optional services: prompt contributors
// (`PromptContributorsKey`) add per-turn context, `SocialSignalsKey` and `MoodSignalsKey` steer
// attention and tone, and `agent.initiative` events let her start conversations. `llm.budget`
// events make her save tokens (see `BudgetState`).

export { type Tool, type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
export {
  ACTIVENESS_CAPABILITY,
  activenessCapability,
  chatCapabilities,
  LEVEL_TALKATIVENESS,
} from "./actions.js";
export {
  ACTIVENESS_SHIFT,
  type Assessment,
  type AttentionInput,
  ambientScale,
  answersHer,
  asideOf,
  assess,
  conversing,
  decide,
  directReason,
  effectiveTalk,
  flooredTalk,
  followsHerLine,
  type Gate,
  isQuestion,
  mentionsTopic,
  type RandomSource,
  SeededRandom,
  SILENT_TALKATIVENESS,
  type TalkLevel,
  talkFactor,
  USUAL_TALKATIVENESS,
  type VoiceAttention,
  vocativeName,
} from "./attention.js";
export { activenessLabel } from "./commands.js";
export {
  type Budgeted,
  type BudgetOptions,
  budgetBlocks,
  budgetSelf,
  contributedData,
  fairShares,
  fitBody,
  ordered,
  renderSections,
  SavedPrompts,
  SavedPromptsKey,
  type SelfBlock,
  SUPERSEDED,
  savedMessages,
  savedPrompt,
  squeeze,
} from "./compiler.js";
export {
  ACTIVENESS_LEVELS,
  type Activeness,
  ActivenessSchema,
  type AgentConfig,
  AgentConfigSchema,
  AMBIENT_MODES,
  type AttentionConfig,
  AttentionConfigSchema,
  activenessFor,
  CHANNEL_MODES,
  type ChannelMode,
  ChannelModeSchema,
  defaultAgentConfig,
  type FilesConfig,
  FilesConfigSchema,
  type HistoryConfig,
  HistoryConfigSchema,
  LOOP_TOOLS,
  MainLineConfigSchema,
  maxDebounceMs,
  modeFor,
  ParseError,
  type PromptConfig,
  PromptConfigSchema,
  parseActiveness,
  parseChannelMode,
  typingRefreshMs,
  type VisionConfig,
  VisionConfigSchema,
  type VoiceConfig,
  VoiceConfigSchema,
  voiceMaxDebounceMs,
  WORK_TOOLS,
  type WorkConfig,
  WorkConfigSchema,
} from "./config.js";
export { Gathered, gather } from "./contributors.js";
export {
  DEFAULT_PAUSE_MS,
  Expression,
  ExpressionParser,
  MAX_PAUSE_MS,
  type Segment,
} from "./expression.js";
export { type FileCandidate, fileParts, selectFiles } from "./files.js";
export {
  type CallKind,
  callKind,
  callsHer,
  type FocusSelection,
  focusVerb,
  oneCaller,
  selectFocus,
  TurnFocusBoard,
  type TurnFocusInit,
  type VoiceCallFacts,
} from "./focus.js";
export {
  ACTIVENESS_PREFIX,
  AgentHandle,
  AgentHandleKey,
  MODE_PREFIX,
  voiceScope,
} from "./handle.js";
export { awaitBackfill, backfillLimit, replyParents, startBackfill } from "./history.js";
export { AgentIntents } from "./intents.js";
export { isSelfTalk, ReplyScreen } from "./leak.js";
export {
  CEILINGS,
  type Ceiling,
  cappedTalk,
  ceilingFor,
  levelHint,
  modeDescription,
  modeLabel,
  paceMs,
} from "./levels.js";
export {
  ACTING_ALONE,
  FALLBACK_LINES,
  MainLine,
  MainTurn,
  type SayOptions,
} from "./mainline/main.js";
export { COMMIT_SPEC, STEER_SPEC, slimTool } from "./mainline/output.js";
export {
  contextData,
  entryCost,
  estimateTokens,
  exampleDialogues,
  examplesBlock,
  fitHistory,
  historyWindow,
  mainMessages,
  mainRules,
  pinnedSection,
  promptTokens,
  proposalData,
  rotatedExamples,
  stableHash,
  tailSection,
  type WindowBudget,
} from "./mainline/prompt.js";
export { linkMentions, type MentionTarget } from "./mentions.js";
export { agentTurns, CorrectionTally } from "./metrics.js";
export { AgentModule } from "./module.js";
export { PersonaHandle, PersonaHandleKey } from "./persona.js";
export {
  BOT_TAG,
  buildMessages,
  cleanReply,
  DEFAULT_TRANSCRIPT,
  FOCUS_HEAD,
  focusMessage,
  gapLine,
  INITIATIVE_TITLE,
  INTENT_TITLE,
  INTERRUPTED,
  type IntentData,
  intentBody,
  MAX_PARENT_CHARS,
  PRESENT_TITLE,
  replyTag,
  SELF_QUOTE_NAME,
  SPOKEN_TAG,
  speaksReminder,
  speaksRule,
  splitMessage,
  type TranscriptOptions,
  transcriptLine,
  VOICE_PRESENT_TITLE,
  whenAndWhere,
} from "./prompt.js";
export {
  Agent,
  type TextLineMarks,
  type TextRunner,
  type TextRunnerFactory,
} from "./runtime.js";
export { toTraditional } from "./script.js";
export {
  activityBlock,
  feelingCauseBody,
  goalsBlock,
  ledgerBlock,
  moodBlock,
  noticesBlock,
  type PeopleSources,
  type PresentPerson,
  peopleBody,
  policyBlock,
  type SelfSources,
  selfBlocks,
} from "./self-block.js";
export {
  type HistoryEntry,
  historyEntry,
  messageText,
  Session,
  type SessionParticipant,
} from "./session.js";
export {
  type BudgetState,
  EXHAUSTED_LINE,
  herStatusHint,
  parseBudgetState,
  shownHint,
  unansweredHint,
} from "./signals.js";
export {
  type FencedPiece,
  FenceSplitter,
  isSpeakable,
  LinkSplitter,
  LONG_CLAUSE_CHARS,
  SentenceSplitter,
} from "./speech.js";
export { ReactTool, ToolArgumentError } from "./tools.js";
export {
  focusVerbs,
  markCurrent,
  TurnError,
  type TurnPlan,
  truncate,
} from "./turn.js";
export { TimeoutError, timeout } from "./util.js";
export {
  allowedUrl,
  type FetchLike,
  type ImageCandidate,
  ImageLoader,
  imageParts,
  type LoadedImage,
  selectImages,
} from "./vision.js";
export { allowance, talks } from "./worklane/allow.js";
export {
  WORK_LIST_TOOL,
  WORK_START_TOOL,
  WORK_STEER_TOOL,
  workCapabilities,
} from "./worklane/capabilities.js";
export { ACTIVITY_TOOLS, asWork, WORK_ACTIVITIES, workBoard } from "./worklane/initiative.js";
export {
  type LaneDeps,
  RESTART_REASON,
  type StartOutcome,
  type StartSpec,
  type SteerSpec,
  shortId,
  WorkLaneService,
} from "./worklane/lane.js";
