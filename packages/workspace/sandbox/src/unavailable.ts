// `code.unavailable` (tool `code_unavailable`): what she has in place of the code tools while no
// sandbox answers. Withdrawing `code_run` and the rest leaves her nothing that says why, and
// asked to run something she could only guess (or claim she ran it); the reason was only in the
// admin status and the logs. This tool is offered exactly while they are withdrawn, its
// description carries the reason of the last check, and a call checks again.

import { type ActionResult, type Capability, defineCapability } from "@miyoria/gate/actions";
import { z } from "zod";
import type { SandboxHealth } from "./types.js";

export const CODE_UNAVAILABLE = "code.unavailable";

/** Stays under a tool description's room however long the computers' reasons are. */
const MAX_REASON_CHARS = 600;

function clipReason(reason: string): string {
  const chars = [...reason.replace(/\s+/gu, " ").trim()];
  return chars.length > MAX_REASON_CHARS
    ? `${chars.slice(0, MAX_REASON_CHARS).join("")}…`
    : chars.join("");
}

/** The reason of `health` as she is told it, or `null` while there is nothing to tell. */
export function unavailableReason(health: SandboxHealth): string | null {
  if (health.available || health.checked_at === null) return null;
  return clipReason(health.error ?? "原因不明");
}

export interface CodeUnavailableOptions {
  /** The reason at registration (`unavailableReason`). */
  reason: string;
  /** Checks again now (the module's recheck: it also offers the tools when the sandbox is back). */
  recheck(signal: AbortSignal): Promise<SandboxHealth>;
}

export function codeUnavailableCapability(o: CodeUnavailableOptions): Capability<object> {
  return defineCapability<object>({
    name: CODE_UNAVAILABLE,
    summary: "說明現在為什麼不能跑程式",
    risk: "low",
    args: z.object({}),
    permission: null,
    tool: {
      name: "code_unavailable",
      meta: { effect: "read", speed: "instant", group: "code", core: true },
      description:
        `現在不能跑程式:code_run、shell_run 和你寫的工具都收起來了(${o.reason})。` +
        "有人要你跑程式、裝套件或執行指令時,照實跟他說現在沒辦法跑和為什麼,不要說你跑過,也不要自己編出結果;" +
        "工作區的檔案工具照樣能用。呼叫這個工具會再檢查一次現在能不能跑。",
      properties: {},
    },
    async execute(_args, ctx): Promise<ActionResult> {
      const health = await o.recheck(ctx.signal);
      const reason = unavailableReason(health);
      if (reason === null) {
        return {
          text: "現在可以跑程式了:code_run 回到你的工具裡了。",
          data: { available: true },
        };
      }
      return {
        text: `現在還是不能跑程式:${reason}。這次什麼都沒有執行。`,
        data: { available: false, reason },
      };
    },
  });
}
