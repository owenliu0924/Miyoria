// Messages of the commands that talk to a running Core through the admin API.

export const remote = {
  noToken: "MIYORIA_API_TOKEN is not set. Run `miyoria init` to generate it.",
  usageTitle: "LLM usage (since start)",
  /** Module states as `module list` and `status` show them. */
  moduleStates: {
    starting: "starting",
    running: "running",
    degraded: "degraded",
    stopping: "stopping",
    stopped: "stopped",
    failed: "failed",
    disabled: "disabled",
  },
  /** `prompt`, `cached`, `completion`: token counts, formatted. */
  usage: (model: string, calls: number, prompt: string, cached: string, completion: string) =>
    `  ${model}: ${calls} ${calls === 1 ? "call" : "calls"}, input ${prompt} tokens (${cached} cached), output ${completion} tokens`,
  /** The decision column of `miyoria decisions`. */
  replied: "reply",
  skipped: "skip",
  /** After a heading: ` (12 characters)`. */
  characters: (n: number) => ` (${n} ${n === 1 ? "character" : "characters"})`,
  personaUpdated: (key: string, version: number) =>
    `\`${key}\` updated to version ${version}; it takes effect from the next turn`,
};
