// Whom a call's run is for and who pays for it: what a computer of the cluster takes a job by
// (its owner's `[sandbox] members`) and whose CPU seconds it counts against.

import type { ExecContext } from "@miyoria/gate/actions";
import { WorkQuotaKey } from "@miyoria/types";
import type { WorkspaceScope } from "./people.js";
import type { RunFor, RunRequest } from "./types.js";

/** A person's folder is a member's run; an owner's call reaches everything; else hers. */
export function runFor(scope: WorkspaceScope): RunFor {
  return scope.kind === "person" ? "member" : scope.kind === "all" ? "owner" : "self";
}

/** Whom a run's CPU seconds count against (`WorkQuotaKey`, when it is provided). */
export function payerFor(ctx: ExecContext): RunRequest["payer"] {
  return ctx.services.get(WorkQuotaKey)?.payerOf(ctx.principal) ?? null;
}
