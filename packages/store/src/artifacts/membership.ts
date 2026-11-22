// Whether a person belongs to a space, for the `space` audience of a share (v5-architecture §11.2:
// 「這個 Space 的成員」). Written against a space id only, so the rule does not care how a space is
// made: today a space is a Discord guild (identity's `spaces`, one row per guild) and a member is
// an account that wrote there (`space_members`, kept by `Identity.resolve`). When the Space and
// Room tables of phase 6 arrive, this is the one function to change.

import type { PersonId } from "@miyoria/types";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db.js";
import { accounts, spaceMembers } from "../identity/schema.js";

/** Who belongs to which space. */
export type SpaceMembership = (person: PersonId, space: string) => boolean;

/** Whether `person` is a member of `space` through one of their accounts, and has not left. */
export function isSpaceMember(db: Db, person: PersonId, space: string): boolean {
  if (typeof space !== "string" || space === "") return false;
  db.ensureOpen();
  const row = db.orm
    .select({ space_id: spaceMembers.space_id })
    .from(spaceMembers)
    .innerJoin(accounts, eq(accounts.id, spaceMembers.account_id))
    .where(
      and(
        eq(spaceMembers.space_id, space),
        eq(accounts.person_id, person),
        isNull(spaceMembers.left_at),
      ),
    )
    .get();
  return row !== undefined;
}

/** `isSpaceMember` over one database. */
export function spaceMembership(db: Db): SpaceMembership {
  return (person, space) => isSpaceMember(db, person, space);
}
