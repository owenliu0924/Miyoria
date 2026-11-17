// `CardFacesKey` (`@miyoria/play/cards`): the words on a card nobody bought, built the way a daily
// card's are (`card.ts`, `member.ts`): what the member page would show them now (her line for them
// passed by moderation and naming nobody else), what she writes for the occasion through the same
// checks (`card-words.ts`), and the card's number among all of theirs. The cards module asks for it
// when a bond enters a new tier (a milestone card), with no session: the person's name is the one
// their first account was last seen with.

import {
  type CardFace,
  type CardFaces,
  type CardOccasion,
  CardsKey,
  cardRelationship,
  type OccasionFace,
} from "@miyoria/play/cards";
import { IdentityStoreKey, MemberCardStoreKey } from "@miyoria/store";
import type { PersonId } from "@miyoria/types";
import { occasionLine, writeCard } from "./card-words.js";
import {
  accountsOf,
  cardView,
  loadMemberOf,
  type MemberContext,
  namesFor,
  shown,
  shownMemories,
} from "./member.js";
import type { ApiState } from "./state.js";

/** Memories she is shown for a card's words, at most. */
const MEMORIES = 5;

/**
 * The face of a card for `who` on `occasion`: her words for it, and the relationship it shows
 * (words only; her line for them only as the page shows it). `name` and `avatar_url` are theirs as
 * the card should print them.
 */
export async function occasionFace(
  state: ApiState,
  who: MemberContext,
  name: string,
  avatar_url: string | null,
  occasion: CardOccasion,
): Promise<OccasionFace> {
  const names = await namesFor(state, who);
  const view = cardView(state, who, names);
  const words =
    view.relationship === null
      ? null
      : await writeCard(
          state,
          {
            name,
            view,
            memories: (await shownMemories(state, who, names))
              .slice(0, MEMORIES)
              .map((m) => m.text),
            poses: [],
            occasion: occasionLine(occasion),
          },
          (text) => shown(state, text, names),
        );
  const person = who.person?.id ?? null;
  const older = await state
    .optional(MemberCardStoreKey)
    ?.countFor(state.profile(), accountsOf(who));
  const mine = person === null ? 0 : (state.optional(CardsKey)?.count(person) ?? 0);
  const face: CardFace = {
    name,
    avatar_url,
    call_name: view.call_name,
    line: words?.line ?? null,
    stamp: words?.stamp ?? null,
    fields: words?.fields ?? [],
    number: (older ?? 0) + mine + 1,
  };
  return {
    face,
    relationship: { ...cardRelationship(who.row), public_feeling: view.public_feeling },
  };
}

/** The faces the cards module asks for, by person. */
export class CardFaceService implements CardFaces {
  constructor(private readonly state: ApiState) {}

  async face(person: PersonId, occasion: CardOccasion): Promise<OccasionFace | null> {
    const { state } = this;
    const identity = state.optional(IdentityStoreKey);
    if (!identity) return null;
    const [first] = await identity.accountsOf(person);
    if (first === undefined) return null;
    const who = await loadMemberOf(state, first.account);
    // Someone she will not say anything about gets no card that would.
    if (who.hidden || who.person?.id !== person) return null;
    return occasionFace(state, who, first.display_name, null, occasion);
  }
}
