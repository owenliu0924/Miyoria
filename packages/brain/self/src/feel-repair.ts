// A reply of hers that went out without its `<feel>` block (docs/design/v5-heart.md §2.1): one
// small call after the run, asking for the block alone.
//
// Her earlier replies come back in the transcript without their blocks (the blocks are the
// host's), so a model that copies them leaves the block out (live eval 2026-11-27: 14 replies of
// 35, 4 of 5 in the scene whose history has her own lines). The run that ended keeps what the
// call needs (`RunInput.feelRepair`): the request its next step would have sent, which is the last
// step's request with her reply after it, so the provider's prefix cache serves almost all of it.
// The tools stay in it for the same reason; a call she makes is ignored, and so is any text
// outside the block: nothing of the repair is ever shown or said.
//
// Bounded: one attempt, a short timeout, a small `max_tokens`, no reasoning. Charged like the run
// it belongs to: an even share to each person the run worked for (their AI quota), and skipped
// when any of them is at their quota. Recorded under the run's turn with the label `feel`.

import {
  type ChatRequest,
  type Pricing,
  systemMessage,
  type Usage,
  withLlmTag,
} from "@miyoria/llm/llm";
import { errorMessage } from "@miyoria/runtime/kernel";
import { isFeelLine } from "./feel.js";
import { chargeOf, type Payer, type PersonQuota, stepCost } from "./quota.js";
import { FEEL_REPAIR_NOTE } from "./rules.js";
import type { RunModel } from "./types.js";

/** One repair waits this long at most (ms). */
export const FEEL_REPAIR_TIMEOUT_MS = 20_000;
/** A feel block is a few short lines: the answer is cut here. */
export const FEEL_REPAIR_MAX_TOKENS = 240;
/** The label of its call record (`LlmCallTag.label`). */
export const FEEL_REPAIR_LABEL = "feel";

/** What a run that ended without a block keeps for its repair. */
export interface FeelRepairSpec {
  turn: string;
  /** The model chain of the run (`RunProfile.purpose`). */
  purpose: string;
  /** The request the run's next step would have sent: everything up to and with her reply. */
  request: ChatRequest;
  /** The people the run worked for: each pays an even share. */
  payers: readonly Payer[];
  quota: PersonQuota | null;
  /** USD per million tokens of a model without a price. */
  rate: () => number;
  model: RunModel;
  now: () => number;
}

export interface FeelRepairOptions {
  /** The model to ask instead of the run's (a host's own, without the run's hooks). */
  model?: Pick<RunModel, "stream" | "prices">;
  /** Ends the repair early (the host stopping). */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
}

export type FeelRepairOutcome =
  /** She wrote a block: `feel` is its inside, applied like a block of the run. */
  | { status: "repaired"; feel: string[]; usage: Usage | null; cost_usd: number | null }
  /** She answered without one. */
  | { status: "empty"; usage: Usage | null; cost_usd: number | null }
  /** No call was made: someone the run worked for is at their AI quota. */
  | { status: "skipped"; reason: "quota" }
  /** The call failed or timed out; nothing is applied. */
  | { status: "failed"; error: string };

const BLOCK = /<\s*feel\s*>([\s\S]*?)(?:<\s*\/\s*feel\s*>|$)/giu;

/**
 * The inside of each feel block of `text`; with none, the lines that read like one written without
 * its tags (`isFeelLine`), as one block. Empty when there is neither.
 */
export function feelOfRepair(text: string): string[] {
  const blocks = [...text.matchAll(BLOCK)]
    .map((m) => (m[1] ?? "").trim())
    .filter((b) => b !== "")
    .map((b) => `${b}\n`);
  if (blocks.length > 0) return blocks;
  const lines = text
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l !== "" && isFeelLine(l) && !/<\/?\s*feel/iu.test(l));
  return lines.length === 0 ? [] : [`${lines.join("\n")}\n`];
}

/** The repair of one run's missing block; run it once, after the run. */
export class FeelRepair {
  readonly turn: string;
  readonly #s: FeelRepairSpec;
  #ran = false;

  constructor(spec: FeelRepairSpec) {
    this.turn = spec.turn;
    this.#s = spec;
  }

  /** The request the repair sends: the run's next request, the note, small and without reasoning. */
  request(maxTokens = FEEL_REPAIR_MAX_TOKENS): ChatRequest {
    const r = this.#s.request;
    return {
      ...r,
      messages: [...r.messages, systemMessage(FEEL_REPAIR_NOTE)],
      reasoning: "off",
      max_tokens: maxTokens,
    };
  }

  async run(options: FeelRepairOptions = {}): Promise<FeelRepairOutcome> {
    if (this.#ran) return { status: "failed", error: "already ran" };
    this.#ran = true;
    const s = this.#s;
    const quota = s.quota;
    if (quota !== null) {
      const now = s.now();
      const capped = s.payers.some(
        (p) => p.exempt !== true && quota.limitAt(p.person, now) !== null,
      );
      if (capped) return { status: "skipped", reason: "quota" };
    }
    const model = options.model ?? s.model;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? FEEL_REPAIR_TIMEOUT_MS);
    const signal =
      options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    let text = "";
    let usage: Usage | null = null;
    let answered: string | null = null;
    try {
      await withLlmTag({ module: "agent", turn: s.turn, label: FEEL_REPAIR_LABEL }, async () => {
        const stream = await model.stream(s.purpose, this.request(options.maxTokens), signal);
        answered = stream.model ?? null;
        for await (const ev of stream) {
          if (ev.type === "text_delta") text += ev.text;
          else if (ev.type === "done") usage = ev.usage;
          signal.throwIfAborted();
        }
      });
    } catch (error) {
      this.#charge(model.prices?.(), answered, usage);
      return { status: "failed", error: signal.aborted ? "timed out" : errorMessage(error) };
    }
    const cost_usd = this.#charge(model.prices?.(), answered, usage);
    const feel = feelOfRepair(text);
    return feel.length === 0
      ? { status: "empty", usage, cost_usd }
      : { status: "repaired", feel, usage, cost_usd };
  }

  /** Charges the call to the run's people, an even share each; returns its priced cost. */
  #charge(
    prices: Record<string, Pricing> | undefined,
    model: string | null,
    usage: Usage | null,
  ): number | null {
    if (usage === null) return null;
    const s = this.#s;
    const cost = stepCost(prices, model, usage);
    const charged = chargeOf(cost, usage, s.rate());
    const share = s.payers.length === 0 ? 0 : charged / s.payers.length;
    for (const p of s.payers) s.quota?.add(p.person, s.now(), share);
    return cost;
  }
}
