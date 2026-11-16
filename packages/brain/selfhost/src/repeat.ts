// What the old path held back of her own starts, asked of each line of hers on the new runner
// before it goes to the mouth (`MouthOutlet`); a refusal goes back to her as the line's reason:
//
// - A repeat (the Floor's `check` for a `wish`, arbiter/floor.ts): a line of a start of hers that
//   says what she said in that place lately (`DeliveryLedger.saidLately`: `similarLines`, its
//   30-minute window) is not said again.
// - A wish that is done (the Arbiter's `#wish` and `MainTurn.take`, arbiter/arbiter.ts,
//   agent/mainline/main.ts): a line of a start of hers (`wish` or `notable`) about something she
//   wanted to ask one of the people of that place is screened by the wish book (`Wishes.screen`,
//   `sameWish`): answered, told to stop, asked twice, or asked and not yet `followup_hours` ago, it
//   does not go out, with the book's reason.
//
// Lines she owes someone (an answer, a result) and a glance's lines are not checked, as before.

import type { TranscriptEntry } from "@miyoria/memory/transcript";
import {
  type ContextKey,
  DeliveryLedgerKey,
  type FloorClaimKind,
  type Handle,
  WishesKey,
} from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import { floorKind, type OutgoingLine, sayKind, type Wake } from "../../self/src/index.js";
import type { OutletClaims } from "./outlet.js";
import { speakersOf } from "./prompt.js";
import { REPEATED_LINE } from "./texts.js";

/** What the host knows that the outlet's claims need. */
export interface ClaimsHost {
  /** What woke the text run of `turn`; `null`: no text run of the host. */
  wakeOf(turn: string): Wake | null;
  /** The transcript of `place` she sees. */
  entries(place: ContextKey): readonly TranscriptEntry[];
}

/** The outlet's claims (`OutletClaims`) for the text runs of a host. */
export function outletClaims(agent: Agent, host: ClaimsHost): OutletClaims {
  return {
    kind(line: OutgoingLine): FloorClaimKind | null {
      const wake = host.wakeOf(line.turn);
      if (wake === null) return null;
      return line.focus ? floorKind(wake) : sayKind(wake);
    },
    people(place: ContextKey): Handle[] {
      return speakersOf(host.entries(place)).map((s) => agent.handleOf(s.account, s.name));
    },
  };
}

/** A line about to go out, with the Floor claim it makes where it is said. */
export interface CheckedLine {
  place: ContextKey;
  text: string;
  kind: FloorClaimKind;
  /** The people of `place`, whose wishes the line may raise. */
  people: readonly Handle[];
}

/** Why `line` may not go out; `null`: it may. */
export async function lineRefusal(
  agent: Agent,
  line: CheckedLine,
  signal: AbortSignal,
): Promise<string | null> {
  const services = agent.ctx.services;
  if (line.kind === "wish") {
    const said = services.get(DeliveryLedgerKey)?.saidLately(line.text, { context: line.place });
    if (said != null) return REPEATED_LINE;
  }
  if (line.kind !== "wish" && line.kind !== "notable") return null;
  const wishes = services.get(WishesKey);
  if (wishes === undefined) return null;
  for (const person of line.people) {
    const verdict = await wishes.screen({ person, text: line.text, holder: null }, signal);
    signal.throwIfAborted();
    if (!verdict.raise) return verdict.why;
  }
  return null;
}
