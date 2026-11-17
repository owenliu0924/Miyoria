// Her `<feel>` blocks of a run, applied once the run ended (docs/design/v5-heart.md §2.1, §2.9).
//
// The runner swallowed the blocks and gave them in `RunResult.feel`. Here they are read
// (`parseFeel`), each name is matched to one of the people present in the place the way an `@name`
// is (`nameMatcher`: case, the cleaned name, the handle, a unique first word), and the turn's caps
// are kept (two people, three lines). Blocked people and her own accounts are never among them. Her
// own emotion goes to the emotion engine through the entry Appraise uses (`AffectState.appraise`),
// her proposals to the heart (`HeartPeople.feel`, which writes each change with the turn's id).
// What does not read, names nobody or is over the caps is dropped and counted in a debug line,
// never an error.

import type { TranscriptEntry } from "@miyoria/memory/transcript";
import type { Logger } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type AffectState,
  AffectStateKey,
  type ContextKey,
  type FeelProposal,
  type Handle,
  HeartKey,
  type HeartPeople,
  type IncomingMessage,
  type PersonId,
  sameAccount,
  toTimestamp,
} from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import {
  type FeelLine,
  type FeelSelf,
  limitProposals,
  parseFeel,
  type Wake,
  wakeAuthor,
} from "../../self/src/index.js";
import { nameMatcher } from "./mentions.js";

/** Someone present in the place of a run. */
export interface FeelPerson {
  account: AccountRef;
  name: string;
}

/** What applying needs of the running system (the agent's, in production). */
export interface FeelDeps {
  /** The person behind an account; `null`: nobody she knows. */
  personOf(account: AccountRef): PersonId | null;
  /** Blocked, or one of her own accounts: never a target. */
  excluded(account: AccountRef): boolean;
  handleOf(account: AccountRef, name: string): Handle;
  heart(): HeartPeople | null;
  affect(): AffectState | null;
  log: Pick<Logger, "debug">;
  now(): number;
}

export function feelDeps(agent: Agent): FeelDeps {
  return {
    personOf: (account) => agent.attitude(account)?.person ?? null,
    excluded: (account) => agent.isBlocked(account) || agent.isSelf(account),
    handleOf: (account, name) => agent.handleOf(account, name),
    heart: () => agent.ctx.services.get(HeartKey) ?? null,
    affect: () => agent.ctx.services.get(AffectStateKey) ?? null,
    log: agent.log,
    now: () => agent.ctx.clock.now(),
  };
}

export interface FeelInput {
  turn: string;
  context: ContextKey;
  wake: Wake;
  /** `RunResult.feel`. */
  feel: readonly string[];
  /** The people present: who may be named. */
  people: readonly FeelPerson[];
  /** The line the run answered (`名字: 內容`), for the cause of her emotion; `null`: none. */
  line: string | null;
}

/** One proposal as applied. */
export interface FeelApplied extends FeelProposal {
  person: PersonId;
}

export interface FeelOutcome {
  self: FeelSelf | null;
  /** Whether her emotion went to the engine. */
  felt: boolean;
  proposals: FeelApplied[];
  /** Changes the heart wrote. */
  applied: number;
  /** Lines whose name is nobody present (or more than one). */
  unmatched: number;
  /** Lines that did not read (an unknown value or emotion word, no quote, no shape). */
  unreadable: number;
  /** Lines over the turn's caps. */
  over: number;
}

/** The longest cause of her emotion kept (characters). */
const MAX_CAUSE = 60;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

/** What her emotion of the run is about: the line she answered, else what woke her. */
export function feelCause(wake: Wake, line: string | null, quote: string | null): string {
  if (line !== null && line.trim() !== "") return cut(line, MAX_CAUSE);
  switch (wake.kind) {
    case "world":
      return cut(wake.what, MAX_CAUSE);
    case "timer":
      return cut(wake.note, MAX_CAUSE);
    case "result":
      return cut(`${wake.tool} 的結果`, MAX_CAUSE);
    default:
      return quote === null ? "剛剛的對話" : cut(quote, MAX_CAUSE);
  }
}

