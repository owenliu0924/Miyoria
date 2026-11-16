// The suite `memory`: the recall harness on a labelled set, with the embedder the config names.
// It calls no chat model, so the subject, the judge and the budget play no part in it.

import { buildEmbedder, EmbeddingConfigSchema } from "@miyoria/memory/memory";
import { Config, loadDotenv } from "@miyoria/runtime/kernel";
import { memorySuite } from "../../recall/index.js";
import type { SuiteRunner } from "../suite.js";

export interface MemorySuiteSource {
  /** The labelled set (JSON, `recall/set.ts`). */
  setPath: string;
  /** `miyoria.toml`: its `[memory.embedding]` picks the embedder. */
  configPath: string;
}

/** The runner of the suite `memory` for one set and one config. */
export function memoryRunner(source: MemorySuiteSource): SuiteRunner {
  return async (ctx) => {
    loadDotenv(source.configPath);
    const config = await Config.load(source.configPath);
    const embedding = config.get("memory.embedding", EmbeddingConfigSchema);
    ctx.log(`memory: ${source.setPath}, embedding provider ${embedding.provider}`);
    const result = await memorySuite({
      setPath: source.setPath,
      embedder: buildEmbedder(embedding),
    });
    const detail = result.detail as { per_query?: unknown[] };
    return {
      suite: "memory",
      headline: result.headline,
      items: detail.per_query ?? [],
      unsupported: [],
    };
  };
}
