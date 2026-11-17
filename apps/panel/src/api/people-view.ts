// The people routes answer `PersonRow` and `PersonProfile` (docs/design/v5-heart.md §2.11). The
// pages written before the redesign read the old shapes (`PersonSummary`, `PersonDetail`,
// `PersonCard`, from `@miyoria/contracts/api`, types only); these functions map the one route's
// answers onto them, so the old pages show true data. Delete with the pages.

import type {
  HeartHistoryEntry,
  PersonCard,
  PersonDetail,
  PersonProfile,
  PersonRow,
  PersonSummary,
  Relationship,
  RelationshipDelta,
} from "@miyoria/contracts/api";

/** What the old pages sent to change a person. */
export interface UpdatePersonInput {
  tags?: string[] | null | undefined;
  /** Her impression of the person. */
  notes?: string | null | undefined;
  call_name?: string | null | undefined;
  blocked?: boolean | null | undefined;
}

/** What the old pages sent to move a bond: added to it. */
export interface AdjustPersonInput {
  affinity: number;
}

/** A page of the list in the old shape. */
export interface PersonSummaryPage {
  items: PersonSummary[];
  next_cursor: string | null;
}

/** The bond's whole numbers, as `affinityLevel` makes them (-100..1000, one per point). */
const level = (bond: number): number => Math.min(Math.max(Math.trunc(bond) + 0, -100), 1000);

function relationshipOf(row: PersonRow): Relationship | null {
  if (!row.has_row) return null;
  return {
    profile: "",
    person: row.person.id,
    affinity: row.bond,
    trust: row.trust,
    familiarity: row.familiarity,
    tags: [...row.tags],
    notes: row.impression,
    call_name: row.call_name,
    interactions: row.interactions,
    last_interaction: row.last_interaction,
    updated_at: row.updated_at ?? row.person.created_at,
  };
}

/** One list row as the old summary. */
export function summaryOf(row: PersonRow): PersonSummary {
  return {
    person: row.person,
    relationship: relationshipOf(row),
    label: row.tier,
    blocked: row.blocked,
  };
}

export function summaryPageOf(page: { items: PersonRow[]; next_cursor: string | null }): PersonSummaryPage {
  return { items: page.items.map(summaryOf), next_cursor: page.next_cursor };
}

/** One list row as the old inner page's card. */
export function cardOf(row: PersonRow): PersonCard {
  return {
    person: row.person.id,
    handle: row.person.display_name,
    call_name: row.call_name,
    affinity: row.bond,
    trust: row.trust,
    familiarity: row.familiarity,
    feeling: row.impression,
    public_feeling: row.public_feeling,
    label: row.tier,
    level: level(row.bond),
    stance: row.stance === "" ? null : row.stance,
    owner: row.owner,
    blocked: row.blocked,
    last_seen: row.last_seen,
    last_together: row.last_together,
    updated_at: row.updated_at ?? row.person.created_at,
  };
}

/** The people with a row, closest first (the old list had only those). */
export function cardsOf(page: { items: PersonRow[] }): PersonCard[] {
  return page.items
    .filter((row) => row.has_row)
    .sort((a, b) => b.bond - a.bond)
    .map(cardOf);
}

/**
 * The levels of the bond, trust and familiarity after each change, oldest first, walking back from
 * the current values: the history the old chart drew. Changes of other numbers are left out.
 */
export function levelsOf(changes: readonly HeartHistoryEntry[], now: PersonRow): RelationshipDelta[] {
  let affinity = now.bond;
  let trust = now.trust;
  let familiarity = now.familiarity;
  const out: RelationshipDelta[] = [];
  for (const change of changes) {
    if (change.field !== "bond" && change.field !== "trust" && change.field !== "familiarity") continue;
    const quote = change.reason_quote.trim();
    out.push({
      at: change.at,
      affinity,
      trust,
      familiarity,
      reason: quote === "" ? change.cause : `${change.cause}: ${quote}`,
    });
    if (change.field === "bond") affinity -= change.delta;
    if (change.field === "trust") trust -= change.delta;
    if (change.field === "familiarity") familiarity -= change.delta;
  }
  return out.reverse();
}

/** The person page's answer as the old detail. */
export function detailOf(profile: PersonProfile): PersonDetail {
  return {
    ...summaryOf(profile),
    history: levelsOf(profile.history.items, profile),
    memory_count: profile.memory_count,
  };
}

/** The old pages' change of a person on the route's body. */
export function updateBodyOf(input: UpdatePersonInput) {
  const { notes, ...rest } = input;
  return { ...rest, ...(notes === undefined ? {} : { impression: notes }) };
}
