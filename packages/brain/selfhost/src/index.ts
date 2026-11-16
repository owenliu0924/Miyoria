// @miyoria/brain/selfhost: the text conversations on the phase-3 turn runner
// (`@miyoria/brain/self`), wired to today's services. Core installs `selfHost()` on the agent
// module; it runs only with `[modules.agent] runner = "self"`, beside the main line, which keeps
// voice, her own starts and the work lane.

export { SelfHost, type SelfHostOptions, selfHost } from "./host.js";
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
