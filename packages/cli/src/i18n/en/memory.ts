// Messages of `miyoria memory rebuild`.

export const memory = {
  /** A detail in parentheses after a phrase: ` (deepseek:chat)`. */
  aside: (text: string) => ` (${text})`,
  unknownKind: (name: string, kind: string) => `provider \`${name}\`: unknown kind \`${kind}\``,
  badSince: (text: string) => `--since must be an ISO date, for example 2026-11-15: ${text}`,
  badMaxUsd: (text: string) => `--max-usd must be a number greater than 0 (US dollars): ${text}`,
  noDatabase: (path: string) => `Database not found: ${path}`,
  held: "The database is open in another process (Core or another program). Stop Core first, or add --force if you are sure it is safe.",
  noEvents: "This database has no event log; there is nothing to rebuild",
  // ---- the plan ----
  section: (path: string) => `Rebuild memory: ${path}`,
  scope: (since: string, apply: boolean) =>
    `Chat events since ${since}; ${apply ? "the model is called" : "preview, the model is not called"}`,
  sessions: (n: string) => `  Sessions: ${n}`,
  lines: (n: string) => `  Chat lines: ${n}`,
  segments: (todo: string, done: string) =>
    `  Segments: ${todo} (not yet processed; ${done} already processed are skipped)`,
  unplaced: (n: number) =>
    `  ${n} ${n === 1 ? "session" : "sessions"} with no known place, skipped`,
  estimate: (prompt: string, completion: string) =>
    `  Estimate: ${prompt} input tokens, ${completion} output tokens`,
  withReasoning: (level: string) => ` (includes reasoning, level ${level})`,
  /** `usd`: the formatted amount; `null` when the price is unknown. */
  cost: (usd: string | null) => `  Estimated cost: ${usd ?? "price unknown"}`,
  vectorsOff:
    "  Vectors: off ([memory.embedding] provider = none); notes are found by keyword only",
  vectorsWaiting: (waiting: string, lines: string) =>
    `  Vectors: ${waiting} of ${lines} lines without a vector`,
  applyHint: (maxUsd: string) =>
    `Add --apply to start (--max-usd sets the spending limit, default ${maxUsd}). A stopped run continues where it left off.`,
  // ---- the run ----
  /** `label`: the model, or `null` without a chain. */
  noPrice: (label: string | null) =>
    `The config has no price for ${label ?? "this purpose"} ([llm.pricing]); without a price, --max-usd cannot limit spending`,
  overBudget: (estimate: string, limit: string) =>
    `The estimate of ${estimate} exceeds the limit of ${limit}; the run stops when the limit is reached and can be continued later`,
  resultLabel: "Result",
  result: (
    label: string,
    status: string,
    segments: number,
    total: number,
    empty: number,
    abandoned: number,
  ) =>
    `${label}: ${status}; ${segments} / ${total} segments processed (${empty} empty, ${abandoned} abandoned)`,
  written: (lines: number, dropped: number, episodes: number) =>
    `  Wrote ${lines} lines (${dropped} dropped) and ${episodes} ${episodes === 1 ? "episode" : "episodes"}`,
  usage: (calls: number, prompt: string, completion: string, usd: string) =>
    `  Model: ${calls} ${calls === 1 ? "call" : "calls"}, ${prompt} input and ${completion} output tokens, cost ${usd}`,
  vectorBatch: (done: number, waiting: number) =>
    `  Vectors: ${done} lines done, ${waiting} remaining`,
  whyOff: "the embedding model could not be loaded (see the log above)",
  whyStalled: "the embedding model failed (see the log above)",
  whyAborted: "interrupted",
  /** `why`: why vectors are still missing, `null` when there is no reason to give. */
  vectorsAdded: (done: string, waiting: string | null, why: string | null) =>
    `  Vectors: ${done} added${
      waiting === null
        ? ""
        : `, ${waiting} lines still without a vector${why === null ? "" : ` (${why}; a running Core fills them in the background)`}`
    }`,
  done: "Done",
  doneNote:
    "From the next start, the character's memory is based on notes: segments are processed live, the old consolidation stops, and recall reads the notes",
  budgetStop: "Stopped at the spending limit; run again to continue from here",
  aborted: "Interrupted; run again to continue from here",
  modelError: (error: string | null) =>
    `The model failed and the run stopped: ${error ?? "unknown error"} (run again to continue)`,
};
