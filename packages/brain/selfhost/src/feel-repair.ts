// The repair of a reply that went out without its `<feel>` block, for the text and the voice host
// (`[modules.agent.corrections] feel_repair`, brain/self `feel-repair.ts`).
//
// Asked for when a run starts (`RunInput.feelRepair`), taken when it ended, and run in the
// background: what people see or hear is out already, and the next run of the place does not wait
// for it. The call goes to the router itself, not through the run's model, so it is no part of the
// next voice run's marks or of a saved prompt. What it brings back is applied like a block of the
// run. Skipped while the day's LLM budget is not `ok` (only what someone is owed passes then); the
// runner skips it for someone at their AI quota.

import { errorMessage, type Logger } from "@miyoria/runtime/kernel";
import type { FeelRepairOutcome, RunModel, SelfRunner } from "../../self/src/index.js";

export interface FeelRepairsDeps {
  /** `[modules.agent.corrections] feel_repair`, read when a run starts and when it ended. */
  enabled(): boolean;
  /** The day's LLM budget state. */
  budget(): "ok" | "degraded" | "exhausted";
  /** The router, without a run's hooks. */
  model(): Pick<RunModel, "stream" | "prices">;
  log: Pick<Logger, "debug" | "warn">;
  /** The host stopping: a repair still going is dropped. */
  signal: AbortSignal;
}

export class FeelRepairs {
  readonly #d: FeelRepairsDeps;
  readonly #pending = new Set<Promise<void>>();

  constructor(deps: FeelRepairsDeps) {
    this.#d = deps;
  }

  /** What a run's input asks for (`RunInput.feelRepair`). */
  wanted(): boolean {
    return this.#d.enabled();
  }

  /**
   * After the run of `turn` ended: its repair, if it left one, runs in the background and `apply`
   * gets the blocks it brought. `apply` `null`: the run's feel is not applied (a run cut for a
   * restart, one that never was), so the repair is only dropped.
   */
  after(runner: SelfRunner, turn: string, apply: ((feel: string[]) => void) | null): void {
    const repair = runner.takeFeelRepair(turn);
    if (repair === null || apply === null || !this.#d.enabled()) return;
    const budget = this.#d.budget();
    if (budget !== "ok") {
      this.#d.log.debug({ turn, budget }, "feel repair skipped: the day's budget");
      return;
    }
    let model: Pick<RunModel, "stream" | "prices">;
    try {
      model = this.#d.model();
    } catch (error) {
      this.#d.log.warn({ turn, err: errorMessage(error) }, "feel repair: no model");
      return;
    }
    const job = repair
      .run({ model, signal: this.#d.signal })
      .then((outcome) => {
        this.#log(turn, outcome);
        if (outcome.status === "repaired") apply(outcome.feel);
      })
      .catch((error: unknown) => {
        this.#d.log.warn({ turn, err: errorMessage(error) }, "feel repair failed");
      })
      .finally(() => {
        this.#pending.delete(job);
      });
    this.#pending.add(job);
  }

  /** Resolves once every repair started so far has ended (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  #log(turn: string, outcome: FeelRepairOutcome): void {
    const usage =
      outcome.status === "repaired" || outcome.status === "empty" ? outcome.usage : null;
    this.#d.log.debug(
      {
        turn,
        status: outcome.status,
        ...(outcome.status === "skipped" && { reason: outcome.reason }),
        ...(outcome.status === "failed" && { err: outcome.error }),
        ...(usage !== null && {
          prompt_tokens: usage.prompt_tokens,
          cached_prompt_tokens: usage.cached_prompt_tokens,
          completion_tokens: usage.completion_tokens,
        }),
      },
      "feel repair",
    );
  }
}
