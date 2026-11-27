// The one sentence for someone who has used up their sandbox time (docs/design/v6-sandbox.md
// §8.3): fixed, no model call, said once per stretch (`WorkQuota.claimNotice`). The wait is
// rounded the way the AI quota's line is (`roughWait` and `capMinutes` of the agent module); the
// few lines of that are repeated here because the sandbox does not depend on it.

import type { WorkCap } from "@miyoria/types";

const MINUTE_MS = 60_000;

/** "N 分鐘" up to an hour, then whole hours, rounded up. */
function roughWait(minutes: number): string {
  const m = Math.max(1, Math.ceil(minutes));
  return m <= 60 ? `${m} 分鐘` : `${Math.ceil(m / 60)} 個小時`;
}

/** What she says to someone at their work limit, and what the tool answers instead of starting. */
export function workCapLine(cap: Pick<WorkCap, "which" | "until">, now: number): string {
  const wait = roughWait((cap.until - now) / MINUTE_MS);
  return cap.which === "day"
    ? `你今天找我跑的程式有點多了,大概 ${wait}後再來。`
    : `你這個小時找我跑的程式有點多,大概 ${wait}後再來。`;
}

/** Why a run stopped halfway, when it was the person's time that ran out (`killed_reason: quota`). */
export const WORK_CUT_LINE = "跑到一半停了:那個人這段時間的沙箱時間用完了。";
