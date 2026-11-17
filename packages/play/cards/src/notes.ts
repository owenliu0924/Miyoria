// What she hears of the cards (docs/design/v5-play.md §2, §6.3): a card worth a word reaches her
// as a note she may react to, the way the party games tell her about a game (an `Observation` on
// the event log, not silent, in her working context). Only four things are worth one: an SR or
// better card, a card the pity gave, a card with a part they wished for, a series completed. Each
// is one short line, with nothing in it that is not public (the rarity and the pity's length are
// on the odds table; the relationship and her words are not repeated). An ordinary card is not
// told: she would hear of every purchase otherwise.

import { isRare } from "./catalogue.js";
import type { IssuedCard } from "./store.js";

/** The lines a card is worth, in the order above; empty for an ordinary card. */
export function cardNotes(issued: IssuedCard, wishedNames: ReadonlyMap<string, string>): string[] {
  const { card } = issued;
  const who = card.face.call_name ?? card.face.name;
  const lines: string[] = [];
  if (isRare(card.rarity)) {
    const rare = card.parts.filter((p) => isRare(p.rarity)).map((p) => p.name);
    lines.push(
      `${who} 抽到一張 ${card.rarity} 的卡${rare.length > 0 ? `,上面有「${rare.join("」「")}」` : ""}。`,
    );
  }
  if (card.pity_hit) {
    lines.push(`${who} 好久沒抽到 SR 以上,這張是保底給的。`);
  }
  for (const id of card.wished) {
    lines.push(`${who} 抽到了願望單上的「${wishedNames.get(id) ?? id}」。`);
  }
  for (const t of issued.titles) {
    lines.push(`${who} 集滿了一個系列,拿到稱號「${t.title}」。`);
  }
  return lines;
}
