// How she feels and what that does to her, read-only (docs/design/v2-architecture.md §3.5, §3.6):
// `GET /api/affect` (the `AffectState` snapshot: strongest emotions, derived mood, drives, the
// bias table "情緒 → 行為" and what she shows) and `GET /api/affect/people` (one card per person
// with a heart row, closest first: phase 4 step 5 made the heart's rows the one place her feeling
// about someone lives). Changes go through the people routes (`/api/people/{id}`).

import type { PersonCard } from "@miyoria/contracts/api";
import {
  BLOCKED_TAG,
  type HeartPerson,
  hasTag,
  OWNER_TAG,
  PeopleDirectoryKey,
} from "@miyoria/heart/person";
import {
  AffectStateKey,
  affinityLevel,
  HandleDirectoryKey,
  relationshipLabel,
  safeName,
} from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { heartRows } from "./heart-rows.js";
import type { ApiState } from "./state.js";

/** One heart row as the panel's card. */
function cardOf(state: ApiState, p: HeartPerson): PersonCard {
  const handle =
    state.optional(HandleDirectoryKey)?.ofPerson(p.person_id) ??
    state.optional(PeopleDirectoryKey)?.displayName(p.person_id) ??
    p.person_id;
  return {
    person: p.person_id,
    handle: safeName(handle),
    call_name: p.call_name,
    affinity: p.bond,
    trust: p.trust,
    familiarity: p.familiarity,
    feeling: p.impression,
    public_feeling: p.public_feeling,
    label: relationshipLabel({ affinity: p.bond, familiarity: p.familiarity }),
    level: affinityLevel(p.bond),
    stance: p.stance === "" ? null : p.stance,
    owner: hasTag(p, OWNER_TAG),
    blocked: hasTag(p, BLOCKED_TAG),
    last_seen: p.last_seen,
    last_together: p.last_together,
    updated_at: p.updated_at,
  };
}

/** Every heart row as a card, closest first. */
function people(state: ApiState): PersonCard[] {
  const heart = heartRows(state);
  if (heart === null) throw ApiError.unavailable("the heart's rows are not available");
  const out: PersonCard[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = heart.list({ offset, limit: 200 });
    for (const e of page.entries) out.push(cardOf(state, e.person));
    offset = page.next;
  }
  return out;
}

/** The affect routes on the route table. */
export const affectRpc = {
  snapshot: os.affect.snapshot.handler(({ context }) =>
    context.state.service(AffectStateKey, "affect module").snapshot(),
  ),
  people: os.affect.people.handler(({ context }) => people(context.state)),
};
