// Her mind reads her documents only through the knowledge service's prompt text, which the
// learning module serves from the notes; it never lists or fetches the old documents.

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type KnowledgeBase, KnowledgeKey, type KnowledgeSubject } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { gather } from "../src/snapshot.js";

function knowledge(text: string, asked: KnowledgeSubject[][]): KnowledgeBase {
  const refused = () => {
    throw new Error("the mind must not read documents any other way");
  };
  return {
    docs: refused,
    get: refused,
    apply: refused as never,
    render: (subjects) => {
      asked.push([...subjects]);
      return text;
    },
  };
}

async function gathered(kb: KnowledgeBase | null) {
  const services = new ServiceRegistry();
  if (kb !== null) services.provide("test", KnowledgeKey, kb);
  return gather({
    services,
    profile: "p" as never,
    now: Date.UTC(2026, 10, 16),
    triggers: [],
    suggestions: [],
    salient: [],
    contributors: [],
    labels: new Map(),
  });
}

describe("what her mind reads of her documents", () => {
  it("is the prompt text of the knowledge service, with herself among the subjects", async () => {
    const asked: KnowledgeSubject[][] = [];
    const got = await gathered(knowledge("#abc123 自己「她自己」\n  想做的事: 學畫畫", asked));
    expect(got.documents).toBe("#abc123 自己「她自己」\n  想做的事: 學畫畫");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContainEqual({ type: "self" });
  });

  it("has no documents when the service has nothing to say, or is not there", async () => {
    expect((await gathered(knowledge("", []))).documents).toBeNull();
    expect((await gathered(null)).documents).toBeNull();
  });
});