/**
 * The line a run answered, as `名字: 內容`: the newest line that called her, or for a glance the
 * newest line of someone else; `null` for a run nobody's line woke.
 */
export function answeredLine(
  wake: Wake,
  inputs: readonly IncomingMessage[],
  entries: readonly TranscriptEntry[],
): string | null {
  const last = inputs.at(-1);
  if (last !== undefined) return `${last.author.display_name}: ${last.text}`;
  if (wake.kind !== "addressed" && wake.kind !== "glance") return null;
  const other = entries.findLast((e) => e.kind === "other" && e.redacted_at === null);
  return other === undefined ? null : `${other.author ?? ""}: ${other.content}`;
}

/** Reads the blocks and matches their names; applies nothing. */
export function readFeel(
  deps: Pick<FeelDeps, "personOf" | "excluded" | "handleOf">,
  feel: readonly string[],
  people: readonly FeelPerson[],
): Omit<FeelOutcome, "felt" | "applied"> {
  let self: FeelSelf | null = null;
  const lines: FeelLine[] = [];
  let unreadable = 0;
  for (const block of feel) {
    const parsed = parseFeel(block);
    if (self === null) self = parsed.self;
    else if (parsed.self !== null) unreadable += 1;
    lines.push(...parsed.lines);
    unreadable += parsed.dropped.length;
  }
  const targets: { name: string; aliases: string[]; key: string }[] = [];
  const seen: AccountRef[] = [];
  for (const p of people) {
    if (seen.some((a) => sameAccount(a, p.account)) || deps.excluded(p.account)) continue;
    seen.push(p.account);
    const person = deps.personOf(p.account);
    if (person === null) continue;
    targets.push({ name: p.name, aliases: [deps.handleOf(p.account, p.name)], key: person });
  }
  const match = nameMatcher(targets);
  const matched: FeelApplied[] = [];
  let unmatched = 0;
  for (const line of lines) {
    const person = match(line.name);
    if (person === null) {
      unmatched += 1;
      continue;
    }
    matched.push({ person, field: line.field, direction: line.direction, quote: line.quote });
  }
  const { kept, over } = limitProposals(matched);
  return { self, proposals: kept, unmatched, unreadable, over };
}

/** Applies her feel blocks of the run of `input.turn`. */
export function applyFeel(deps: FeelDeps, input: FeelInput): FeelOutcome {
  const read = readFeel(deps, input.feel, input.people);
  let felt = false;
  const affect = read.self?.emotion ? deps.affect() : null;
  if (read.self?.emotion && affect !== null) {
    const from = wakeAuthor(input.wake);
    const toward = from === null ? null : deps.handleOf(from.account, from.name);
    affect.appraise({
      source: "feel",
      events: [
        {
          emotion: read.self.emotion,
          strength: read.self.strength,
          toward,
          cause: feelCause(input.wake, input.line, read.proposals[0]?.quote ?? null),
        },
      ],
      context: input.context,
      at: toTimestamp(deps.now()),
    });
    felt = true;
  }
  let applied = 0;
  const heart = read.proposals.length > 0 ? deps.heart() : null;
  if (heart !== null) {
    const byPerson = new Map<PersonId, FeelProposal[]>();
    for (const p of read.proposals) {
      const list = byPerson.get(p.person) ?? [];
      list.push({ field: p.field, direction: p.direction, quote: p.quote });
      byPerson.set(p.person, list);
    }
    for (const [person, proposals] of byPerson) {
      applied += heart.feel(person, proposals, { turn: input.turn, now: deps.now() });
    }
  }
  const outcome: FeelOutcome = { ...read, felt, applied };
  if (input.feel.length > 0) {
    deps.log.debug(
      {
        turn: input.turn,
        emotion: read.self?.emotion ?? null,
        felt,
        proposals: read.proposals.length,
        applied,
        unmatched: read.unmatched,
        unreadable: read.unreadable,
        over: read.over,
      },
      "feel applied",
    );
  }
  return outcome;
}
