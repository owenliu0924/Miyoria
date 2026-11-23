// Who may ask her for real work. A work node (`WORK_NODES`: her files, running code, her skills,
// helpers) is held by owners (and whoever an owner gave it to); for everyone else who holds
// `work.bond` (members do), a bond with her at or above `[modules.actions] work_min_bond` counts
// as the node. The bond is only read here: nothing about work ever moves it.

import { WORK_BOND, WORK_NODES } from "@miyoria/commands";
import type { AccountRef, Authorizer, SocialSignals } from "@miyoria/types";

/** What she reads when the person asking does not know her well enough for real work. */
export const WORK_BELOW_BOND =
  "開口的人跟你還沒那麼熟,要動到檔案和程式的事你只幫比較熟的人做,所以這次沒有做。" +
  "用你自己的話好好跟對方說(不用講數字),多聊聊、熟一點再來。";

/** Why `account` may (or may not) ask for something that needs `node`. */
export type Permit =
  /** They hold the node. */
  | "node"
  /** A work node, through their bond. */
  | "bond"
  /** A work node they would get through a bond that is not high enough yet. */
  | "below_bond"
  /** Not theirs. */
  | "no";

export interface PermitSources {
  authorizer: Authorizer | undefined;
  social: SocialSignals | undefined;
  minBond: number;
}

/** Whether `node` is one a bond can stand for. */
export function isWorkNode(node: string): boolean {
  return WORK_NODES.includes(node);
}

/**
 * May `account` ask for what needs `node`? Without an authorizer nobody may; without the heart
 * (`SocialSignals`) or a row there, the bond counts as none.
 */
export function permit(s: PermitSources, account: AccountRef, node: string): Permit {
  const authorizer = s.authorizer;
  if (authorizer === undefined) return "no";
  if (authorizer.allows(account, node)) return "node";
  if (!isWorkNode(node) || !authorizer.allows(account, WORK_BOND)) return "no";
  const attitude = s.social?.attitude(account) ?? null;
  if (attitude?.blocked) return "no";
  return attitude !== null && attitude.affinity >= s.minBond ? "bond" : "below_bond";
}

/** `permit` as a yes or no. */
export function permitted(p: Permit): boolean {
  return p === "node" || p === "bond";
}
