// `followup` on a medium-risk tool (docs/design/v6-sandbox.md §10.1): no review, the run goes
// on past the turn, and the answer is the result when it is quick, else "still working" now and
// the result as a notice later.

import type { ToolContext } from "@miyoria/llm/tools";
import { Events, type Notice, Principals, type PublishedEvent } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Capability, type CapabilityTool, defineCapability } from "../src/index.js";
import { RESULT_PENDING, WORK_PENDING } from "../src/tools.js";
import { AMY, CTX, gate } from "./helpers.js";

const notices = (events: readonly PublishedEvent[]) =>
  events.filter((e) => e.type === Events.AgentNotice.type).map((e) => e.data as Notice);

function context(signal = new AbortController().signal): ToolContext {
  return {
    turn: "t1",
    context: CTX,
    account: AMY,
    principal: Principals.self(CTX, AMY),
    message: { context: CTX, id: "m1" },
    priority: "request",
    signal,
  };
}

const Args = z.object({ ms: z.number() });

function longRun(runs: string[]): Capability {
  return defineCapability<z.output<typeof Args>>({
    name: "t.long",
    summary: "a long run",
    risk: "medium",
    args: Args,
    permission: null,
    tool: { name: "t_long", description: "測試。", properties: {}, followup: true },
    async execute(a, ctx) {
      await new Promise((r) => setTimeout(r, a.ms));
      runs.push(`ran ${a.ms} (aborted: ${ctx.signal.aborted})`);
      return `took ${a.ms}`;
    },
  }) as Capability;
}

describe("medium-risk followup tools", () => {
  it("answer_inline_without_a_review_when_quick", async () => {
    const g = await gate();
    const runs: string[] = [];
    g.registry.register(longRun(runs));
    const tool = g.tools.get("t_long") as CapabilityTool;
    expect(await tool.call(context(), { ms: 1, on_own: true })).toBe("took 1");
    expect(runs).toEqual(["ran 1 (aborted: false)"]);
    expect(g.router.requests).toHaveLength(0);
    expect(notices(g.events)).toEqual([]);
  });

  it("say_it_is_still_running_and_tell_the_result_later", async () => {
    const g = await gate();
    g.registry.configure({ ...g.registry.config, inline_wait_ms: 5 });
    const runs: string[] = [];
    g.registry.register(longRun(runs));
    const tool = g.tools.get("t_long") as CapabilityTool;
    const turn = new AbortController();
    const out = await tool.call(context(turn.signal), { ms: 60, on_own: true });
    expect(out).toBe(WORK_PENDING);
    expect(out).not.toBe(RESULT_PENDING);
    // The turn ends; the run goes on.
    turn.abort();
    await vi.waitFor(() => expect(notices(g.events)).toHaveLength(1));
    expect(runs).toEqual(["ran 60 (aborted: false)"]);
    const [n] = notices(g.events);
    expect(n?.ok).toBe(true);
    expect(n?.text).toContain("took 60");
    expect(g.router.requests).toHaveLength(0);
  });
});
