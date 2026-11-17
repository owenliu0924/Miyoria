// The shapes the panel's two people lists and its person page were written against, as types only
// (no schema, no route returns them). The routes answer `PersonRow` and `PersonProfile`
// (`people.ts`); the panel's query hooks map those onto these so the pages, which are being
// redesigned, keep reading true data. Delete this file with the old pages.

import type { Person, RelationshipLabel } from "./people.js";

/** How she feels about one person, in the words the pages used. */
export interface Relationship {
  profile: string;
  person: string;
  /** The bond, -100 to 1000. */
  affinity: number;
  trust: number;
  familiarity: number;
  tags: string[];
  /** Her impression of the person. */
  notes: string;
  call_name: string | null;
  interactions: number;
  last_interaction: string | null;
  updated_at: string;
}

/** One change of a relationship; in a history, the levels after it. */
export interface RelationshipDelta {
  at: string;
  affinity: number;
  trust: number;
  familiarity: number;
  reason: string;
}

/** A person in the list: with or without a relationship. */
export interface PersonSummary {
  person: Person;
  relationship: Relationship | null;
  label: RelationshipLabel | null;
  blocked: boolean;
}

/** The summary's fields and her history with them, oldest first. */
export interface PersonDetail extends PersonSummary {
  history: RelationshipDelta[];
  memory_count: number;
}

/** One card per person of the inner page's list. */
export interface PersonCard {
  person: string;
  /** The name she uses for them. */
  handle: string;
  call_name: string | null;
  affinity: number;
  trust: number;
  familiarity: number;
  feeling: string;
  public_feeling?: string | null | undefined;
  label: RelationshipLabel;
  level: number;
  stance?: string | null | undefined;
  owner: boolean;
  blocked: boolean;
  last_seen: string | null;
  last_together: string | null;
  updated_at: string;
}
